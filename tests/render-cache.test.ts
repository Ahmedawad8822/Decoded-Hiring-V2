import assert from "node:assert/strict";
import { test } from "node:test";
import type { CacheEntryType, CacheValue, IncrementalCache } from "@opennextjs/aws/types/overrides";
import { withRenderTimestamp } from "../src/lib/cloudflare/render-cache";
import { withRenderStart } from "../src/lib/cloudflare/render-context";

function fixture() {
  let clock = 100;
  let request = new Map<string, number>();
  const entries = new Map<string, { value: unknown; lastModified: number }>();
  const r2: IncrementalCache = {
    name: "cf-r2-incremental-cache",
    async get<Kind extends CacheEntryType = "cache">(key: string, _kind?: Kind) {
      void _kind;
      const entry = entries.get(key);
      return entry ? structuredClone(entry) as { value: CacheValue<Kind>; lastModified: number } : null;
    },
    async set(key, value) { entries.set(key, { value: structuredClone(value), lastModified: clock }); },
    async delete(key) { entries.delete(key); },
  };
  return {
    r2, entries,
    cache: withRenderTimestamp(r2, () => request, () => clock),
    time(value: number) { clock = value; },
    nextRequest() { request = new Map(); },
  };
}

for (const status of [200, 404]) {
  test(`a late ${status} render stays older than publish expiry, despite a later R2 upload`, async () => {
    const f = fixture();
    const value = { type: "app" as const, html: "Before publish", revalidate: 3600,
      meta: { status, headers: { "x-next-cache-tags": "_N_T_/guides/example" } } };
    await f.cache.get("detail"); // read DB/render starts at 100
    f.time(200); // action commits and expires tags
    const expiresAt = 200;
    f.time(300); // old render uploads only after the action
    await f.cache.set("detail", value);
    assert.equal((await f.r2.get("detail"))?.lastModified, 300);
    f.nextRequest();
    const result = await f.cache.get("detail");
    assert.equal(result?.lastModified, 99);
    assert.ok(expiresAt > result!.lastModified!, "D1 must reject the late write on the very next GET");
    assert.deepEqual(result?.value, value, "status, cache controls and implicit tags survive round-trip");
    // The blocking regeneration starts after expiry and can be served as a HIT.
    await f.cache.set("detail", { ...value, html: "Published", meta: { ...value.meta, status: 200 } });
    f.nextRequest();
    assert.equal((await f.cache.get("detail"))?.lastModified, 299);
  });
}

test("build-populated entries keep their adapter timestamp; fetch values are untouched", async () => {
  const f = fixture();
  await f.r2.set("build", { type: "app", html: "Build snapshot" });
  assert.deepEqual(await f.cache.get("build"), await f.r2.get("build"));
  const fetch = { kind: "FETCH" as const, data: { headers: {}, body: "data", status: 200, url: "https://example.test" } };
  await f.cache.set("fetch", fetch, "fetch");
  assert.deepEqual((await f.r2.get("fetch", "fetch"))?.value, fetch);
  assert.deepEqual(await f.cache.get("fetch", "fetch"), await f.r2.get("fetch", "fetch"));
  assert.equal(f.cache.name, f.r2.name, "populateCache still selects the R2 provider");
  await f.cache.delete("build");
  assert.equal(await f.cache.get("build"), null);
});

test("render clocks belong to each request and key, and writes do not mutate the caller", async () => {
  const f = fixture();
  const value = { type: "app" as const, html: "Page" };
  await f.cache.get("first");
  f.time(150);
  await f.cache.get("second");
  f.time(200);
  await f.cache.set("first", value);
  await f.cache.set("second", value);
  f.nextRequest();
  assert.equal((await f.cache.get("first"))?.lastModified, 99);
  assert.equal((await f.cache.get("second"))?.lastModified, 149);
  assert.deepEqual(value, { type: "app", html: "Page" });
});

test("a render starting in the same millisecond as invalidation remains expired", async () => {
  const f = fixture();
  await f.cache.get("detail");
  const expiresAt = 100;
  f.time(200);
  await f.cache.set("detail", { type: "app", html: "Old snapshot" });
  f.nextRequest();
  assert.ok(expiresAt > (await f.cache.get("detail"))!.lastModified!);
});

test("forced ISR writes without a cache read use this self-fetch's start, not upload time or the stale clock", async () => {
  const f = fixture();
  await withRenderStart(async () => {
    f.time(900); // upload completes well after this self-fetch began
    await f.cache.set("forced-isr", { type: "app", html: "New data", revalidate: 300 });
  }, () => 500);
  f.nextRequest();
  assert.equal((await f.cache.get("forced-isr"))?.lastModified, 499);
  assert.equal((await f.r2.get("forced-isr"))?.lastModified, 900);
  assert.ok(550 > (await f.cache.get("forced-isr"))!.lastModified!, "an overlapping action still expires this background render");
});


test("build-local sitemap snapshots are ignored; runtime route entries retain caching and render timestamps", async () => {
  const f = fixture();
  for (const key of ["/sitemap.xml", `route-cache/APP_ROUTE/${"a".repeat(64)}/$/sitemap.xml`]) {
    const value = { type: "route" as const, body: "<urlset>local DB</urlset>",
      revalidate: 3600, meta: { status: 200, headers: { "x-next-cache-tags": "_N_T_/sitemap.xml" } } };
    await f.r2.set(key, value);
    assert.equal(await f.cache.get(key), null, "never discover deployed content from build-local D1");
    await f.cache.set(key, { ...value, body: "<urlset>deployed DB</urlset>" });
    const entry = await f.cache.get(key);
    assert.equal(entry?.value?.type, "route");
    assert.equal(entry?.lastModified, 99);
    assert.deepEqual(entry?.value, { ...value, body: "<urlset>deployed DB</urlset>" });
    f.time(200); // publish expires the sitemap tag
    assert.ok(200 > entry!.lastModified!);
    f.time(100);
  }
  const robots = { type: "route" as const, body: "User-agent: *" };
  await f.r2.set("/robots.txt", robots);
  assert.deepEqual(await f.cache.get("/robots.txt"), await f.r2.get("/robots.txt"));
});
