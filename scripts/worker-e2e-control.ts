// Imported ONLY by the throwaway entry generated in worker-e2e-server.ts.
// Neither worker.ts nor the Next app imports this module.
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

interface FixtureEnv {
  DB: D1Database;
  NEXT_INC_CACHE_R2_BUCKET: R2Bucket;
  WORKER_E2E_CONTROL?: string;
}
const isrRequests = new Map<string, number>();
export const WORKER_CONTROL_PATH = "/__worker-e2e/control";
export const WORKER_TEST_TTL = 3;

export function recordRevalidation(request: Request) {
  if (request.headers.get("x-isr") === "1") {
    const path = new URL(request.url).pathname;
    isrRequests.set(path, (isrRequests.get(path) ?? 0) + 1);
  }
}

export async function fixtureControl(request: Request, env: FixtureEnv): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== WORKER_CONTROL_PATH) return;
  if (env.WORKER_E2E_CONTROL !== "local-fixture" || request.method !== "POST") {
    return new Response(null, { status: 404 });
  }
  const input = await request.json() as { path: string; operation: "inspect" | "expire-soon" | "offer"; active?: boolean };
  if (input.operation === "offer") {
    // Deliberately bypass revalidatePath: this test proves the time-based safety
    // net, independently of the Server Action freshness suite.
    if (!["/coaching", "/workshop"].includes(input.path) || typeof input.active !== "boolean") {
      return new Response("Invalid fixture offer", { status: 400 });
    }
    const slug = input.path.slice(1);
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO offers
      (id, kind, title, slug, access_mode, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'FREE', ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET active = excluded.active, updated_at = excluded.updated_at`)
      .bind(`isr-fixture-${slug}`, slug.toUpperCase(), `ISR ${slug}`, slug, Number(input.active), now, now).run();
    return Response.json({ changedAt: now });
  }
  const bucket = env.NEXT_INC_CACHE_R2_BUCKET;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: "incremental-cache/", cursor });
    for (const item of listed.objects) {
      if (!item.key.endsWith(".cache")) continue;
      const object = await bucket.get(item.key);
      if (!object) continue;
      const value = await object.json<{
        type: string; revalidate?: number; __dhRenderStartedAt?: number;
        meta?: { headers?: Record<string, string> };
      }>();
      const tags = value.meta?.headers?.["x-next-cache-tags"]?.split(",") ?? [];
      if (!tags.includes(`_N_T_${input.path}`)) continue;
      if (input.operation === "expire-soon") {
        // Change only this local entry's lifetime/clock. Its body remains the
        // real cached response; the next regeneration restores the source TTL.
        value.revalidate = WORKER_TEST_TTL;
        value.__dhRenderStartedAt = Date.now() - 1;
        await bucket.put(item.key, JSON.stringify(value));
      }
      return Response.json({
        key: item.key, revalidate: value.revalidate,
        generatedAt: value.__dhRenderStartedAt, uploadedAt: object.uploaded.getTime(),
        isrRequests: isrRequests.get(input.path) ?? 0,
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return new Response(`No cache entry for ${input.path}`, { status: 404 });
}
