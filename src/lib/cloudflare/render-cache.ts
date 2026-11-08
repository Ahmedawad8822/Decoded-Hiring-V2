import type { CacheEntryType, CacheValue, IncrementalCache } from "@opennextjs/aws/types/overrides";
import type {} from "@opennextjs/aws/types/global";

const GENERATED_AT = "__dhRenderStartedAt";

/**
 * R2's uploaded timestamp dates the completion of the write, not the data read.
 * A prefetch can read a draft, then upload its 404 AFTER publish invalidates its
 * tags. Keep the render's start time so that late writes remain expired. Both
 * the routing interceptor and Next's cache handler must use this same clock.
 */
export function withRenderTimestamp(
  cache: IncrementalCache,
  requestTimes = () => globalThis.__openNextAls?.getStore()?.requestCache
    .getOrCreate<string, number>("dh:render-start"),
  now = Date.now,
): IncrementalCache {
  return {
    // Keep the adapter identity: populateCache uses it to select R2 population.
    name: cache.name,
    async get<Kind extends CacheEntryType = "cache">(key: string, kind?: Kind) {
      if (kind === undefined || kind === "cache") {
        const times = requestTimes();
        // D1 compares expiry > lastModified. Treat same-millisecond overlap as
        // expired too; an unnecessary miss is safer than resurrecting a draft.
        if (times && !times.has(key)) times.set(key, now() - 1);
      }
      const entry = await cache.get(key, kind);
      if (!entry?.value || (kind !== undefined && kind !== "cache")) return entry;
      const value = entry.value as CacheValue<Kind> & { [GENERATED_AT]?: number };
      const generatedAt = value[GENERATED_AT];
      // The sitemap is prerendered against build-local D1. Never use that
      // snapshot to discover production articles: the first deployed GET must
      // regenerate it from the deployed binding. Runtime entries are stamped.
      // Next 16.4 scopes APP_ROUTE keys as route-cache/APP_ROUTE/<hash>/$<path>.
      const isSitemap = key === "/sitemap.xml" ||
        /^\/?route-cache\/APP_ROUTE\/[0-9a-f]{64}\/\$\/sitemap\.xml$/.test(key);
      if (isSitemap && "type" in value && value.type === "route" &&
          (typeof generatedAt !== "number" || !Number.isFinite(generatedAt))) return null;
      // Build-time populated entries have no render timestamp; retain the
      // adapter's timestamp for those entries, without changing their format.
      if (typeof generatedAt !== "number" || !Number.isFinite(generatedAt)) return entry;
      const original = { ...value };
      delete original[GENERATED_AT];
      return { ...entry, value: original as CacheValue<Kind>, lastModified: generatedAt };
    },
    async set<Kind extends CacheEntryType = "cache">(key: string, value: CacheValue<Kind>, kind?: Kind) {
      if (kind !== undefined && kind !== "cache") return cache.set(key, value, kind);
      const generatedAt = requestTimes()?.get(key) ?? now() - 1;
      const stamped = { ...value, [GENERATED_AT]: generatedAt } as CacheValue<Kind>;
      await cache.set(key, stamped, kind);
    },
    delete: cache.delete.bind(cache),
  };
}
