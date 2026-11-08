// ============================================================================
// PRODUCTION CPU MEASUREMENT HELPER (`npm run perf:cpu:remote`)
// ----------------------------------------------------------------------------
// Crawls the same route set as the local profiler (scripts/cpu-routes.ts)
// against a DEPLOYED Worker (for example https://<name>.<account>.workers.dev)
// N times and, optionally, joins the result with the platform's own CPU data.
//
// It needs NO credentials in the repo and sends only GET requests. It runs
// only when you pass a URL (`--url` or CPU_REMOTE_URL). Signed-in routes are
// measured only if you export a session cookie yourself:
//   CPU_LEARNER_COOKIE='better-auth.session_token=...'
//   CPU_ADMIN_COOKIE='better-auth.session_token=...'
// (copy from a browser session on the deployed site; never commit them).
//
// WHERE THE REAL CPU NUMBERS COME FROM (the client cannot see CPU time):
//   1. `wrangler tail --format json` (needs `wrangler login` on your machine):
//        npx wrangler tail <worker-name> --env production --format json > tail.jsonl
//      The output is consecutive pretty-printed JSON objects (not JSONL). Fields (verified from wrangler's printing code,
//      node_modules/wrangler/wrangler-dist/cli.js "src/tail/printing.ts"):
//        outcome         "ok" | "canceled" | "exceededCpu" | "exceededMemory" | "exception" | "unknown"
//        scriptName, entrypoint, eventTimestamp
//        event.request   { url, method, headers } (+ event.response.status)
//        logs[]          { level, message[] }
//        exceptions[]    { name, message, stack }
//      Wrangler passes the payload through unchanged; its public cli.d.ts has no tail-event type. Do not assume CPU fields are present. `outcome: "exceededCpu"`
//      is exactly "Exceeded CPU Limit" (the dashboard's error 1102). On the
//      Free plan any consistent exceededCpu on a route means it is too heavy.
//      This script correlates events to its requests through the
//      `x-cpu-probe` header it sends and counts outcomes per route.
//   2. Milliseconds of CPU per request:
//        - Workers Logs (dashboard: Workers & Pages > your Worker > Observability >
//          Logs, enable `observability.enabled` in wrangler config): each invocation
//          log carries the CPU time and wall time (shown as cpuTimeMs / wallTimeMs
//          in the Query Builder: filter on the request URL, then group by it).
//        - Dashboard > Worker > Metrics > "CPU Time (ms)" percentiles (p50, p99, p99.9).
//        - A Tail Worker bound with `tail_consumers`: its TraceItem has `cpuTime` and
//          `wallTime` in ms (workers-types: TraceItem.cpuTime / wallTime).
//        - Logpush "Workers Trace Events" dataset: CPUTimeMs / WallTimeMs.
//      Normalize exports to { event: { request: { headers: { "x-cpu-probe": "<id>" } } }, cpuTime: <ms>, wallTime: <ms>, outcome: "ok" }. URL alone cannot correlate repeated requests. CPU may use one
//      of `cpuTime`, `cpuTimeMs`, `CPUTimeMs`, `cpu_time_ms`, pass the file with
//      `--tail-file` and this script reports p50/p95/max CPU per route too.
//
// Usage:
//   npm run perf:cpu:remote -- --url https://decoded-hiring-v2.<acct>.workers.dev \
//        [--runs 20] [--delay 300] [--routes "/,/about"] [--tail-file tail.jsonl] \
//        [--settle 8] [--out result.md] [--allow-host]
//
// Cold vs warm: the platform decides isolate lifetime, so the FIRST request to
// a route after idle (let it sit for several minutes first) is the closest
// thing to a cold sample; later ones are warm. Both are in the output.
// ============================================================================

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { buildRoutes, fmt, mdTable, percentile, summarize, parseCpuTail, type CpuTailRow, type CpuRoute } from "./cpu-routes";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const rawUrl = opt("url") ?? process.env.CPU_REMOTE_URL;
if (!rawUrl) {
  console.error(
    "perf:cpu:remote needs a deployed URL: npm run perf:cpu:remote -- --url https://<name>.<acct>.workers.dev\n(see the header of scripts/measure-workers-cpu.ts for how to read CPU per request from wrangler tail / Workers Logs).",
  );
  process.exit(2);
}
let base: URL;
try { base = new URL(rawUrl); } catch { console.error("Invalid --url"); process.exit(2); }
if (base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
  console.error("Pass an origin URL without credentials, path, query or fragment."); process.exit(2);
}
if (base.protocol !== "https:") {
  console.error("Refusing a non-https URL (this tool is for deployed Workers).");
  process.exit(2);
}
if (!base.hostname.endsWith(".workers.dev") && !flag("allow-host")) {
  console.error(`${base.hostname} is not a *.workers.dev host. Pass --allow-host if you really mean to crawl a custom domain.`);
  process.exit(2);
}

