import assert from "node:assert/strict";
import { test } from "node:test";
import { baseOrigin, extractPublicUrls, formatSummary, main, prewarm } from "../scripts/prewarm";
import { staticRoutes } from "../src/lib/public-routes";

const base = "https://deploy.example";
const xml = (locs: string[]) => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;

test("extracts published article paths and static routes, rebases canonical hosts, deduplicates and skips previews/private URLs", () => {
  const urls = extractPublicUrls(xml([
    "https://canonical.example/guides/one", "/guides/one", "/field-notes/note-2",
    "/guides/pr&#101;view?preview=true", "/guides/query?a=1&amp;b=2", "/guides/hash#preview",
    "/admin/content", "/preview/guides/one", "/api/auth/sign-out", "/guides/nested/slug",
    "/guides/%2fadmin", "https://user:pass@host/guides/secret", "javascript:alert(1)", "/about",
  ]).replace("</urlset>", "<url><loc>/guides/with-image</loc><image:image><image:loc>https://images.example/photo.jpg</image:loc></image:image></url></urlset>"), base);
  assert.deepEqual(urls, [...staticRoutes.map((route) => new URL(route, base).href), `${base}/guides/one`, `${base}/field-notes/note-2`, `${base}/guides/with-image`]);
  assert.throws(() => extractPublicUrls("<html>error</html>", base), /urlset/);
});

test("requires an explicit credential-free origin and deploy preflight issues zero GETs", async () => {
  for (const url of ["file:///tmp/file", "https://u:p@example.com", `${base}/admin`, `${base}/?preview=true`, `${base}/#x`]) {
    assert.throws(() => baseOrigin(url), /origin/);
  }
  await assert.rejects(main([], {}), /PREWARM_BASE_URL/);
  await assert.rejects(main(["--base-url"], {}), /requires/);
  await assert.rejects(main(["--remote"], {}), /Unknown/);
  await main(["--check", "--base-url", base], {});
});

test("bounds concurrency, consumes bodies, only sends anonymous GETs, and summarises recovered retries and permanent errors", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const attempts = new Map<string, number>();
  const delays: number[] = [];
  const mock: typeof fetch = async (input, init) => {
    calls++;
    const url = String(input);
    assert.equal(new URL(url).origin, base);
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "manual", "redirects cannot escape the target or reach a preview");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("authorization"), null);
    assert.equal(init?.body, undefined);
    const attempt = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, attempt);
    active++;
    maxActive = Math.max(active, maxActive);
    // Keep requests active until their bodies have actually been consumed.
    await new Promise((resolve) => setTimeout(resolve, 1));
    const response = new Response(url.endsWith("/sitemap.xml") ? xml(["/guides/ok", "/guides/retry", "/field-notes/error", "/guides/redirect"]) : "page", {
      status: url.endsWith("/guides/retry") && attempt === 1 ? 503 : url.endsWith("/field-notes/error") ? 404 : url.endsWith("/guides/redirect") ? 302 : 200,
      headers: { "x-opennext-cache": "HIT" },
    });
    const text = response.text.bind(response);
    response.text = async () => { try { return await text(); } finally { active--; } };
    return response;
  };
  const summary = await prewarm({ baseUrl: base, concurrency: 3, retries: 2 }, { fetch: mock, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(maxActive, 3);
  assert.equal(active, 0);
  assert.equal(summary.requests, calls);
  assert.equal(summary.retried, 1);
  assert.equal(summary.failed.length, 2);
  assert.deepEqual(summary.failed.map((r) => r.status).sort(), [302, 404]);
  assert.equal(attempts.get(`${base}/field-notes/error`), 1, "no retry on 404");
  assert.deepEqual(delays, [500]);
  assert.match(formatSummary(summary), /2 failed/);
  assert.match(formatSummary(summary), /100,000\/day/);
  assert.equal(summary.results.find((r) => r.url.endsWith("/guides/retry"))?.cache, "HIT");
});

test("network failures, timeouts and discovery errors are bounded, reported and do not suppress other URLs", async () => {
  const summary = await prewarm({ baseUrl: base, retries: 1, retryDelayMs: 0 }, {
    fetch: async (input) => {
      if (String(input).endsWith("/sitemap.xml")) return new Response("not XML");
      throw new Error("request timed out");
    }, sleep: async () => {},
  });
  assert.equal(summary.failed.length, staticRoutes.length + 2); // discovery + robots
  assert.equal(summary.requests, summary.results.length * 2);
  assert.equal(summary.succeeded, 0);
  assert.match(formatSummary(summary), /urlset/);
  assert.match(formatSummary(summary), /request timed out/);
  await assert.rejects(prewarm({ baseUrl: base, concurrency: 0 }), /concurrency/);
});
