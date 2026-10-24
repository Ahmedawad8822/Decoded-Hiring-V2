import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

// R2-backed incremental cache so ISR pages (/guides, /field-notes) and
// revalidatePath() from Studio publish actions work on Cloudflare Workers.
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
});
