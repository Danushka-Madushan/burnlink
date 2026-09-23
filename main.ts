// main.ts - Single-Use URL Shortener with Bot & Scanner Protection

export interface LinkRecord {
  id: string;
  targetUrl: string;
  createdAt: string;
  used: boolean;
  usedAt: string | null;
  userAgent?: string | null;
}

export interface CreateLinkPayload {
  targetUrl: string;
}

export interface ApiResponse<T = unknown> {
  success?: boolean;
  error?: string;
  record?: T;
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

// Basic Auth verification
export function isAuthenticated(
  req: Request,
  adminUser = ADMIN_USER,
  adminPass = ADMIN_PASS,
): boolean {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Basic ")) return false;
  try {
    const [user, pass] = atob(authHeader.split(" ")[1]).split(":");
    return user === adminUser && pass === adminPass;
  } catch {
    return false;
  }
}

export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Admin Panel"' },
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

  // 1. Single-Use Link Handling
  if (path.length > 1 && !path.startsWith("/api") && !path.startsWith("/admin")) {
    const id = path.slice(1);
    const entry = await kv.get<LinkRecord>(["links", id]);

    if (!entry.value) {
      return renderNotice("Link Not Found", "This link does not exist or has been deleted.", 404);
    }

    if (entry.value.used) {
      const accessTime = entry.value.usedAt
        ? new Date(entry.value.usedAt).toLocaleString()
        : "an unknown time";
      return renderNotice(
        "Link Expired",
        `This link was configured for single-use and was already accessed on ${accessTime}.`,
        410,
      );
    }

    // A. GET Request: Drop prefetch requests immediately or show the Unlock page
    if (req.method === "GET") {
      const isPrefetch = req.headers.get("purpose") === "prefetch" ||
        req.headers.get("sec-purpose") === "prefetch" ||
        req.headers.get("x-purpose") === "preview";

      if (isPrefetch) {
        // Return 204 No Content so browsers/email clients don't pre-render or follow through
        return new Response(null, { status: 204 });
      }

      // Serve the confirmation screen (Discordbot reads OpenGraph tags; humans see the button)
      return new Response(renderInterstitialHTML(id), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // B. POST Request: The human clicked "Unlock & Proceed"
    if (req.method === "POST") {
      const updatedRecord: LinkRecord = {
        ...entry.value,
        used: true,
        usedAt: new Date().toISOString(),
        userAgent: req.headers.get("user-agent") || "Unknown",
      };

      // Atomic commit: Only one parallel execution can claim it
      const commit = await kv.atomic()
        .check(entry)
        .set(["links", id], updatedRecord)
        .commit();

      if (!commit.ok) {
        return renderNotice(
          "Link Expired",
          "This link was just consumed by another request.",
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
      const targetUrl = body?.targetUrl?.trim();

      if (!targetUrl || !isValidUrl(targetUrl)) {
        return Response.json(
          { error: "Invalid URL provided. Only http:// and https:// URLs are allowed." },
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
      return Response.json({ error: "Invalid JSON request body." }, { status: 400 });
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
    const id = path.split("/").pop();
    if (id) await kv.delete(["links", id]);
    return Response.json({ success: true });
  }

  // 3. Admin Dashboard
  if (path === "/" || path === "/admin") {
    return new Response(renderAdminHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response("Not Found", { status: 404 });
}

// Start server
Deno.serve(handleRequest);

// HTML Components
export function renderInterstitialHTML(id: string): string {
  const safeId = encodeURIComponent(id);
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Protected Single-Use Link</title>

    <!-- OpenGraph tags for Discord, Slack, and messaging apps -->
    <meta property="og:title" content="🔒 Single-Use Protected Link" />
    <meta property="og:description" content="This link will expire immediately after one access. Click to view destination." />
    <meta property="og:type" content="website" />

    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        margin: 0;
        background: #090d16;
        color: #f8fafc;
      }
      .card {
        max-width: 440px;
        padding: 2.5rem;
        background: #111827;
        border-radius: 12px;
        border: 1px solid #1f2937;
        text-align: center;
        box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);
      }
      .icon { font-size: 2.5rem; margin-bottom: 1rem; }
      h1 { font-size: 1.35rem; margin: 0 0 0.75rem 0; font-weight: 600; }
      p { color: #94a3b8; font-size: 0.9rem; line-height: 1.5; margin: 0 0 1.75rem 0; }
      button {
        background: #3b82f6;
        color: white;
        border: none;
        padding: 0.85rem 1.5rem;
        font-size: 0.95rem;
        font-weight: 600;
        border-radius: 6px;
        cursor: pointer;
        width: 100%;
        transition: background 0.15s ease;
      }
      button:hover { background: #2563eb; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon">🔒</div>
      <h1>Single-Use Link</h1>
      <p>This destination is set to burn after a single view. Once opened, it can never be accessed again.</p>
      <form method="POST" action="/${safeId}">
        <button type="submit">Proceed to Destination →</button>
      </form>
    </div>
  </body>
  </html>`;
}

export function renderNotice(title: string, message: string, status: number): Response {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const html = `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #090d16; color: #f8fafc; }
      .card { max-width: 420px; padding: 2.5rem; background: #111827; border-radius: 12px; border: 1px solid #1f2937; text-align: center; }
      h1 { font-size: 1.4rem; margin-bottom: 0.75rem; color: #f87171; }
      p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin: 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
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
    <title>BurnLink Manager</title>
    <style>
      :root { --bg: #090d16; --card: #111827; --border: #1f2937; --text: #f3f4f6; --text-muted: #9ca3af; --primary: #3b82f6; --primary-hover: #2563eb; }
      * { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem; }
      .container { max-width: 1100px; margin: 0 auto; }
      header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
      h1 { margin: 0; font-size: 1.5rem; }
      .create-box { background: var(--card); border: 1px solid var(--border); padding: 1.5rem; border-radius: 8px; margin-bottom: 2rem; display: flex; gap: 0.75rem; }
      input { flex: 1; padding: 0.75rem 1rem; border-radius: 6px; border: 1px solid var(--border); background: #0b0f19; color: var(--text); font-size: 0.95rem; }
      input:focus { outline: none; border-color: var(--primary); }
      button { background: var(--primary); color: #fff; border: none; padding: 0.75rem 1.25rem; border-radius: 6px; font-weight: 500; cursor: pointer; }
      button:hover { background: var(--primary-hover); }
      button:disabled { opacity: 0.6; cursor: not-allowed; }
      table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
      th, td { padding: 0.85rem 1rem; text-align: left; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
      th { background: #161f30; color: var(--text-muted); font-weight: 600; }
      .badge { display: inline-block; padding: 0.2rem 0.55rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
      .badge-unused { background: #064e3b; color: #34d399; }
      .badge-used { background: #451a1a; color: #f87171; }
      .url-cell { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .copy-btn, .del-btn { padding: 0.35rem 0.6rem; font-size: 0.75rem; margin-left: 0.5rem; }
      .del-btn { background: #7f1d1d; }
      .del-btn:hover { background: #991b1b; }
    </style>
  </head>
  <body>
    <div class="container">
      <header>
        <h1>⚡ Single-Use Links</h1>
        <span style="color: var(--text-muted); font-size: 0.85rem;">One Click & Burn</span>
      </header>
      
      <form class="create-box" id="linkForm">
        <input type="url" id="targetUrl" placeholder="https://destination-url.com/path" required />
        <button type="submit">Generate Link</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Short URL</th>
            <th>Target URL</th>
            <th>Status</th>
            <th>Created</th>
            <th>Accessed</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="tableBody"></tbody>
      </table>
    </div>

    <script>
      async function loadLinks() {
        try {
          const res = await fetch('/api/links');
          if (!res.ok) {
            if (res.status === 401) {
              alert('Session unauthorized or expired. Please reload to log in.');
            }
            return;
          }
          const data = await res.json();
          const tbody = document.getElementById('tableBody');
          tbody.innerHTML = '';
          
          data.forEach(link => {
            const fullShort = window.location.origin + '/' + encodeURIComponent(link.id);
            const tr = document.createElement('tr');

            // ID / Copy
            const tdId = document.createElement('td');
            const code = document.createElement('code');
            code.textContent = link.id;
            const copyBtn = document.createElement('button');
            copyBtn.className = 'copy-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.onclick = () => {
              navigator.clipboard.writeText(fullShort);
              copyBtn.textContent = 'Copied!';
              setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
            };
            tdId.appendChild(code);
            tdId.appendChild(copyBtn);
            tr.appendChild(tdId);

            // Target URL
            const tdUrl = document.createElement('td');
            tdUrl.className = 'url-cell';
            tdUrl.title = link.targetUrl;
            const a = document.createElement('a');
            a.href = link.targetUrl;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.style.color = '#60a5fa';
            a.style.textDecoration = 'none';
            a.textContent = link.targetUrl;
            tdUrl.appendChild(a);
            tr.appendChild(tdUrl);

            // Status
            const tdStatus = document.createElement('td');
            const badge = document.createElement('span');
            badge.className = 'badge ' + (link.used ? 'badge-used' : 'badge-unused');
            badge.textContent = link.used ? 'Used' : 'Active';
            tdStatus.appendChild(badge);
            tr.appendChild(tdStatus);

            // Created
            const tdCreated = document.createElement('td');
            tdCreated.textContent = new Date(link.createdAt).toLocaleDateString();
            tr.appendChild(tdCreated);

            // Accessed
            const tdAccessed = document.createElement('td');
            tdAccessed.textContent = link.usedAt
              ? new Date(link.usedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : '—';
            if (link.userAgent) {
              tdAccessed.title = 'User Agent: ' + link.userAgent;
            }
            tr.appendChild(tdAccessed);

            // Actions
            const tdAction = document.createElement('td');
            const delBtn = document.createElement('button');
            delBtn.className = 'del-btn';
            delBtn.textContent = 'Delete';
            delBtn.onclick = () => deleteLink(link.id);
            tdAction.appendChild(delBtn);
            tr.appendChild(tdAction);

            tbody.appendChild(tr);
          });
        } catch (err) {
          console.error('Failed to load links:', err);
        }
      }

      document.getElementById('linkForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('targetUrl');
        const submitBtn = e.target.querySelector('button[type="submit"]');
        submitBtn.disabled = true;

        try {
          const res = await fetch('/api/links', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUrl: input.value })
          });
          const data = await res.json();
          if (!res.ok) {
            alert(data.error || 'Failed to create link');
          } else {
            input.value = '';
            await loadLinks();
          }
        } catch (err) {
          alert('Network error while creating link');
        } finally {
          submitBtn.disabled = false;
        }
      });

      async function deleteLink(id) {
        if (confirm('Delete this record?')) {
          try {
            await fetch('/api/links/' + encodeURIComponent(id), { method: 'DELETE' });
            await loadLinks();
          } catch (err) {
            alert('Failed to delete link');
          }
        }
      }

      loadLinks();
    </script>
  </body>
  </html>`;
}
