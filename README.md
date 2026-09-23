<p align="center">
  <a href="https://github.com/Danushka-Madushan/burnlink">
    <img src="favicon.svg" alt="BurnLink Logo" width="80" height="80" />
  </a>
</p>

<h1 align="center">BurnLink</h1>

<p align="center">
  <strong>A rock-solid, zero-dependency, single-use URL shortener built for Deno & Deno Deploy powered by Deno KV.</strong>
</p>

<p align="center">
  <a href="https://deno.land"><img src="https://img.shields.io/badge/Deno-v2.x-black?logo=deno" alt="Deno" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://deno.land"><img src="https://img.shields.io/badge/Dependencies-0-success.svg" alt="Zero Dependencies" /></a>
</p>

<p align="center">
  <em>Share confidential destination URLs via ephemeral links configured to burn immediately upon first access. Built-in immunity against automated bot crawlers and social link unfurlers.</em>
</p>

## ⚡ Features

- **Single-Use Guarantee:** Atomic check-and-set transactions (`kv.atomic()`) prevent race conditions and guarantee links burn exactly once.
- **Bot & Scanner Immunity:** Interstitial confirmation page prevents automated preview/prefetch crawlers from prematurely burning links.
- **Modern White Theme UI:** Clean, authentic enterprise interface (inspired by Linear & Stripe) replacing suspicious ad-shortener aesthetics.
- **Verified Host Preview:** The gateway screen displays the verified destination domain so recipients trust the link before proceeding.
- **React-Hot-Toast Styled Notifications:** Professional toast feedback with spring pop-in animations, dynamic state badges, and clean dismiss transitions.
- **Live Search & Status Filtering:** Instant client-side search by Link ID or destination URL, with status tabs (`All`, `Active`, `Burned`) and an animated toolbar refresh button.
- **Inter Typography & SVG Branding:** Crisp typography via Google Fonts Inter and a custom high-contrast vector favicon (`favicon.svg`).
- **Admin Console:** Built-in dashboard to create, list, copy, search, and delete links with confirmation modals.
- **Access Audit Logs:** Track when links are burned, recording timestamps, visitor User-Agent strings, and IP addresses.
- **Zero External Dependencies:** Built 100% with native Web & Deno standard runtime APIs.
- **Security Hardened:** XSS-immune DOM rendering, protocol validation (`http:` / `https:`), and HTTP Basic Authentication.
- **Full TypeScript Autocomplete:** Native autocomplete and typings configured directly via `deno.json`.

## 📐 Architecture & Logic

BurnLink uses an interstitial click-to-burn pattern rather than trying to maintain fragile User-Agent blocklists:

```
[Link Shared] ──> GET /:id ──> Interstitial Gateway Screen (Link stays active)
                                  │
                                  ▼ Human clicks button
                              POST /:id ──> Atomic KV Claim
                                            ├── First visitor: Burns link & redirects (303)
                                            └── Subsequent visitors: "Link Expired" (410)
```

1. **GET `/:id`:** Automated bots (unfurlers/scanners) and human recipients receive an HTML landing page with OpenGraph tags, verified host preview, and an "Unlock & Proceed" button. **The link is not burned.**
2. **POST `/:id`:** The recipient clicks "Proceed to Destination".
3. **Atomic Burn:** The server executes `kv.atomic().check().set().commit()`. If valid, the link is marked as used with a timestamp and user-agent, then redirected via `303 See Other`. Any concurrent request fails the atomic check and receives a `410 Gone`.



## 🚀 Quick Start (Local Development)

### 1. Prerequisites
- [Deno](https://deno.land/#installation) (v1.40+ or v2.x)
- Any modern code editor (VS Code, Cursor, Zed, Neovim)

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
| `ADMIN_PASS` | Password for `/admin` and API | `secret123` *(change this in production!)* |
| `PORT` | Local HTTP server port | `8000` |

### 4. Run Development Server
```bash
# Start server with file watching
deno task dev
```
Visit `http://localhost:8000/admin` in your browser.



## 💻 Editor Setup & Zero-Config Typings

This repository is 100% self-contained and **does not require a `.vscode/` directory or custom workspace configs**. All settings and unstable KV permissions (`"unstable": ["kv"]`) are defined directly in the root `deno.json`:

- **VS Code / Cursor:** Install the official [Deno extension](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno). It automatically detects `deno.json` at the project root and activates the Deno Language Server (LSP) for seamless autocomplete, type definitions, and in-editor linting.
- **Zed / Neovim / Helix:** Point your editor's built-in LSP to `deno lsp` for native completion and diagnostics.



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



## ☁️ Deployment on Deno Deploy

BurnLink is designed for 1-click zero-config deployment on [Deno Deploy](https://deno.com/deploy).

### Option A: Link GitHub Repository (Recommended)
1. Go to [dash.deno.com](https://dash.deno.com) and create a **New Project**.
2. Under **Deploy from Git**, select your `burnlink` repository.
3. Set the entrypoint to `main.ts`.
4. Under **Settings > Environment Variables**, add:
   - `ADMIN_USER`: Your admin username.
   - `ADMIN_PASS`: A strong admin password.
5. Click **Save** - each push to `main` will automatically deploy!

> [!NOTE]
> **Deno KV Isolation:** Deno Deploy isolates KV databases per project. When creating links in a Git deployment project, those links are saved to that project's provisioned KV store, which is separate from any standalone Playground project.

### Option B: Deno Deploy Playground
1. Create a playground project at [dash.deno.com](https://dash.deno.com).
2. Copy and paste the contents of `main.ts`.
3. Set `ADMIN_USER` and `ADMIN_PASS` in project settings.



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



## 📄 License

This project is open-source and licensed under the [MIT License](LICENSE).
