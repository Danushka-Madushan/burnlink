// main.ts - Single-Use URL Shortener with Bot & Scanner Protection

export interface LinkRecord {
  id: string;
  targetUrl: string;
  createdAt: string;
  used: boolean;
  usedAt: string | null;
  userAgent?: string | null;
  ip?: string | null;
}

export interface CreateLinkPayload {
  targetUrl: string;
}

export interface ApiResponse<T = unknown> {
  success?: boolean;
  error?: string;
  record?: T;
  message?: string;
}

// Open Deno KV connection
export const kv = await Deno.openKv();

export const ADMIN_USER = Deno.env.get("ADMIN_USER") ?? "admin";
export const ADMIN_PASS = Deno.env.get("ADMIN_PASS") ?? "secret123";

if (!Deno.env.get("ADMIN_USER") || !Deno.env.get("ADMIN_PASS")) {
  console.warn(
    "⚠️  [BurnLink Security Warning] ADMIN_USER and/or ADMIN_PASS are not set. Using default credentials ('admin' / 'secret123'). Set these in your environment variables for production security!",
  );
}

// Basic Auth verification - handles passwords with colons safely
export function isAuthenticated(
  req: Request,
  adminUser = ADMIN_USER,
  adminPass = ADMIN_PASS,
): boolean {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(authHeader.split(" ")[1]);
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return false;
    const user = decoded.substring(0, colonIdx);
    const pass = decoded.substring(colonIdx + 1);
    return user === adminUser && pass === adminPass;
  } catch {
    return false;
  }
}

export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="BurnLink Admin Console"' },
  });
}

