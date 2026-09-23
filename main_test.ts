import { assertEquals, assertNotEquals } from "@std/assert";
import {
  escapeHtml,
  generateId,
  handleRequest,
  isAuthenticated,
  isValidUrl,
  kv,
  renderInterstitialHTML,
  renderNotice,
} from "./main.ts";

Deno.test("generateId generates unique IDs of correct length", () => {
  const id1 = generateId(7);
  const id2 = generateId(7);
  const id3 = generateId(10);

  assertEquals(id1.length, 7);
  assertEquals(id2.length, 7);
  assertEquals(id3.length, 10);
  assertNotEquals(id1, id2);
  // Ensure only allowed characters are used
  const validCharset = /^[23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ]+$/;
  assertEquals(validCharset.test(id1), true);
});

Deno.test("isValidUrl validates URL schemes correctly", () => {
  // Valid URLs
  assertEquals(isValidUrl("https://example.com"), true);
  assertEquals(isValidUrl("http://localhost:3000/path?query=1"), true);
  assertEquals(isValidUrl("https://github.com/Danushka-Madushan/burnlink"), true);

  // Invalid schemes and strings
  assertEquals(isValidUrl("javascript:alert(1)"), false);
  assertEquals(isValidUrl("ftp://files.example.com"), false);
  assertEquals(isValidUrl("data:text/html,hello"), false);
  assertEquals(isValidUrl("not-a-url"), false);
  assertEquals(isValidUrl(""), false);
});

Deno.test("isAuthenticated verifies basic auth header", () => {
  const user = "testadmin";
  const pass = "testsecret";
  const encoded = btoa(`${user}:${pass}`);

  const validReq = new Request("http://localhost/admin", {
    headers: {
      Authorization: `Basic ${encoded}`,
    },
  });
  assertEquals(isAuthenticated(validReq, user, pass), true);

  // Password containing colons
  const passWithColons = "secret:complex:pass:123";
  const complexReq = new Request("http://localhost/admin", {
    headers: {
      Authorization: `Basic ${btoa(`${user}:${passWithColons}`)}`,
    },
  });
  assertEquals(isAuthenticated(complexReq, user, passWithColons), true);

  // Invalid password
  const invalidPassReq = new Request("http://localhost/admin", {
    headers: {
      Authorization: `Basic ${btoa(`${user}:wrongpass`)}`,
    },
  });
  assertEquals(isAuthenticated(invalidPassReq, user, pass), false);

  // Missing Authorization header
  const noAuthReq = new Request("http://localhost/admin");
  assertEquals(isAuthenticated(noAuthReq, user, pass), false);

  // Non-basic auth header
  const bearerReq = new Request("http://localhost/admin", {
    headers: {
      Authorization: "Bearer token123",
    },
  });
  assertEquals(isAuthenticated(bearerReq, user, pass), false);
});

Deno.test("escapeHtml sanitizes HTML special characters", () => {
  const unsafe = `<script>alert("XSS & attack")</script> 'test'`;
  const safe = escapeHtml(unsafe);

  assertEquals(safe.includes("<script>"), false);
  assertEquals(safe.includes("&lt;script&gt;"), true);
  assertEquals(safe.includes("&amp;"), true);
  assertEquals(safe.includes("&quot;"), true);
  assertEquals(safe.includes("&#039;"), true);
});

Deno.test("renderInterstitialHTML produces expected markup with verified host", () => {
  const id = "abc1234";
  const targetUrl = "https://github.com/Danushka-Madushan/burnlink";
  const html = renderInterstitialHTML(id, targetUrl);

  assertEquals(html.includes("Single-Use Confidential Link"), true);
  assertEquals(html.includes("github.com"), true);
  assertEquals(html.includes('action="/abc1234"'), true);
  assertEquals(html.includes('method="POST"'), true);
});

Deno.test("renderNotice returns proper Response status and content", async () => {
  const res = renderNotice("Test Title", "Test Message", 404);

  assertEquals(res.status, 404);
  assertEquals(res.headers.get("Content-Type"), "text/html; charset=utf-8");
  const body = await res.text();
  assertEquals(body.includes("Test Title"), true);
  assertEquals(body.includes("Test Message"), true);
});

Deno.test("handleRequest serves favicon.ico, favicon.svg, and robots.txt", async () => {
  const icoReq = new Request("http://localhost/favicon.ico");
  const icoRes = await handleRequest(icoReq);
  assertEquals(icoRes.status, 200);
  assertEquals(icoRes.headers.get("Content-Type"), "image/svg+xml");

  const svgReq = new Request("http://localhost/favicon.svg");
  const svgRes = await handleRequest(svgReq);
  assertEquals(svgRes.status, 200);
  assertEquals(svgRes.headers.get("Content-Type"), "image/svg+xml");

  const robotsReq = new Request("http://localhost/robots.txt");
  const robotsRes = await handleRequest(robotsReq);
  assertEquals(robotsRes.status, 200);
  const robotsText = await robotsRes.text();
  assertEquals(robotsText.includes("Disallow: /admin"), true);
});

// Close KV after all tests complete
Deno.test("cleanup: close KV connection", () => {
  kv.close();
});
