/** Anonymous GET-only cache warming. No Cloudflare APIs, credentials or file writes. */
import { staticRoutes } from "../src/lib/public-routes";

export type PrewarmOptions = {
  baseUrl: string;
  concurrency?: number;
  retries?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
};
type Result = { url: string; attempts: number; status?: number; cache?: string; error?: string };
export type PrewarmSummary = {
  baseUrl: string;
  requests: number;
  succeeded: number;
  retried: number;
  failed: Result[];
  results: Result[];
};
type Dependencies = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };

export function baseOrigin(input: string): string {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Prewarm base URL must be an HTTP(S) origin without credentials, path, query or fragment");
  }
  return url.origin;
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return String.fromCodePoint(code);
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()];
  });
}

/** Read the primary loc in each url (never image/video locs). Target paths are
 * rebased onto the explicit deployment origin: canonical host may be different.
 * Only known public routes are allowed, and all query/preview URLs are skipped.
 */
export function extractPublicUrls(xml: string, baseUrl: string): string[] {
  const origin = baseOrigin(baseUrl);
  if (!/<urlset(?:\s[^>]*)?>[\s\S]*<\/urlset>/.test(xml)) {
    throw new Error("Expected a flat public urlset sitemap");
  }
  const urls = new Set<string>(staticRoutes.map((route) => new URL(route, origin).href));
  for (const entry of xml.matchAll(/<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/g)) {
    const loc = entry[1].match(/<loc>([^<]*)<\/loc>/)?.[1];
    if (!loc) continue;
    let source: URL;
    try { source = new URL(decodeXml(loc.trim()), origin); } catch { continue; }
    if (!/^https?:$/.test(source.protocol) || source.username || source.password || source.search || source.hash) continue;
    const pathname = source.pathname;
    // No encoded separators/dot escapes: only a single public article slug.
    if (staticRoutes.includes(pathname) || /^\/(guides|field-notes)\/[a-zA-Z0-9_-]+$/.test(pathname)) {
      urls.add(new URL(pathname, origin).href);
    }
  }
  return [...urls];
}

function integer(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export async function prewarm(options: PrewarmOptions, deps: Dependencies = {}): Promise<PrewarmSummary> {
  const origin = baseOrigin(options.baseUrl);
  const concurrency = integer("concurrency", options.concurrency ?? 2, 1, 8);
  const retries = integer("retries", options.retries ?? 2, 0, 5);
  const timeout = integer("timeoutMs", options.timeoutMs ?? 30_000, 1, 60_000);
  const delay = integer("retryDelayMs", options.retryDelayMs ?? 500, 0, 10_000);
  const get = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const results: Result[] = [];
  let sitemap = "";
  async function visit(url: string, discovery = false): Promise<Result> {
    const result: Result = { url, attempts: 0 };
    for (let attempt = 0; attempt <= retries; attempt++) {
      result.attempts++;
      let retry = true;
      try {
        const response = await get(url, {
          method: "GET", credentials: "omit", redirect: "manual",
          signal: AbortSignal.timeout(timeout),
          headers: { accept: discovery ? "application/xml" : "text/html", "user-agent": "DecodedHiring-Prewarm/1.0" },
        });
        result.status = response.status;
        result.cache = response.headers.get("x-opennext-cache") ?? response.headers.get("x-nextjs-cache") ?? undefined;
        // Consume the body: do not finish at headers while rendering is pending.
        const body = await response.text();
        if (response.ok) {
          if (discovery) {
            extractPublicUrls(body, origin); // invalid XML is a discovery failure
            sitemap = body;
          }
          delete result.error;
          return result;
        }
        result.error = `HTTP ${response.status}`;
        retry = response.status === 429 || response.status >= 500;
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
      if (!retry || attempt === retries) break;
      await sleep(delay * 2 ** attempt);
    }
    return result;
  }

  results.push(await visit(new URL("/sitemap.xml", origin).href, true));
  // Still warm known static paths if sitemap discovery fails, but report failure.
  const urls = sitemap ? extractPublicUrls(sitemap, origin) : staticRoutes.map((route) => new URL(route, origin).href);
  urls.push(new URL("/robots.txt", origin).href);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      results.push(await visit(url));
    }
  }));
  results.sort((a, b) => a.url.localeCompare(b.url));
  const failed = results.filter((result) => result.error);
  return {
    baseUrl: origin, requests: results.reduce((n, result) => n + result.attempts, 0),
    succeeded: results.length - failed.length,
    retried: results.reduce((n, result) => n + result.attempts - 1, 0), failed, results,
  };
}

export function formatSummary(summary: PrewarmSummary): string {
  return [
    `Prewarm ${summary.baseUrl}: ${summary.succeeded}/${summary.results.length} URLs succeeded; ${summary.failed.length} failed; ${summary.requests} anonymous GET requests (${summary.retried} retries).`,
    ...summary.results.map((r) => `${r.error ? "FAIL" : "OK"} ${r.url} — ${r.error ?? r.status}; attempts=${r.attempts}; cache=${r.cache ?? "unknown"}`),
    "Every attempt counts toward the Workers Free 100,000/day request budget. GETs can populate the server cache; no content mutations are requested.",
  ].join("\n");
}

export async function main(args = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<void> {
  let base = env.PREWARM_BASE_URL;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true;
    else if (args[i] === "--base-url") {
      if (!args[i + 1]) throw new Error("--base-url requires an origin");
      base = args[++i];
    } else if (!args[i].startsWith("-") && !base) base = args[i];
    else throw new Error(`Unknown prewarm argument: ${args[i]}`);
  }
  if (!base) throw new Error("Set PREWARM_BASE_URL or pass --base-url https://deployment.example");
  const origin = baseOrigin(base);
  if (check) { console.log(`Prewarm target validated: ${origin} (no requests sent)`); return; }
  const summary = await prewarm({ baseUrl: origin });
  console.log(formatSummary(summary));
  if (summary.failed.length) process.exitCode = 1;
}

if (/prewarm\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("Prewarm failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