export function generateId(length = 7): string {
  const chars = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export function isValidUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Static Assets / Special Endpoints
  if (path === "/favicon.ico" || path === "/favicon.svg") {
    const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="burnlink-grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#1d4ed8"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#burnlink-grad)"/><rect x="9" y="14" width="14" height="11" rx="2.5" fill="#ffffff"/><path d="M12 14v-3.5a4 4 0 0 1 8 0V14" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/><circle cx="16" cy="19.5" r="1.5" fill="#1d4ed8"/></svg>`;
    return new Response(faviconSvg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  if (path === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /admin\nDisallow: /api\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // 1. Single-Use Link Handling
  if (path.length > 1 && !path.startsWith("/api") && !path.startsWith("/admin")) {
    const id = path.slice(1).replace(/\/+$/, "");
    if (!id) {
      return renderNotice("Link Not Found", "The requested link path is invalid.", 404);
    }

    const entry = await kv.get<LinkRecord>(["links", id]);

    if (!entry.value) {
      return renderNotice(
        "Link Not Found",
        "This link does not exist, has expired, or was removed.",
        404,
      );
    }

    if (entry.value.used) {
      const accessTime = entry.value.usedAt
        ? new Date(entry.value.usedAt).toLocaleString([], {
          dateStyle: "medium",
          timeStyle: "short",
        })
        : "an unknown time";
      return renderNotice(
        "Link Has Already Burned",
        `This single-use link was configured to self-destruct after one view and was accessed on <strong>${accessTime}</strong>. It can no longer be retrieved.`,
        410,
      );
    }

    // A. GET Request: Drop prefetch requests immediately or show the Unlock page
    if (req.method === "GET") {
      const isPrefetch = req.headers.get("purpose") === "prefetch" ||
        req.headers.get("sec-purpose") === "prefetch" ||
        req.headers.get("x-purpose") === "preview" ||
        req.headers.get("x-moz") === "prefetch";

      if (isPrefetch) {
        // Return 204 No Content so browsers/email clients don't pre-render or follow through
        return new Response(null, { status: 204 });
      }

      // Serve the confirmation screen (Discordbot reads OpenGraph tags; humans see the button)
      return new Response(renderInterstitialHTML(id, entry.value.targetUrl), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // B. POST Request: The human clicked "Unlock & Proceed"
    if (req.method === "POST") {
      const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("cf-connecting-ip") ||
        null;

      const updatedRecord: LinkRecord = {
        ...entry.value,
        used: true,
        usedAt: new Date().toISOString(),
        userAgent: req.headers.get("user-agent") || "Unknown",
        ip: clientIp,
      };

      // Atomic commit: Only one parallel execution can claim it
      const commit = await kv.atomic()
        .check(entry)
        .set(["links", id], updatedRecord)
        .commit();

      if (!commit.ok) {
        return renderNotice(
          "Link Expired",
          "This link was just claimed and consumed by another concurrent request.",
          410,
        );
      }

      // 303 See Other redirects the POST response to a GET at the destination
      return new Response(null, {
        status: 303,
        headers: {
          "Location": entry.value.targetUrl,
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        },
      });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  // 2. Protected Routes (Admin & API)
  if (!isAuthenticated(req)) {
    return unauthorized();
  }

  // API: Create Link
  if (req.method === "POST" && path === "/api/links") {
    try {
      const body = await req.json() as Partial<CreateLinkPayload>;
      let targetUrl = body?.targetUrl?.trim();

      if (!targetUrl) {
        return Response.json(
          { error: "Target URL is required." },
          { status: 400 },
        );
      }

      // Prepend https:// if protocol is omitted
      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        targetUrl = "https://" + targetUrl;
      }

      if (!isValidUrl(targetUrl)) {
        return Response.json(
          { error: "Invalid URL provided. Please provide a valid web address." },
          { status: 400 },
        );
      }

      const id = generateId();
      const record: LinkRecord = {
        id,
        targetUrl,
        createdAt: new Date().toISOString(),
        used: false,
        usedAt: null,
      };

      await kv.set(["links", id], record);
      return Response.json({ success: true, record }, { status: 201 });
    } catch {
      return Response.json({ error: "Invalid JSON request payload." }, { status: 400 });
    }
  }

  // API: List Links
  if (req.method === "GET" && path === "/api/links") {
    const list = kv.list<LinkRecord>({ prefix: ["links"] });
    const records: LinkRecord[] = [];
    for await (const res of list) {
      records.push(res.value);
    }
    records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return Response.json(records);
  }

  // API: Delete Link
  if (req.method === "DELETE" && path.startsWith("/api/links/")) {
    const id = path.slice("/api/links/".length).trim();
    if (!id) {
      return Response.json({ error: "Missing link ID." }, { status: 400 });
    }
    const existing = await kv.get(["links", id]);
    if (!existing.value) {
      return Response.json({ error: "Link not found." }, { status: 404 });
    }
    await kv.delete(["links", id]);
    return Response.json({ success: true, message: "Link deleted successfully." });
  }

  // 3. Admin Dashboard
  if (path === "/" || path === "/admin") {
    return new Response(renderAdminHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return renderNotice("Page Not Found", "The requested page does not exist.", 404);
}

// Start server
Deno.serve(handleRequest);

// ==========================================
// HTML Components (Professional White Theme)
// ==========================================

export function renderInterstitialHTML(id: string, targetUrl?: string): string {
  const safeId = encodeURIComponent(id);

  let hostname = "External Destination";
  if (targetUrl) {
    try {
      hostname = new URL(targetUrl).hostname;
    } catch {
      hostname = "External Destination";
    }
  }
  const safeHostname = escapeHtml(hostname);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BurnLink - Secure Single-Use Gateway</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">

  <!-- Inter Font -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

  <!-- OpenGraph tags for Discord, Slack, iMessage, and social crawlers -->
  <meta property="og:title" content="BurnLink - Single-Use Confidential Link" />
  <meta property="og:description" content="This is an ephemeral link set to self-destruct after one view. Click to proceed securely." />
  <meta property="og:type" content="website" />

  <style>
    :root {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --primary-subtle: #eff6ff;
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      background-color: var(--bg);
      background-image: radial-gradient(circle at 50% 0%, #e0e7ff 0%, #f8fafc 55%);
      color: var(--text);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      max-width: 460px;
      width: 100%;
      background: var(--card-bg);
      border-radius: var(--radius);
      border: 1px solid var(--border);
      padding: 2.25rem 2rem;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 20px 25px -5px rgba(0, 0, 0, 0.04);
      text-align: center;
    }
    .brand-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.3rem 0.75rem;
      background: var(--primary-subtle);
      border: 1px solid #bfdbfe;
      border-radius: 9999px;
      color: var(--primary);
      font-size: 0.8rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      margin-bottom: 1.25rem;
    }
    .brand-badge svg { width: 14px; height: 14px; }
    .icon-wrapper {
      width: 56px;
      height: 56px;
      margin: 0 auto 1.25rem;
      border-radius: 14px;
      background: #eff6ff;
      border: 1px solid #dbeafe;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--primary);
    }
    .icon-wrapper svg { width: 28px; height: 28px; }
    h1 {
      font-size: 1.35rem;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 0.5rem;
      letter-spacing: -0.02em;
    }
    .description {
      color: var(--text-muted);
      font-size: 0.925rem;
      line-height: 1.55;
      margin-bottom: 1.5rem;
    }
    .destination-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 0.85rem 1rem;
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      font-size: 0.85rem;
    }
    .destination-label {
      color: var(--text-muted);
      font-weight: 500;
      white-space: nowrap;
    }
    .destination-value {
      font-weight: 600;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 0.35rem;
      max-width: 250px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .destination-value svg {
      width: 14px;
      height: 14px;
      color: var(--primary);
      flex-shrink: 0;
    }
    .info-list {
      list-style: none;
      text-align: left;
      margin-bottom: 1.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
    }
    .info-item {
      display: flex;
      align-items: flex-start;
      gap: 0.65rem;
      font-size: 0.85rem;
      color: var(--text-muted);
      line-height: 1.45;
    }
    .info-item svg {
      width: 16px;
      height: 16px;
      color: #10b981;
      flex-shrink: 0;
      margin-top: 2px;
    }
    button {
      background: var(--primary);
      color: #ffffff;
      border: none;
      padding: 0.85rem 1.5rem;
      font-size: 0.95rem;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: background 0.15s ease, transform 0.05s ease;
      box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    }
    button:hover { background: var(--primary-hover); }
    button:active { transform: scale(0.99); }
    button:disabled { opacity: 0.7; cursor: not-allowed; }
    .footer {
      margin-top: 1.5rem;
      font-size: 0.75rem;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand-badge">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      BurnLink Ephemeral Gateway
    </div>

    <div class="icon-wrapper">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    </div>

    <h1>Single-Use Confidential Link</h1>
    <p class="description">
      This link is strictly configured to self-destruct once opened. Automated preview bots and security crawlers have been blocked from consuming it.
    </p>

    <div class="destination-box">
      <span class="destination-label">Verified Host</span>
      <span class="destination-value">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        ${safeHostname}
      </span>
    </div>

    <ul class="info-list">
      <li class="info-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        <span>One-time access only - burns upon proceed</span>
      </li>
      <li class="info-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Atomic lock prevents replay attacks or parallel clicks</span>
      </li>
      <li class="info-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Zero permanent records or cookies stored</span>
      </li>
    </ul>

    <form method="POST" action="/${safeId}" onsubmit="this.querySelector('button').disabled=true; this.querySelector('button').textContent='Unlocking destination...';">
      <button type="submit">
        <span>Proceed to Destination</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
      </button>
    </form>

    <div class="footer">
      Protected by BurnLink Edge • Single-Use Security Protocol
    </div>
  </div>
</body>
</html>`;
}

export function renderNotice(title: string, message: string, status: number): Response {
  const safeTitle = escapeHtml(title);

  // Icon and tone based on status
  const isBurned = status === 410;
  const badgeText = isBurned ? "Link Expired & Burned" : `Error ${status}`;
  const badgeBg = isBurned ? "#fef2f2" : "#f1f5f9";
  const badgeBorder = isBurned ? "#fecaca" : "#e2e8f0";
  const badgeColor = isBurned ? "#dc2626" : "#475569";

  const iconSvg = isBurned
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} - BurnLink</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">

  <!-- Inter Font -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f8fafc;
      color: #0f172a;
      padding: 1.5rem;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      max-width: 450px;
      width: 100%;
      padding: 2.25rem 2rem;
      background: #ffffff;
      border-radius: 12px;
      border: 1px solid #e2e8f0;
      text-align: center;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 20px 25px -5px rgba(0,0,0,0.04);
    }
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      background: ${badgeBg};
      border: 1px solid ${badgeBorder};
      color: ${badgeColor};
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-bottom: 1.25rem;
    }
    .icon-box {
      width: 52px;
      height: 52px;
      border-radius: 12px;
      background: ${badgeBg};
      margin: 0 auto 1.25rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .icon-box svg { width: 26px; height: 26px; }
    h1 { font-size: 1.3rem; margin-bottom: 0.65rem; color: #0f172a; font-weight: 700; }
    p { color: #64748b; font-size: 0.925rem; line-height: 1.55; margin-bottom: 1.5rem; }
    .action-link {
      display: inline-block;
      color: #2563eb;
      font-size: 0.875rem;
      font-weight: 600;
      text-decoration: none;
    }
    .action-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <span class="status-badge">${badgeText}</span>
    <div class="icon-box">${iconSvg}</div>
    <h1>${safeTitle}</h1>
    <p>${message}</p>
    <a href="/admin" class="action-link">Open BurnLink Dashboard →</a>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function renderAdminHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BurnLink - Admin Console</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">

  <!-- Inter Font -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --border: #e2e8f0;
      --border-hover: #cbd5e1;
      --text: #0f172a;
      --text-muted: #64748b;
      --text-dim: #94a3b8;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --primary-subtle: #eff6ff;
      --success: #059669;
      --danger: #dc2626;
      --radius: 10px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }

    /* Top Navigation */
    .navbar {
      background: #ffffff;
      border-bottom: 1px solid var(--border);
      padding: 0.85rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .nav-brand {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      font-weight: 700;
      font-size: 1.15rem;
      color: var(--text);
      text-decoration: none;
    }
    .brand-icon {
      width: 32px;
      height: 32px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--primary);
    }
    .brand-icon svg { width: 18px; height: 18px; }
    .badge-console {
      font-size: 0.7rem;
      font-weight: 600;
      background: #f1f5f9;
      color: #475569;
      padding: 0.2rem 0.5rem;
      border-radius: 9999px;
      border: 1px solid #e2e8f0;
    }
    .nav-actions {
      display: flex;
      align-items: center;
      gap: 0.85rem;
    }
    .pill-status {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.75rem;
      color: #059669;
      background: #ecfdf5;
      padding: 0.25rem 0.65rem;
      border-radius: 9999px;
      border: 1px solid #a7f3d0;
      font-weight: 600;
    }
    .pill-dot { width: 6px; height: 6px; background: #059669; border-radius: 50%; }

    /* Main Container */
    .container {
      max-width: 1050px;
      margin: 2rem auto;
      padding: 0 1.5rem;
    }

    /* Metric Cards */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .stat-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.25rem;
      box-shadow: 0 1px 2px 0 rgba(0,0,0,0.03);
    }
    .stat-label {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.03em;
      margin-bottom: 0.4rem;
    }
    .stat-value {
      font-size: 1.6rem;
      font-weight: 700;
      color: var(--text);
    }

    /* Creator Box */
    .create-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 1px 3px 0 rgba(0,0,0,0.03);
    }
    .create-card h2 {
      font-size: 1.05rem;
      font-weight: 600;
      margin-bottom: 0.3rem;
    }
    .create-card p {
      color: var(--text-muted);
      font-size: 0.85rem;
      margin-bottom: 1rem;
    }
    .input-group {
      display: flex;
      gap: 0.75rem;
    }
    .input-wrapper {
      position: relative;
      flex: 1;
      display: flex;
      align-items: center;
    }
    .input-icon {
      position: absolute;
      left: 0.9rem;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-dim);
      pointer-events: none;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2;
    }
    .input-icon svg { width: 17px; height: 17px; }
    input[type="text"] {
      width: 100%;
      padding: 0.75rem 1rem 0.75rem 2.6rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #ffffff;
      color: var(--text);
      font-size: 0.925rem;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
    }
    button.btn-primary {
      background: var(--primary);
      color: #ffffff;
      border: none;
      padding: 0.75rem 1.4rem;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.9rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: background 0.15s ease;
      white-space: nowrap;
    }
    button.btn-primary:hover { background: var(--primary-hover); }
    button.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

    /* New Link Alert Banner */
    .success-callout {
      display: none;
      margin-top: 1rem;
      padding: 1rem;
      background: #ecfdf5;
      border: 1px solid #a7f3d0;
      border-radius: 8px;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .callout-info {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      font-size: 0.875rem;
      color: #065f46;
    }
    .callout-url {
      font-family: monospace;
      font-weight: 700;
      color: #047857;
      background: #d1fae5;
      padding: 0.2rem 0.45rem;
      border-radius: 4px;
    }

    /* Links Table Card */
    .table-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: 0 1px 3px 0 rgba(0,0,0,0.03);
    }
    .table-toolbar {
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .search-box {
      max-width: 280px;
      width: 100%;
    }
    .search-box .input-icon {
      left: 0.8rem;
      top: 50%;
      transform: translateY(-50%);
    }
    .search-box .input-icon svg {
      width: 14px;
      height: 14px;
    }
    .search-box input {
      height: 32px;
      padding: 0.45rem 0.85rem 0.45rem 2.35rem;
      font-size: 0.825rem;
      border-radius: 7px;
    }
    .toolbar-actions {
      display: flex;
      align-items: center;
      gap: 0.65rem;
    }
    .filter-tabs {
      display: flex;
      gap: 0.25rem;
      background: #f1f5f9;
      padding: 0.2rem;
      border-radius: 8px;
      height: 32px;
      align-items: center;
    }
    .tab-btn {
      padding: 0.25rem 0.65rem;
      font-size: 0.75rem;
      font-weight: 600;
      border: none;
      background: transparent;
      color: var(--text-muted);
      border-radius: 6px;
      cursor: pointer;
      height: 26px;
      display: inline-flex;
      align-items: center;
      transition: all 0.15s ease;
    }
    .tab-btn.active {
      background: #ffffff;
      color: var(--text);
      box-shadow: 0 1px 2px 0 rgba(0,0,0,0.06);
    }
    .btn-refresh {
      padding: 0.4rem 0.75rem;
      font-size: 0.8rem;
      font-weight: 500;
      color: var(--text-muted);
      border-radius: 7px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    .btn-refresh svg {
      width: 14px;
      height: 14px;
      transition: transform 0.4s ease;
    }
    .btn-refresh:hover svg {
      transform: rotate(180deg);
    }
    .btn-refresh.spinning svg {
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    th {
      background: #f8fafc;
      color: var(--text-muted);
      font-weight: 600;
      text-align: left;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      font-size: 0.775rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    td {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid #f1f5f9;
      color: var(--text);
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafafa; }

    .short-cell {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .short-cell code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-weight: 600;
      color: var(--primary);
      background: #eff6ff;
      padding: 0.2rem 0.45rem;
      border-radius: 5px;
      border: 1px solid #dbeafe;
      font-size: 0.825rem;
    }
    .url-cell {
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .url-link {
      color: #2563eb;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .url-link:hover { text-decoration: underline; color: #1d4ed8; }
    .url-link svg {
      flex-shrink: 0;
      width: 12px;
      height: 12px;
      color: #94a3b8;
    }

    /* Badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.2rem 0.6rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1;
    }
    .badge-active {
      background: #ecfdf5;
      color: #047857;
      border: 1px solid #a7f3d0;
    }
    .badge-active::before {
      content: "";
      width: 6px;
      height: 6px;
      background: #10b981;
      border-radius: 50%;
    }
    .badge-used {
      background: #f1f5f9;
      color: #64748b;
      border: 1px solid #e2e8f0;
    }
    .badge-used::before {
      content: "";
      width: 6px;
      height: 6px;
      background: #94a3b8;
      border-radius: 50%;
    }

    /* Action Buttons */
    .btn-icon {
      padding: 0.35rem 0.55rem;
      border: 1px solid var(--border);
      background: #ffffff;
      border-radius: 6px;
      cursor: pointer;
      color: var(--text-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.3rem;
      font-size: 0.75rem;
      font-weight: 500;
      transition: all 0.15s ease;
      line-height: 1;
    }
    .btn-icon:hover {
      background: #f8fafc;
      color: var(--text);
      border-color: var(--border-hover);
    }
    .btn-icon svg { width: 13px; height: 13px; }
    .btn-danger {
      padding: 0.4rem;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #94a3b8;
    }
    .btn-danger:hover {
      background: #fef2f2;
      color: #dc2626;
      border-color: #fecaca;
    }

    @media (max-width: 640px) {
      .container { margin: 1rem auto; padding: 0 1rem; }
      .input-group { flex-direction: column; }
      button.btn-primary { justify-content: center; }
      .table-toolbar { flex-direction: column; align-items: stretch; gap: 0.75rem; }
      .search-box { max-width: 100%; }
      .toolbar-actions { justify-content: space-between; }
    }

    /* Empty state */
    .empty-state {
      padding: 3rem 1.5rem;
      text-align: center;
      color: var(--text-muted);
    }
    .empty-icon {
      width: 48px;
      height: 48px;
      margin: 0 auto 0.75rem;
      color: #cbd5e1;
    }
    .empty-state h3 { font-size: 1rem; color: var(--text); margin-bottom: 0.3rem; }
    .empty-state p { font-size: 0.85rem; }

    /* Modal */
    dialog {
      margin: auto;
      border: none;
      border-radius: 12px;
      padding: 1.75rem;
      background: #ffffff;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
      max-width: 400px;
      width: 90%;
    }
    dialog::backdrop {
      background: rgba(15, 23, 42, 0.4);
      backdrop-filter: blur(2px);
    }
    .modal-title { font-size: 1.15rem; font-weight: 700; margin-bottom: 0.5rem; }
    .modal-desc { font-size: 0.9rem; color: var(--text-muted); line-height: 1.5; margin-bottom: 1.5rem; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 0.75rem; }
    .btn-secondary {
      background: #f1f5f9;
      color: var(--text);
      border: 1px solid var(--border);
      padding: 0.6rem 1rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-modal-danger {
      background: #dc2626;
      color: #ffffff;
      border: none;
      padding: 0.6rem 1.1rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-modal-danger:hover { background: #b91c1c; }

    /* React-Hot-Toast Style Notifications */
    #toastContainer {
      position: fixed;
      bottom: 1.25rem;
      right: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
      z-index: 9999;
      pointer-events: none;
    }
    .rht-toast {
      pointer-events: auto;
      background: #ffffff;
      color: #363636;
      padding: 9px 12px;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      line-height: 1.4;
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.1), 0 3px 3px rgba(0, 0, 0, 0.05);
      border: 1px solid rgba(0, 0, 0, 0.04);
      display: flex;
      align-items: center;
      gap: 0.65rem;
      max-width: 380px;
      animation: rht-enter 0.35s cubic-bezier(0.21, 1.02, 0.73, 1) forwards;
    }
    .rht-toast.rht-leave {
      animation: rht-leave 0.3s cubic-bezier(0.06, 0.71, 0.55, 1) forwards;
    }
    .rht-icon {
      position: relative;
      display: flex;
      justify-content: center;
      align-items: center;
      min-width: 20px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      flex-shrink: 0;
      animation: rht-scale 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    .rht-icon svg {
      width: 12px;
      height: 12px;
      color: #ffffff;
    }
    .rht-success {
      background: #61d345;
    }
    .rht-error {
      background: #ff4b4b;
    }
    .rht-message {
      flex: 1;
      word-break: break-word;
    }
    @keyframes rht-enter {
      0% {
        transform: translate3d(0, 20px, 0) scale(0.9);
        opacity: 0;
      }
      100% {
        transform: translate3d(0, 0, 0) scale(1);
        opacity: 1;
      }
    }
    @keyframes rht-leave {
      0% {
        transform: translate3d(0, 0, 0) scale(1);
        opacity: 1;
      }
      100% {
        transform: translate3d(0, 16px, 0) scale(0.85);
        opacity: 0;
      }
    }
    @keyframes rht-scale {
      0% {
        transform: scale(0);
        opacity: 0;
      }
      50% {
        transform: scale(1.25);
      }
      100% {
        transform: scale(1);
        opacity: 1;
      }
    }
  </style>
</head>
<body>

  <!-- Top Navbar -->
  <nav class="navbar">
    <div class="nav-brand">
      <div class="brand-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
      </div>
      <span>BurnLink</span>
      <span class="badge-console">Admin</span>
    </div>
    <div class="nav-actions">
      <span class="pill-status">
        <span class="pill-dot"></span>
        Deno KV Connected
      </span>
    </div>
  </nav>

  <div class="container">

    <!-- Stats Row -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Links</div>
        <div class="stat-value" id="statTotal">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active (Unused)</div>
        <div class="stat-value" style="color: #059669;" id="statActive">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Burned Links</div>
        <div class="stat-value" style="color: #64748b;" id="statBurned">-</div>
      </div>
    </div>

    <!-- Create Card -->
    <div class="create-card">
      <h2>Generate Single-Use Link</h2>
      <p>Enter any destination URL. BurnLink generates a unique, protected link that expires permanently after the first human access.</p>
      
      <form id="linkForm">
        <div class="input-group">
          <div class="input-wrapper">
            <span class="input-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </span>
            <input type="text" id="targetUrl" placeholder="https://example.com/confidential-document-or-vault" required autocomplete="off" />
          </div>
          <button type="submit" class="btn-primary" id="generateBtn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span>Create Link</span>
          </button>
        </div>
      </form>

      <!-- Success Callout for Newly Created Link -->
      <div class="success-callout" id="successCallout">
        <div class="callout-info">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          <div>
            <strong>Link Created:</strong>
            <span class="callout-url" id="calloutUrl"></span>
          </div>
        </div>
        <button type="button" class="btn-icon" id="calloutCopyBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span id="calloutCopyText">Copy</span>
        </button>
      </div>
    </div>

    <!-- Table Card -->
    <div class="table-card">
      <div class="table-toolbar">
        <div class="input-wrapper search-box">
          <span class="input-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </span>
          <input type="text" id="searchInput" placeholder="Search by ID or destination..." />
        </div>
        <div class="toolbar-actions">
          <div class="filter-tabs">
            <button class="tab-btn active" data-filter="all">All</button>
            <button class="tab-btn" data-filter="active">Active</button>
            <button class="tab-btn" data-filter="used">Burned</button>
          </div>
          <button type="button" class="btn-icon btn-refresh" id="refreshBtn" title="Refresh links list">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Short Code</th>
              <th>Destination URL</th>
              <th>Status</th>
              <th>Created</th>
              <th>Accessed / Burned</th>
              <th style="text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody id="tableBody"></tbody>
        </table>
      </div>

      <div class="empty-state" id="emptyState" style="display: none;">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        <h3>No links found</h3>
        <p>No links match your current search or filter criteria.</p>
      </div>
    </div>
  </div>

  <!-- Delete Confirmation Dialog -->
  <dialog id="deleteModal">
    <h3 class="modal-title">Delete Link?</h3>
    <p class="modal-desc">Are you sure you want to permanently delete short link <code id="deleteModalCode" style="font-weight: 700;"></code>? This cannot be undone and will prevent future access.</p>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="cancelDeleteBtn">Cancel</button>
      <button type="button" class="btn-modal-danger" id="confirmDeleteBtn">Delete Link</button>
    </div>
  </dialog>

  <!-- Toast Notification Container -->
  <div id="toastContainer"></div>

  <script>
    let allLinks = [];
    let currentFilter = 'all';
    let currentSearch = '';
    let pendingDeleteId = null;

    function escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    const tableBody = document.getElementById('tableBody');
    const emptyState = document.getElementById('emptyState');
    const deleteModal = document.getElementById('deleteModal');
    const deleteModalCode = document.getElementById('deleteModalCode');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');

    function showToast(message, isError = false) {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'rht-toast';

      const icon = document.createElement('div');
      icon.className = 'rht-icon ' + (isError ? 'rht-error' : 'rht-success');

      if (isError) {
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
      } else {
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      }

      const msg = document.createElement('div');
      msg.className = 'rht-message';
      msg.textContent = message;

      toast.appendChild(icon);
      toast.appendChild(msg);
      container.appendChild(toast);

      setTimeout(() => {
        toast.classList.add('rht-leave');
        setTimeout(() => toast.remove(), 280);
      }, 3000);
    }

    function renderTable() {
      tableBody.innerHTML = '';

      const filtered = allLinks.filter(link => {
        const matchesFilter =
          currentFilter === 'all' ||
          (currentFilter === 'active' && !link.used) ||
          (currentFilter === 'used' && link.used);

        const searchLower = currentSearch.toLowerCase();
        const matchesSearch =
          !currentSearch ||
          link.id.toLowerCase().includes(searchLower) ||
          link.targetUrl.toLowerCase().includes(searchLower);

        return matchesFilter && matchesSearch;
      });

      if (filtered.length === 0) {
        emptyState.style.display = 'block';
        return;
      }
      emptyState.style.display = 'none';

      filtered.forEach(link => {
        const fullShortUrl = window.location.origin + '/' + encodeURIComponent(link.id);
        const tr = document.createElement('tr');

        // Short Code Cell
        const tdId = document.createElement('td');
        const shortDiv = document.createElement('div');
        shortDiv.className = 'short-cell';

        const code = document.createElement('code');
        code.textContent = link.id;

        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn-icon';
        copyBtn.title = 'Copy short link';
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span>';
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(fullShortUrl);
          showToast('Copied ' + fullShortUrl + ' to clipboard!');
        };

        shortDiv.appendChild(code);
        shortDiv.appendChild(copyBtn);
        tdId.appendChild(shortDiv);
        tr.appendChild(tdId);

        // Target URL Cell
        const tdUrl = document.createElement('td');
        tdUrl.className = 'url-cell';
        tdUrl.title = link.targetUrl;
        const a = document.createElement('a');
        a.href = link.targetUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'url-link';
        a.innerHTML = '<span>' + escapeHtml(link.targetUrl) + '</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
        tdUrl.appendChild(a);
        tr.appendChild(tdUrl);

        // Status Badge Cell
        const tdStatus = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = 'badge ' + (link.used ? 'badge-used' : 'badge-active');
        badge.textContent = link.used ? 'Burned' : 'Active';
        tdStatus.appendChild(badge);
        tr.appendChild(tdStatus);

        // Created Cell
        const tdCreated = document.createElement('td');
        tdCreated.style.color = '#64748b';
        tdCreated.textContent = new Date(link.createdAt).toLocaleDateString([], {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        tr.appendChild(tdCreated);

        // Accessed Cell
        const tdAccessed = document.createElement('td');
        if (link.used) {
          tdAccessed.style.color = '#0f172a';
          tdAccessed.textContent = link.usedAt
            ? new Date(link.usedAt).toLocaleDateString([], {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
              })
            : 'Burned';
          if (link.userAgent) {
            tdAccessed.title = 'Client: ' + link.userAgent + (link.ip ? ' (' + link.ip + ')' : '');
          }
        } else {
          tdAccessed.style.color = '#94a3b8';
          tdAccessed.textContent = '-';
        }
        tr.appendChild(tdAccessed);

        // Action Cell
        const tdAction = document.createElement('td');
        tdAction.style.textAlign = 'right';
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-icon btn-danger';
        delBtn.title = 'Delete link';
        delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
        delBtn.onclick = () => openDeleteModal(link.id);
        tdAction.appendChild(delBtn);
        tr.appendChild(tdAction);

        tableBody.appendChild(tr);
      });
    }

    function updateStats() {
      document.getElementById('statTotal').textContent = allLinks.length;
      document.getElementById('statActive').textContent = allLinks.filter(l => !l.used).length;
      document.getElementById('statBurned').textContent = allLinks.filter(l => l.used).length;
    }

    async function loadLinks() {
      try {
        const res = await fetch('/api/links');
        if (!res.ok) {
          if (res.status === 401) {
            showToast('Session expired. Please refresh to log in.', true);
          } else {
            showToast('Failed to load links (HTTP ' + res.status + ').', true);
          }
          return;
        }
        allLinks = await res.json();
        updateStats();
        renderTable();
      } catch (err) {
        console.error('Failed to load links:', err);
        showToast('Failed to load links: ' + (err.message || 'Network error'), true);
      }
    }

    // Create Link Form
    document.getElementById('linkForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('targetUrl');
      const submitBtn = document.getElementById('generateBtn');
      submitBtn.disabled = true;

      try {
        const res = await fetch('/api/links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: input.value })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Failed to create link', true);
        } else {
          input.value = '';
          showToast('Link generated successfully!');

          // Show callout
          const callout = document.getElementById('successCallout');
          const fullUrl = window.location.origin + '/' + data.record.id;
          document.getElementById('calloutUrl').textContent = fullUrl;
          callout.style.display = 'flex';

          document.getElementById('calloutCopyBtn').onclick = () => {
            navigator.clipboard.writeText(fullUrl);
            showToast('Link copied to clipboard!');
          };

          await loadLinks();
        }
      } catch (err) {
        showToast('Network error while creating link.', true);
      } finally {
        submitBtn.disabled = false;
      }
    });

    // Delete Modal
    function openDeleteModal(id) {
      pendingDeleteId = id;
      deleteModalCode.textContent = id;
      deleteModal.showModal();
    }

    cancelDeleteBtn.addEventListener('click', () => {
      deleteModal.close();
      pendingDeleteId = null;
    });

    confirmDeleteBtn.addEventListener('click', async () => {
      if (!pendingDeleteId) return;
      try {
        const res = await fetch('/api/links/' + encodeURIComponent(pendingDeleteId), {
          method: 'DELETE'
        });
        if (res.ok) {
          showToast('Link deleted successfully.');
          deleteModal.close();
          await loadLinks();
        } else {
          showToast('Failed to delete link.', true);
        }
      } catch (err) {
        showToast('Network error.', true);
      } finally {
        pendingDeleteId = null;
      }
    });

    // Filtering & Search
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderTable();
      });
    });

    document.getElementById('searchInput').addEventListener('input', (e) => {
      currentSearch = e.target.value;
      renderTable();
    });

    // Refresh Button
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('spinning');
        refreshBtn.disabled = true;
        try {
          await loadLinks();
          showToast('Links refreshed!');
        } finally {
          setTimeout(() => {
            refreshBtn.classList.remove('spinning');
            refreshBtn.disabled = false;
          }, 400);
        }
      });
    }

    loadLinks();
  </script>
</body>
</html>`;
}
