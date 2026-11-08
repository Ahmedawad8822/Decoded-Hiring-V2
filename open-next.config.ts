import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import d1TagCache from "@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";
import { withRenderTimestamp } from "./src/lib/cloudflare/render-cache.ts";

// R2 persists ISR pages with render timestamps so late uploads cannot undo
// invalidation. D1 persists tag expiration times;
// the default dummy tag cache would make revalidateTag a no-op on Workers.
export default defineCloudflareConfig({
  // Serve cache hits after routing/preview rewrites, bypassing actions and draft
  // mode. The original interception A/B cut public edge CPU p50 to 3–5 ms.
  enableCacheInterception: true,
  incrementalCache: withRenderTimestamp(r2IncrementalCache),
  tagCache: d1TagCache,
  // Time-based ISR needs a real queue; the default dummy throws on every STALE.
  queue: doQueue,
});
