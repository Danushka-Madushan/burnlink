# 🔒 BurnLink

A rock-solid, zero-dependency, single-use URL shortener designed for Deno Deploy and Deno KV.

BurnLink allows you to share permanent destination URLs via unique short links that are strictly configured to "burn" (expire) after a single human access.

It includes **built-in protection against automated link unfurlers** (like Discord, Slack, or email security scanners) by requiring a physical click on an interstitial "lock screen" before the redirect occurs. Concurrent clicks are handled atomically to guarantee single-use.

## Features

- **Single-Use Guarantee:** Atomic check-and-set logic prevents race conditions.
- **Bot/Scanner Protection:** Interstitial landing page ensures automated GET requests don't consume the link.
- **Admin Dashboard:** Simple UI to create, delete, and monitor links.
- **Audit Logs:** The Admin UI shows who accessed the link (User-Agent) and when.
- **Zero Dependencies:** Runs entirely on standard Deno APIs.
- **Performance:** Deployed globally on Deno Deploy's edge networks.

## Architecture & Logic

BurnLink uses a reliable "interstitial click-to-burn" pattern rather than attempting to filter bots by User-Agent:

1.  **GET `/:id` (Sharing):** Automated bots (unfurlers/scanners) and human recipients receive an HTML landing page containing OpenGraph tags and an "Unlock" button. **The link is not burned.**
2.  **POST `/:id` (Human Click):** A human clicks the "Unlock" button, issuing a `POST`.
3.  **Atomic Burn:** The server uses `kv.atomic()` to check if the link is unused. If so, it marks it `used` with a timestamp and redirects. Parallel requests fail the atomic check.

## Self-Hosting Deployment

BurnLink is optimized for zero-configuration deployment on Deno Deploy.

### 1. Create Deno Deploy Project

1.  Sign in to [dash.deno.com](https://dash.deno.com).
2.  Create a **New Project**.
3.  Select **Playground** (or link a GitHub repo containing `main.ts`).

### 2. Configure Environment Variables

Under **Settings > Environment Variables** for your project, add the following secure variables:

| Variable | Description | Default (if unset) |
| :--- | :--- | :--- |
| `ADMIN_USER` | Username for the Admin Dashboard | `admin` |
| `ADMIN_PASS` | Password for the Admin Dashboard | `secret123` (CHANGE THIS) |

### 3. Deploy Code

Paste the complete `main.ts` code into the playground editor and click **Save & Deploy**.

Visit `https://your-project.deno.dev/admin` to access the dashboard.

## Development

You can run BurnLink locally during development using the built-in Deno KV:

```bash
deno serve --unstable-kv main.ts