const RUNS = Number(opt("runs") ?? 20);
const DELAY_MS = Number(opt("delay") ?? 300);
const SETTLE_S = Number(opt("settle") ?? 8);
for (const [name, value, minimum] of [["runs", RUNS, 1], ["delay", DELAY_MS, 0], ["settle", SETTLE_S, 0]] as const) {
  if (!Number.isSafeInteger(value) || value < minimum) { console.error(`Invalid --${name}`); process.exit(2); }
}
const TAIL_FILE = opt("tail-file");
const OUT = opt("out");
const ROUTE_FILTER = opt("routes")?.split(",").map((s) => s.trim());
const RUN_ID = crypto.randomBytes(4).toString("hex");
const COOKIES: Record<string, string | undefined> = {
  learner: process.env.CPU_LEARNER_COOKIE,
  admin: process.env.CPU_ADMIN_COOKIE,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Probe = { id: string; routeName: string; path: string; status: number; wallMs: number; cache: string; cfCache: string; err1102: boolean; first: boolean };

async function discover(pathname: string, re: RegExp, cookie?: string): Promise<string | undefined> {
  try {
    const res = await fetch(new URL(pathname, base), { headers: cookie ? { cookie } : {}, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const html = await res.text();
    return html.match(re)?.[1];
  } catch {
    return undefined;
  }
}

async function main() {
  console.log(`[perf:cpu:remote] target ${base.origin}, run id ${RUN_ID}, ${RUNS} requests per route`);

  // Fixture slugs come from the deployed site itself.
  const guideSlug = (await discover("/guides", /href="\/guides\/([a-z0-9-]+)"/)) ?? "unknown-guide";
  const noteSlug = (await discover("/field-notes", /href="\/field-notes\/([a-z0-9-]+)"/)) ?? "unknown-note";
  const courseSlug = COOKIES.learner ? ((await discover("/learn/courses", /href="\/learn\/courses\/([a-z0-9-]+)"/, COOKIES.learner)) ?? "unknown-course") : "unknown-course";
  const lessonSlug = COOKIES.learner ? ((await discover(`/learn/courses/${courseSlug}`, /\/lessons\/([a-z0-9-]+)"/, COOKIES.learner)) ?? "unknown-lesson") : "unknown-lesson";

  let routes: CpuRoute[] = buildRoutes({ guideSlug, fieldNoteSlug: noteSlug, courseSlug, lessonSlug });
  routes = routes.filter((r) => r.auth === "none" || COOKIES[r.auth]);
  if (ROUTE_FILTER) routes = routes.filter((r) => ROUTE_FILTER.some((f) => f === r.path || f === r.name));
  if (!routes.length) throw new Error("No routes matched (check --routes and session cookies)");
  const skipped = buildRoutes().length - routes.length;
  if (skipped > 0 && !ROUTE_FILTER) console.log(`[perf:cpu:remote] ${skipped} signed-in route(s) skipped (set CPU_LEARNER_COOKIE / CPU_ADMIN_COOKIE to include them).`);

  const probes: Probe[] = [];
  let seq = 0;
  for (const route of routes) {
    for (let i = 0; i < RUNS; i++) {
      const id = `${RUN_ID}-${(seq += 1)}`;
      const headers: Record<string, string> = { "x-cpu-probe": id, accept: "text/html,application/xhtml+xml" };
      const cookie = route.auth === "none" ? undefined : COOKIES[route.auth];
      if (cookie) headers.cookie = cookie;
      const t0 = performance.now();
      let status = 0;
      let cache = "";
      let cfCache = "";
      let err1102 = false;
      try {
        const res = await fetch(new URL(route.path, base), { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
        const text = await res.text();
        status = res.status;
        cache = res.headers.get("x-nextjs-cache") ?? "";
        cfCache = res.headers.get("cf-cache-status") ?? "";
        err1102 = /error code: 1102|Error 1102/i.test(text) || (status === 503 && /1102/.test(text));
      } catch {
        status = 0;
      }
      probes.push({ id, routeName: route.name, path: route.path, status, wallMs: performance.now() - t0, cache, cfCache, err1102, first: i === 0 });
      await sleep(DELAY_MS);
    }
    console.log(`[perf:cpu:remote] crawled ${route.name}`);
  }

  // Optional join with exported tail / log data.
  const tail = TAIL_FILE ? await readTail(TAIL_FILE) : null;

  const rows: string[][] = [];
  for (const route of routes) {
    const mine = probes.filter((p) => p.routeName === route.name);
    const wall = summarize(mine.map((p) => p.wallMs));
    const first = mine[0];
    const statuses = [...new Set(mine.map((p) => p.status))].join("/");
    const caches = [...new Set(mine.map((p) => p.cache || p.cfCache || "-"))].join("/");
    const n1102 = mine.filter((p) => p.err1102).length;
    let outcomes = "-";
    let cpuCols = ["-", "-", "-"];
    if (tail) {
      const events = mine.map((p) => tail.byProbe.get(p.id)).filter((e): e is CpuTailRow => !!e);
      outcomes = events.length ? summarizeOutcomes(events) : "no tail events";
      const cpus = events.map((e) => e.cpuMs).filter((v): v is number => v !== undefined);
      if (cpus.length) {
        const sorted = [...cpus].sort((a, b) => a - b);
        cpuCols = [fmt(percentile(sorted, 50)), fmt(percentile(sorted, 95)), fmt(sorted[sorted.length - 1])];
      }
    }
    rows.push([route.name, statuses, fmt(first?.wallMs, 0), fmt(wall.p50, 0), fmt(wall.p95, 0), caches, String(n1102), outcomes, ...cpuCols]);
  }
  const md = [
    `Remote crawl of ${base.origin} on ${new Date().toISOString()} (${RUNS} requests per route, ${DELAY_MS} ms apart, run id ${RUN_ID}).`,
    "Wall times include network latency from this machine; they are NOT CPU time. CPU columns are filled only when `--tail-file` data carries ms CPU.",
    mdTable(["Route", "HTTP", "First wall ms", "p50 wall", "p95 wall", "Cache", "HTTP 1102 seen", "Tail outcomes", "CPU p50 ms", "CPU p95 ms", "CPU max ms"], rows),
  ].join("\n\n");
  console.log("\n" + md);
  if (OUT) fs.writeFileSync(OUT, md + "\n");
  if (!TAIL_FILE) {
    console.log(
      "\nNo --tail-file given. To get CPU outcomes, run this in another terminal BEFORE the crawl:\n  npx wrangler tail <worker-name> --env production --format json > tail.jsonl\nthen pass --tail-file tail.jsonl to the crawl while that SAME tail process is running (see the header of scripts/measure-workers-cpu.ts).",
    );
  }
}

async function readTail(file: string): Promise<{ byProbe: Map<string, CpuTailRow> }> {
  await sleep(SETTLE_S * 1000); // let the concurrent tail flush the final events of THIS crawl
  return { byProbe: parseCpuTail(fs.readFileSync(file, "utf8")) };
}

function summarizeOutcomes(events: CpuTailRow[]): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.outcome ?? "?", (counts.get(e.outcome ?? "?") ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${k} ${v}`).join(", ");
}

main().catch((err) => {
  console.error("[perf:cpu:remote] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
