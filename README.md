# 🔒 BurnLink

[![CI](https://github.com/Danushka-Madushan/burnlink/actions/workflows/ci.yml/badge.svg)](https://github.com/Danushka-Madushan/burnlink/actions/workflows/ci.yml)
[![Deno](https://img.shields.io/badge/Deno-v2.x-black?logo=deno)](https://deno.land)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A rock-solid, zero-dependency, single-use URL shortener built for **Deno** and **Deno Deploy** powered by **Deno KV**.

BurnLink allows you to share destination URLs via unique short links that are strictly configured to "burn" (expire) after a single human access.

It includes **built-in protection against automated link unfurlers** (such as Discord, Slack, iMessage, and email security crawlers) by requiring an explicit human click on an interstitial landing page before the redirect occurs. Concurrent clicks are resolved atomically to guarantee single-use.

---

## ⚡ Features

- **Single-Use Guarantee:** Atomic check-and-set transactions (`kv.atomic()`) prevent race conditions.
- **Bot & Scanner Immunity:** Interstitial confirmation page prevents automated preview/prefetch crawlers from burning links.
- **Admin Dashboard:** Built-in dashboard to create, list, copy, and delete links.
- **Audit Logs:** Track when links are accessed and inspect the visitor's User-Agent string.
- **Zero External Dependencies:** Built using native Web & Deno standard APIs.
- **Security Hardened:** XSS-safe DOM rendering, input scheme validation (`http:` / `https:`), and authentication guard.
- **Full TypeScript & VS Code Support:** Instant typings and autocomplete out of the box.

---

## 📐 Architecture & Logic

BurnLink uses an interstitial click-to-burn pattern rather than trying to maintain fragile User-Agent blocklists:

```
[Link Shared] ──> GET /:id ──> Interstitial "Unlock" Screen (Link stays active)
                                  │
                                  ▼ Human clicks button
                              POST /:id ──> Atomic KV Claim
                                            ├── First visitor: Burns link & redirects (303)
                                            └── Subsequent visitors: "Link Expired" (410)
```

1. **GET `/:id`:** Automated bots (unfurlers/scanners) and human recipients receive an HTML landing page with OpenGraph tags and an "Unlock & Proceed" button. **The link is not burned.**
2. **POST `/:id`:** The recipient clicks "Unlock & Proceed".
3. **Atomic Burn:** The server executes `kv.atomic().check().set().commit()`. If valid, the link is marked as used with a timestamp and user-agent, then redirected. Any concurrent request fails the atomic check.

---

## 🚀 Quick Start (Local Development)

### 1. Prerequisites
- [Deno](https://deno.land/#installation) (v1.40+ or v2.x)
- VS Code with the official [Deno extension](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno) *(recommended)*

### 2. Clone & Setup
```bash
git clone https://github.com/Danushka-Madushan/burnlink.git
cd burnlink
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

| Variable | Description | Default |
| :--- | :--- | :--- |
| `ADMIN_USER` | Username for `/admin` and API | `admin` |
| `ADMIN_PASS` | Password for `/admin` and API | `secret123` *(change this!)* |
| `PORT` | Local HTTP server port | `8000` |

### 4. Run Development Server
```bash
# Start server with file watching
deno task dev
```
Visit `http://localhost:8000/admin` in your browser.

---

## 💻 Editor & Typings (VS Code)

This repository includes pre-configured `.vscode/settings.json` and `.vscode/extensions.json`.

When you open this folder in VS Code:
1. Accept the prompt to install the **Deno** extension (`denoland.vscode-deno`).
2. VS Code will immediately activate the Deno Language Server with full autocomplete and type checking for all `Deno.*` and Deno KV APIs.

---

## 🛠 Available Tasks

Use `deno task <name>` to execute project tasks defined in `deno.json`:

```bash
deno task dev        # Start development server with file watch
deno task start      # Start production server
deno task check      # Type-check TypeScript files
deno task test       # Run automated unit tests
deno task lint       # Lint source code
deno task fmt        # Format code
deno task fmt:check  # Check formatting without modifying files
```

---

## ☁️ Deployment on Deno Deploy

BurnLink is designed for 1-click zero-config deployment on [Deno Deploy](https://deno.com/deploy).

### Option A: Link GitHub Repository (Recommended)
1. Go to [dash.deno.com](https://dash.deno.com) and create a **New Project**.
2. Under **Deploy from Git**, select your `burnlink` repository.
3. Set the entrypoint to `main.ts`.
4. Under **Settings > Environment Variables**, add:
   - `ADMIN_USER`: Your admin username.
   - `ADMIN_PASS`: A strong admin password.
5. Click **Save** — each push to `main` will automatically deploy!

### Option B: Deno Deploy Playground
1. Create a playground project at [dash.deno.com](https://dash.deno.com).
2. Copy and paste the contents of `main.ts`.
3. Set `ADMIN_USER` and `ADMIN_PASS` in project settings.

---

## 📡 API Reference

All `/api/*` endpoints require HTTP Basic Authentication (`Authorization: Basic <base64>`).

### Create a Single-Use Link
```http
POST /api/links
Content-Type: application/json

{
  "targetUrl": "https://example.com/confidential-document"
}
```
**Response (201 Created):**
```json
{
  "success": true,
  "record": {
    "id": "k8X2aBc",
    "targetUrl": "https://example.com/confidential-document",
    "createdAt": "2026-09-23T12:00:00.000Z",
    "used": false,
    "usedAt": null
  }
}
```

### List All Links
```http
GET /api/links
```

### Delete a Link
```http
DELETE /api/links/:id
```

---

## 📄 License

This project is open-source and licensed under the [MIT License](LICENSE).
