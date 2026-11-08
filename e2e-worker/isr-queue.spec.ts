import { test, expect, type APIRequestContext } from "@playwright/test";
import { WORKER_CONTROL_PATH, WORKER_TEST_TTL } from "../scripts/worker-e2e-control";
import { WORKER_RUNTIME_GUIDE_SLUG, WORKER_RUNTIME_NOTE_SLUG } from "../scripts/worker-e2e-setup";

type Snapshot = { generatedAt?: number; revalidate?: number; uploadedAt: number; isrRequests: number };
function cacheHeader(headers: Record<string, string>) {
  return headers["x-opennext-cache"] ?? headers["x-nextjs-cache"];
}
async function control(request: APIRequestContext, path: string, operation: string, active?: boolean): Promise<Snapshot> {
  const response = await request.post(WORKER_CONTROL_PATH, { data: { path, operation, active } });
  expect(response.status(), await response.text()).toBe(200);
  const snapshot = await response.json();
  await response.dispose();
  return snapshot;
}

for (const path of ["/coaching", "/workshop", "/mission-01", "/ai-recruiter-os",
  `/guides/${WORKER_RUNTIME_GUIDE_SLUG}`, `/field-notes/${WORKER_RUNTIME_NOTE_SLUG}`, "/sitemap.xml", "/robots.txt"]) {
  test(`HTTP time-based ISR serves STALE then new HIT within 20 requests: ${path}`, async ({ request }) => {
    const offer = ["/coaching", "/workshop"].includes(path);
    if (offer) await control(request, path, "offer", true);
    await expect.poll(async () => {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      const status = cacheHeader(response.headers());
      if (offer) expect(await response.text()).not.toContain("Currently unavailable");
      await response.dispose();
      return status;
    }).toBe("HIT");

    const before = await control(request, path, "expire-soon");
    expect(before.revalidate).toBe(WORKER_TEST_TTL);
    if (offer) await control(request, path, "offer", false);
    // The direct D1 change must NOT invalidate this cache entry. We are testing
    // time-based revalidation, independently of revalidatePath's expiry path.
    const stillCached = await request.get(path);
    expect(cacheHeader(stillCached.headers())).toBe("HIT");
    const oldBody = await stillCached.text();
    if (offer) expect(oldBody).not.toContain("Currently unavailable");
    await stillCached.dispose();
    await new Promise(resolve => setTimeout(resolve, WORKER_TEST_TTL * 1000 + 200));

    const stale = await request.get(path);
    expect(stale.status()).toBe(200);
    expect(cacheHeader(stale.headers()), "first expired GET serves the old entry").toBe("STALE");
    expect(await stale.text()).toBe(oldBody);
    await stale.dispose();

    const deadline = Date.now() + 15_000;
    const statuses: string[] = [];
    let freshBody: string | undefined;
    for (let attempt = 0; attempt < 20 && Date.now() < deadline; attempt++) {
      // Leave waitUntil enough time to finish; no aggressive stale-hit loop.
      await new Promise(resolve => setTimeout(resolve, 250));
      const response = await request.get(path);
      const status = cacheHeader(response.headers());
      statuses.push(status);
      const body = await response.text();
      await response.dispose();
      if (status === "HIT" && (!offer || body.includes("Currently unavailable"))) {
        freshBody = body;
        break;
      }
    }
    expect(freshBody, `STALE must become fresh within 15s / 20 polls: ${statuses}`).toBeDefined();
    const after = await control(request, path, "inspect");
    expect(after.generatedAt, "regeneration must stamp a NEW render start").toBeGreaterThan(before.generatedAt!);
    expect(after.revalidate, "real regeneration restores the source lifetime").toBe(path.startsWith("/guides/") || path.startsWith("/field-notes/") || path.endsWith(".xml") || path.endsWith(".txt") ? 3600 : 300);
    expect(after.isrRequests - before.isrRequests, "one queued self-fetch, including any retry").toBe(1);
    // Immediate consecutive hits catch a timestamp that keeps the new entry
    // stale, or a regeneration that only appears fresh for a single request.
    for (let i = 0; i < 2; i++) {
      const response = await request.get(path);
      expect(cacheHeader(response.headers())).toBe("HIT");
      expect(await response.text()).toBe(freshBody);
      await response.dispose();
    }
    console.log(`[ISR] ${path}: STALE -> ${statuses.join(" -> ")}; self-fetches=1`);
    if (offer) await control(request, path, "offer", true);
  });
}
