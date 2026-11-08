# CPU profile (Workers Free, 10 ms per request)

Baseline of the application at `3d81ee7` (current HEAD, based on main), before application performance fixes. Only the profiling tools and this report changed. No deployment or edge measurement was performed; no internet was used.

## Run it

```sh
npm run perf:cpu
# Optional: keep artifacts at a known, git-ignored location
npm run perf:cpu -- --work-dir .cpu-profile
# Reuse that build for a focused comparison; fresh full runs are the baseline method
npm run perf:cpu -- --skip-build --work-dir .cpu-profile --routes /coaching --no-doc
```

Defaults: 30 warm requests per route, a fresh workerd for each cold request, and profiles of the three highest warm medians plus the worst learner and admin pages. `--runs`, `--no-cold`, `--no-hot`, `--hot-top`, `--hot-routes`, `--cold-hot-routes`, `--no-cold-hot`, `--hot-only`, `--routes`, and `--no-doc` allow narrower investigations. Filter by a concrete fixture URL or the exact table label. A partial run updates the table unless `--no-doc` is supplied.

The default artifact directory is a new `dh-cpu-*` OS temporary directory printed at startup. A selected `--work-dir` must be empty or an earlier profiler directory. Artifacts are retained for inspection; delete that directory when finished. They include throwaway D1/R2, minified and readable OpenNext builds, Wrangler logs/config, sanitized `results.json`, Chrome-compatible `.cpuprofile` files, and the exact inspector script sources under `sources/`. Local config contains fixture credentials and state contains sessions: keep the directory private. `.cpu-profile/`, profiles and default remote result/tail names are git-ignored; custom output paths inside the repo must also be ignored. The Markdown report stays tracked.

## Method and interpretation

1. Migrate a new `DH_LOCAL_STATE_DIR`. Seed the fixed demo curriculum, an enrolled learner, an admin, a coaching booking type (60-minute slots, all seven weekdays, 06:00–23:00, Africa/Cairo, 21-day horizon), the baseline guide plus five long guides (8 sections each) and five field notes (4 sections each). Each section has a heading, four paragraphs, a list and a quotation. The workshop offer is absent: `/workshop` measures its fallback, not an active workshop scheduler. Fixture text, counts and request order are fixed; generated IDs/salts and timestamps are not byte-identical. Live scheduling uses the current date, so compare on the same date/timezone/DST window.
2. Run `cf:build` against that state and retain the minified Worker for CPU measurements. Populate the build's incremental R2 cache directly into the throwaway state using OpenNext's `getCacheAssets` / `computeCacheKey` logic. Shared development D1/R2 is never used for cache population. Sign in locally, snapshot the DB/cache with those sessions, and restore it for every cold route (and every fresh profiling instance). This keeps cache misses and session writes from leaking across routes.
3. Start `wrangler dev` on the built Worker, use ephemeral loopback HTTP/inspector ports, disable local observability, and locate the user workerd from its own spawn event. Wrangler's separate HTTP proxy process is excluded. For each route, consume the full response and wait for two low-CPU 8 ms intervals (at most 480 ms) to include immediate `waitUntil` work. Unexpected HTTP statuses or unprofiled requests that never settle fail the run. Delayed background work can still escape this heuristic.
4. Read OS user+system process CPU before/after each request: macOS `proc_pid_rusage` plus Mach timebase conversion through a persistent Python helper; Linux `/proc/<pid>/stat` using `getconf CLK_TCK`. Linux ticks are often 10 ms, so many more repetitions are needed and percentiles near 10 ms are quantized. The empty Worker shows the harness floor; it is not subtracted. Every spawned process group is tracked before readiness checks and terminated on success, failure, SIGINT or SIGTERM. SIGKILL of the profiler itself cannot run cleanup.
5. Rebundle the same Next output with OpenNext `--noMinify` for separate CDP/V8 profiles: three warm-ups and 15 measured requests per warm profile; one request per cold profile. Next's webpack chunks remain optimized/minified, so these names are resolved below by reading the retained script bodies and matching their exact code to source. The raw profile and exact script/line are retained; generated line numbers vary across builds.

**Accuracy limits:** Apple Silicon local workerd CPU is not Cloudflare edge CPU. OS process CPU includes all threads, GC, runtime work and local D1/R2 emulation (which is mostly I/O wait on the hosted platform). It is neither the platform's per-invocation CPU meter nor a strict upper bound. Local workerd does not enforce the Free-plan 10 ms request budget; HTTP 200 is not proof of Free-plan compatibility. Avoid concurrent tests, builds or dev servers when comparing. Repeat full runs on the same machine/tool versions; the p95 is the nearest-rank sample from only 30 observations, so individual spikes are weak evidence.

**The two budgets are separate.** Cloudflare global-scope cold startup has a separate **1 s startup limit**, not the **10 ms per-request CPU limit**. The reported boot counter includes starting the local runtime and evaluating the Worker; it cannot validate the hosted startup limit. The “Cold CPU” column is the first *local request after readiness*, including lazy imports, route initialization, JIT and cache work. It is not a platform cold-start CPU measurement. Global initialization belongs to the startup budget; lazy work actually performed inside a fetch handler may still consume request CPU. “cold over” is a local diagnostic label, not evidence that an edge request fails. Consistent hosted request overruns can produce error 1102; occasional local spikes do not establish that outcome.

The V8 profiler samples wall time. Idle detection is incomplete, and profiling adds overhead. Each sample is capped at 400 us (4 × the requested 100 us interval) to reduce I/O-wait distortion. Hot-table milliseconds and percentages are ranking aids, not additive CPU attribution or a replacement for the OS table. No browser interaction, Server Action mutation, media stream, dense production data set or external provider is exercised here.

## Baseline results

<!-- BEGIN:CPU-PROFILE-RESULTS (generated by npm run perf:cpu; do not edit by hand) -->
Generated 2026-11-08T08:06:22.310Z on darwin arm64, Apple M2 Pro x10, Node v22.23.2.

30 warm requests per route, cold = first request on a freshly started workerd.

CPU = OS user+system CPU of the workerd process around each request (settled for waitUntil work). Budget: 10 ms.

Boot CPU already spent when wrangler reports "Ready" (runtime start + Worker script evaluation, before any request): OpenNext Worker median 323 ms (n=25), empty Worker 91 ms (n=1).

| Route | HTTP | Cold CPU ms | Warm p50 | Warm p95 | Warm max | Warm wall p50 | x-nextjs-cache (cold / warm) | vs 10 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| / | 200 | 313.1 | 7.2 | 12.1 | 14.1 | 12.3 | HIT / HIT 30/30 | p95 over |
| /guides | 200 | 235.2 | 5.8 | 11.0 | 13.8 | 10.2 | HIT / HIT 30/30 | p95 over |
| /guides/[slug] | 200 | 398.7 | 7.1 | 12.8 | 13.3 | 11.7 | MISS / HIT 30/30 | p95 over |
| /field-notes | 200 | 215.9 | 6.3 | 12.7 | 14.8 | 15.8 | HIT / HIT 30/30 | p95 over |
| /field-notes/[slug] | 200 | 391.3 | 7.0 | 14.8 | 16.1 | 14.6 | MISS / HIT 30/30 | p95 over |
| /contact | 200 | 220.2 | 5.3 | 12.3 | 12.5 | 9.6 | HIT / HIT 30/30 | p95 over |
| /coaching | 200 | 443.1 | 93.1 | 119.8 | 145.5 | 116.7 | - / - 30/30 | OVER |
| /workshop | 200 | 353.3 | 21.3 | 49.3 | 66.5 | 50.7 | - / - 30/30 | OVER |
| /mission-01 | 200 | 434.1 | 10.3 | 15.7 | 21.1 | 22.7 | HIT / HIT 30/30 | OVER |
| /ai-recruiter-os | 200 | 227.4 | 5.1 | 10.4 | 13.6 | 10.2 | HIT / HIT 30/30 | p95 over |
| /about | 200 | 223.3 | 6.0 | 15.5 | 16.3 | 9.9 | HIT / HIT 30/30 | p95 over |
| /sitemap.xml | 200 | 263.5 | 8.9 | 13.9 | 14.5 | 11.4 | - / - 30/30 | p95 over |
| /admin/login | 200 | 274.2 | 11.6 | 23.8 | 23.9 | 25.3 | - / - 30/30 | OVER |
| /learn (learner) | 200 | 342.2 | 17.0 | 30.9 | 38.6 | 30.8 | - / - 30/30 | OVER |
| /learn/courses (learner) | 200 | 382.6 | 21.1 | 38.1 | 44.5 | 39.4 | - / - 30/30 | OVER |
| /learn/courses/[slug] (learner) | 200 | 361.1 | 23.3 | 35.9 | 52.1 | 38.3 | - / - 30/30 | OVER |
| lesson page (learner) | 200 | 414.1 | 23.6 | 44.6 | 46.7 | 42.0 | - / - 30/30 | OVER |
| /admin/content (admin) | 200 | 424.6 | 18.6 | 31.6 | 41.6 | 32.9 | - / - 30/30 | OVER |
| /admin/courses (admin) | 200 | 388.8 | 18.8 | 40.4 | 41.1 | 32.9 | - / - 30/30 | OVER |
| /admin/leads (admin) | 200 | 357.2 | 15.9 | 36.6 | 44.4 | 31.8 | - / - 30/30 | OVER |
| /admin/commerce (admin) | 200 | 423.8 | 37.1 | 56.1 | 64.7 | 54.4 | - / - 30/30 | OVER |
| /admin/editorial (admin) | 200 | 661.5 | 23.9 | 43.2 | 48.6 | 48.4 | - / - 30/30 | OVER |
| GET /api/auth/get-session (learner) | 200 | 321.8 | 9.4 | 16.2 | 16.7 | 13.8 | - / - 30/30 | p95 over |
| POST /api/auth/sign-in/email | 200 | 430.6 | 73.6 | 87.5 | 87.5 | 124.2 | - / - 30/30 | OVER |
| (floor) empty Worker, same harness | 200 | 4.0 | 1.0 | 1.5 | 2.8 | 9.0 | - | ok |

### Hot functions (unminified build, V8 sampling profiler)

V8 samples at 100 us but fires on wall time, so each sample is weighted at most 400 us (self time ~ sample count). Profiling overhead inflates absolute ms: use it for RANKING; `%` is the share of non-idle samples and `ms/req` is that share applied to the profiled non-idle total.

#### /coaching (92.6 ms non-idle per request while profiled)

| Function - module:line | self ms/req | % |
| --- | ---: | ---: |
| (anonymous) - app:chunks/5667.js:102811 `(a9, b6) {` | 46.45 | 50.2 |
| (anonymous) - app:chunks/5667.js:102834 `(a10, b7) {` | 8.58 | 9.3 |
| (anonymous) - app:chunks/5667.js:102805 `(a8, b6) {` | 8.42 | 9.1 |
| (anonymous) - app:chunks/5667.js:102686 `(a3, b3) {` | 2.83 | 3.1 |
| t - app:chunks/5667.js:102680 `(a2, b2) {` | 2.48 | 2.7 |
| (garbage collector) - (garbage collector):0 | 1.39 | 1.5 |
| (anonymous) - app:chunks/5667.js:102792 `(a5, b5) {` | 0.94 | 1.0 |
| (program) - (program):0 | 0.83 | 0.9 |
| (anonymous) - app:chunks/5667.js:102784 `(a3) {` | 0.79 | 0.9 |
| (anonymous) - app:chunks/828.js:113004 `(a4, b3) {` | 0.68 | 0.7 |
| (anonymous) - app:chunks/5667.js:102804 `(a7, b5, c5) {` | 0.46 | 0.5 |
| Date1 - next/dist/server:15670 | 0.45 | 0.5 |

| Module / package | self ms/req | % |
| --- | ---: | ---: |
| app:chunks/5667.js | 71.93 | 77.7 |
| next/dist/compiled/next-server | 6.06 | 6.5 |
| (runtime / native) | 2.72 | 2.9 |
| app:chunks/828.js | 2.67 | 2.9 |
| (garbage collector) | 1.39 | 1.5 |
| next/dist/server | 1.16 | 1.2 |
| (unknown module) | 0.88 | 0.9 |
| (program) | 0.83 | 0.9 |

#### POST /api/auth/sign-in/email (85.9 ms non-idle per request while profiled)

| Function - module:line | self ms/req | % |
| --- | ---: | ---: |
| getScrypt - :0 | 73.28 | 85.3 |
| (program) - (program):0 | 1.01 | 1.2 |
| (garbage collector) - (garbage collector):0 | 0.76 | 0.9 |
| toJson - (unknown module):616 | 0.35 | 0.4 |
| fetch - :0 | 0.30 | 0.3 |
| e - app:chunks/828.js:111077 `(a2, b2) {` | 0.24 | 0.3 |
| (anonymous) - :0 | 0.22 | 0.3 |
| __name - (unknown module):3 | 0.19 | 0.2 |
| URL - :0 | 0.17 | 0.2 |
| (anonymous) - app:chunks/828.js:113004 `(a4, b3) {` | 0.16 | 0.2 |
| (anonymous) - app:chunks/828.js:113055 `(a3, { path: j3, field: k2 }, l3) => {` | 0.15 | 0.2 |
| runWithCloudflareRequestContext - open-next-dev/cloudflare/init.js:201992 | 0.14 | 0.2 |

| Module / package | self ms/req | % |
| --- | ---: | ---: |
| (runtime / native) | 75.35 | 87.7 |
| app:chunks/911.js | 2.85 | 3.3 |
| app:chunks/828.js | 1.50 | 1.7 |
| (program) | 1.01 | 1.2 |
| (unknown module) | 0.89 | 1.0 |
| (garbage collector) | 0.76 | 0.9 |
| next/dist/compiled/next-server | 0.48 | 0.6 |
| @opennextjs/aws | 0.36 | 0.4 |

#### /admin/commerce (admin) (24.8 ms non-idle per request while profiled)

| Function - module:line | self ms/req | % |
| --- | ---: | ---: |
| (garbage collector) - (garbage collector):0 | 4.14 | 16.7 |
| (program) - (program):0 | 1.09 | 4.4 |
| (anonymous) - app:chunks/828.js:113004 `(a4, b3) {` | 0.81 | 3.3 |
| e - app:chunks/828.js:111077 `(a2, b2) {` | 0.68 | 2.7 |
| fetch - :0 | 0.59 | 2.4 |
| L - next/dist/compiled/next-server:48843 `(e10, t10) {` | 0.53 | 2.1 |
| toJson - (unknown module):616 | 0.41 | 1.6 |
| text - :0 | 0.33 | 1.3 |
| __name - (unknown module):3 | 0.32 | 1.3 |
| (anonymous) - app:chunks/828.js:111357 `(a3) => {` | 0.32 | 1.3 |
| setAttributes - :0 | 0.32 | 1.3 |
| _send - (unknown module):201 | 0.28 | 1.1 |

| Module / package | self ms/req | % |
| --- | ---: | ---: |
| next/dist/compiled/next-server | 4.50 | 18.1 |
| (garbage collector) | 4.14 | 16.7 |
| app:chunks/828.js | 3.64 | 14.7 |
| (runtime / native) | 3.47 | 14.0 |
| app:chunks/911.js | 1.64 | 6.6 |
| (unknown module) | 1.42 | 5.7 |
| (program) | 1.09 | 4.4 |
| workerd node-compat (streams_readable) | 0.54 | 2.2 |

#### lesson page (learner) (17.5 ms non-idle per request while profiled)

| Function - module:line | self ms/req | % |
| --- | ---: | ---: |
| (garbage collector) - (garbage collector):0 | 1.10 | 6.3 |
| (anonymous) - app:chunks/828.js:113004 `(a4, b3) {` | 1.05 | 6.0 |
| (program) - (program):0 | 0.95 | 5.4 |
| e - app:chunks/828.js:111077 `(a2, b2) {` | 0.53 | 3.0 |
| toJson - (unknown module):616 | 0.45 | 2.6 |
| fetch - :0 | 0.37 | 2.1 |
| nextTick - workerd node-compat (internal_process):14 | 0.28 | 1.6 |
| ao2 - app:chunks/828.js:112641 | 0.25 | 1.4 |
| (anonymous) - :0 | 0.23 | 1.3 |
| __name - (unknown module):3 | 0.22 | 1.3 |
| aB - app:chunks/828.js:113001 `(a2, b2 = {}) {` | 0.21 | 1.2 |
| set platform - :0 | 0.20 | 1.1 |

| Module / package | self ms/req | % |
| --- | ---: | ---: |
| next/dist/compiled/next-server | 3.57 | 20.3 |
| app:chunks/828.js | 3.31 | 18.9 |
| (runtime / native) | 2.38 | 13.5 |
| (unknown module) | 1.15 | 6.6 |
| (garbage collector) | 1.10 | 6.3 |
| (program) | 0.95 | 5.4 |
| app:chunks/911.js | 0.89 | 5.1 |
| app:chunks/3635.js | 0.69 | 3.9 |

#### /about [cold: first request on a fresh instance] (138.0 ms non-idle per request while profiled)

| Function - module:line | self ms/req | % |
| --- | ---: | ---: |
| require2 - open-next-dev/server-functions/default/handler.mjs:10281 | 24.88 | 18.0 |
| g2 - app:webpack-runtime.js:151132 `(a2) {` | 17.20 | 12.5 |
| (garbage collector) - (garbage collector):0 | 14.65 | 10.6 |
| a - next/dist/compiled/next-server:61503 `(e2) {` | 5.46 | 4.0 |
| __nccwpck_require__2 - next/dist/compiled/@opentelemetry:19837 | 2.91 | 2.1 |
| Object.defineProperty - open-next-dev/middleware/handler.mjs:202122 | 2.48 | 1.8 |
| __init - (unknown module):10 | 2.07 | 1.5 |
| (program) - (program):0 | 1.72 | 1.2 |
| .open-next/server-functions/default/node_modules/next/dist/server/load-manifest.external.js - next/dist/server:35911 | 1.71 | 1.2 |
| get - :0 | 1.52 | 1.1 |
| (anonymous) - next/dist/compiled/next-server:61533 `() => {` | 1.46 | 1.1 |
| set platform - :0 | 1.41 | 1.0 |

| Module / package | self ms/req | % |
| --- | ---: | ---: |
| open-next-dev/server-functions/default/handler.mjs | 27.44 | 19.9 |
| app:webpack-runtime.js | 17.61 | 12.8 |
| next/dist/server | 16.61 | 12.0 |
| next/dist/compiled/next-server | 15.72 | 11.4 |
| (garbage collector) | 14.65 | 10.6 |
| @opennextjs/aws | 5.28 | 3.8 |
| app:chunks/3635.js | 4.30 | 3.1 |
| (runtime / native) | 4.29 | 3.1 |

#### /learn/courses/[slug] (learner) [cold: first request on a fresh instance] (323.4 ms non-idle per request while profiled)

| Function - module:line | self ms/req | % |
| --- | ---: | ---: |
| require2 - open-next-dev/server-functions/default/handler.mjs:10281 | 61.24 | 18.9 |
| g2 - app:webpack-runtime.js:151132 `(a2) {` | 60.98 | 18.9 |
| (garbage collector) - (garbage collector):0 | 28.37 | 8.8 |
| a - next/dist/compiled/next-server:61503 `(e2) {` | 5.87 | 1.8 |
| Object.defineProperty - open-next-dev/middleware/handler.mjs:202122 | 4.65 | 1.4 |
| j2 - app:chunks/8563.js:129815 `(d4, g3) {` | 3.65 | 1.1 |
| set platform - :0 | 2.38 | 0.7 |
| __name - (unknown module):3 | 2.33 | 0.7 |
| (anonymous) - app:chunks/828.js:113004 `(a4, b3) {` | 2.07 | 0.6 |
| __init - (unknown module):10 | 1.90 | 0.6 |
| e22 - next/dist/compiled/next-server:60276 | 1.66 | 0.5 |
| (program) - (program):0 | 1.51 | 0.5 |

| Module / package | self ms/req | % |
| --- | ---: | ---: |
| open-next-dev/server-functions/default/handler.mjs | 64.19 | 19.8 |
| app:webpack-runtime.js | 63.04 | 19.5 |
| next/dist/compiled/next-server | 43.25 | 13.4 |
| (garbage collector) | 28.37 | 8.8 |
| next/dist/server | 18.79 | 5.8 |
| app:chunks/911.js | 17.99 | 5.6 |
| app:chunks/828.js | 12.84 | 4.0 |
| app:chunks/3635.js | 11.04 | 3.4 |
<!-- END:CPU-PROFILE-RESULTS -->

## Source identities and diagnosis

The readable OpenNext build does **not** unminify Next's optimized webpack modules. The following identifications were checked against the actual inspector source around each sampled line, not inferred from the chunk number. Positions in the generated table refer to the retained inspector scripts, not to line numbers in `src/`.

| Profile frame | Real function and source | Evidence / implication |
| --- | --- | --- |
| Coaching: anonymous `(a9, b6)` in chunk 5667 (baseline: line 102811; original interrupted report: line 102809) | `getTimezoneOffsetMs()` — `src/features/scheduling/time.ts:170` | Body constructs `Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })`, calls `formatToParts`, finds `timeZoneName`, falls back to `shortOffset`, and parses `/GMT([+-])(\d{1,2}):?(\d{2})/`. It is called five times per slot by `localTimeToUtc()`. This is the original ~55% hotspot. |
| Coaching: anonymous `(a10, b7)` in the same chunk | `getLocalWallClock()` — `src/features/scheduling/time.ts:124` | Formats year/month/day/hour/minute and is called by `roundTripsToWallClock()` to validate each UTC candidate. |
| Coaching: anonymous `(a8, b6)` in the same chunk | `getLocalDateParts()` — `src/features/scheduling/time.ts:103` | Constructs another formatter for every `localTimeToUtc()` call. |
| Coaching: anonymous `(a3, b3)` and `t(a2, b2)` near the start of chunk 5667 | `groupSlots()` and `timeLabel()` — `src/components/products/public-scheduler.tsx` | The SSR render of this client component also formats day labels and every visible slot. A client component still renders HTML on the server. |
| Sign-in: native `getScrypt` | `verifyPassword()` → `generateKey()` — `node_modules/@better-auth/utils/dist/password.node.mjs:26` / `:9` → `node:crypto.scrypt` | Better Auth's `signInEmail` endpoint (`node_modules/better-auth/dist/api/routes/sign-in.mjs`) calls `ctx.context.password.verify`. The built chunk explicitly calls `scrypt(password.normalize("NFKC"), salt, 64, { N:16384, r:16, p:1, maxmem:67108864 }, callback)`. This is verification of the existing salted hash, not a new hash or a speculative pure-JS fallback. `getScrypt` is the native runtime frame; it has no JavaScript source line to map. |
| Learner/admin: anonymous `(a4, b3)` in chunk 828 | `extractTablesRelationalConfig()` — `node_modules/drizzle-orm/relations.js:116` | The body walks `Object.entries(schema)`, checks Table/Relations entities, builds primary-key and relation maps. Called by `drizzle()` in `node_modules/drizzle-orm/d1/driver.js:16`; application `getDb()` (`src/lib/db/index.ts:5`) reconstructs it with the full schema on every call. |
| Learner/admin: `e(a2, b2)` in chunk 828 | `is()` — `node_modules/drizzle-orm/entity.js:3` | Matches `Symbol.for("drizzle:entityKind")`, `instanceof`, and the constructor/prototype walk. It supports the repeated schema extraction above. |
| Learner/admin: `ao2` and `aB` in chunk 828 | `BaseSQLiteDatabase` constructor — `node_modules/drizzle-orm/sqlite-core/db.js`; `drizzle()` — `node_modules/drizzle-orm/d1/driver.js:16` | Recreates per-table query builders and database wrappers after schema extraction. |
| Learner/admin: `L(e10, t10)` in Next's compiled app-page runtime | React DOM `writeChunk()` — `node_modules/next/dist/compiled/react-dom/cjs/react-dom-server.node.production.js:53` | Body uses `TextEncoder.encodeInto`, a 4096-byte buffer and destination writes. Independently mapped the `4096 < 3 * chunk.length` expression through `app-page.runtime.prod.js.map` using Node's `SourceMap.findEntry`; it resolves to the React DOM server source above. This is HTML stream encoding, not an application data query. |

Additional resolved frames: chunk 828's anonymous `(a3) => {` at line 111357 is the `chunks.map` callback in `SQL.buildQueryFromSourceParams()` (`node_modules/drizzle-orm/sql/sql.js:70`), matching the StringChunk/Name/Table/Column dispatch and query parameter construction. Coaching's anonymous frame at 102784 is `generateCandidateSlots()` (`src/features/scheduling/availability.ts:62`) and the one at 102792 is `getWeekdayInTz()` (`src/features/scheduling/time.ts:155`). The raw D1 frames labeled “unknown module” are actually `cloudflare-internal:d1-api`: `toJson()` at line 616 consumes response text and JSON-parses it; `_send()` at line 201 serializes SQL/params and fetches the local D1 service. Their exact virtual source is retained as `sources/warm-1/script-7.js`.

In this regenerated baseline, `getTimezoneOffsetMs()` accounts for **50.2%** of non-idle profiled samples, `getLocalWallClock()` **9.3%**, `getLocalDateParts()` **9.1%**, and native scrypt **85.3%** of the sign-in profile. The lesson's leading JavaScript frames are `extractTablesRelationalConfig()` (**6.0%**) and `is()` (**3.0%**); commerce has the same frames (**3.3%**, **2.7%**) plus **16.7%** GC. This identifies real work without pretending that small self-time frames explain the entire request.

The worst warm learner and admin profiles above must be read as distributed costs: no single sampled application function dominates them. GC, native fetch/serialization, schema construction and React streaming all contribute. Self time alone does not measure each function's inclusive cost or D1 query latency.

For the lesson page, the application entry is `LessonPlayerPage()` in `src/app/learn/courses/[courseSlug]/lessons/[lessonSlug]/page.tsx`. It reads the session, course, lesson, enrollment, curriculum, progress and resources, then renders the curriculum navigation and lesson blocks; `generateMetadata()` also reads course/lesson data. For commerce, `AdminCommercePage()` in `src/app/admin/commerce/page.tsx` calls `getCommerceAdminDashboardWithGuard()` in `src/features/commerce/admin.ts`, whose parallel counts and list projections repeatedly acquire a Drizzle wrapper. These call chains explain the shared Drizzle frames; the table is not claiming all query wait is CPU.

Cold profiles mainly expose lazy loading of the Next server, webpack's module loader, common-JS wrappers and GC. `g2` at `app:webpack-runtime.js:151132` is webpack's module-cache/require function (`.next/server/webpack-runtime.js`); `require2` at handler line 10281 is the nested esbuild `__commonJS` wrapper (the body invokes its stored module factory and caches exports). They are diagnostic startup/first-use evidence, not warm-route bottlenecks.

## Ranked risk of exceeding 10 ms

Ranked by warm median in this **local** baseline. These are candidates for investigation; hosted CPU/outcomes are required to establish Free-plan compatibility.

1. **`/coaching`: 93.1 ms p50 / 119.8 ms p95.** The clearest application hotspot: repeated Intl construction in the DST-safe slot resolver plus slot-label formatting. Reuse formatters and avoid recomputing equivalent day/offset probes while retaining gap/fold and freshness guarantees. No such change is included here.
2. **POST sign-in: 73.6 / 87.5 ms.** Native scrypt verification dominates. Query tuning will not remove it. Keep the password security parameters; an authentication design compatible with the Free budget needs a separate decision and edge validation.
3. **`/admin/commerce`: 37.1 / 56.1 ms.** Many dashboard count/list queries, repeated `getDb()` / schema construction, auth, serialization, streaming and GC. Investigate request-scoped DB reuse, batching and narrower dashboard reads first. The seeded commerce tables are small; this is not a production-scale benchmark.
4. **`/admin/editorial`: 23.9 / 43.2 ms; learner lesson: 23.6 / 44.6; learner course detail: 23.3 / 35.9 ms.** The lesson profile confirms repeated schema extraction/entity checks and D1 JSON handling, distributed across multiple reads and SSR. Editorial is ranked from the OS table; it was not separately V8-profiled, so its precise hot-function mix remains unmeasured.
5. **`/workshop`: 21.3 / 49.3 ms; learner course list: 21.1 / 38.1 ms.** Workshop is the missing-offer fallback in this fixture, so its cost is dynamic framework/data/rendering overhead; it cannot be attributed to slot generation. An active workshop needs its own fixture/profile. The learner list reads session, entitlements and progress; inspect query counts and wrapper reuse.
6. **Other authenticated SSR:** admin courses **18.8**, admin content **18.6**, learner home **17.0**, admin leads **15.9 ms** p50. Auth/data assembly and React rendering leave little headroom. These routes were timed but not separately sampled; do not assume their distribution exactly matches commerce or the lesson.
7. **Borderline or noisy:** admin login **11.6**, cached Mission 01 **10.3**, session API **9.4**, sitemap **8.9 ms** p50. Other cached public pages are **5.1–7.2 ms**, with p95 **10.4–15.5 ms**. The empty Worker floor is **1.0 / 1.5 ms**. Cached Mission 01 crossing the line in this run and widespread public p95 spikes are reasons to repeat on a quiet host and check edge outcomes, not evidence that static HTML itself requires an auth/scheduling redesign.

## Verification of this baseline

`npm run lint` and `npm run typecheck` passed. The final `npm test` passed **498 tests across 38 test-file invocations**, including the 2 added CPU-tooling tests. Wrangler config/log locations were redirected to temporary directories because this sandbox cannot write the user-wide registry. The parser tests cover pretty tail objects, JSONL/arrays, absent/zero/invalid timings, probe matching and nearest-rank summaries; they are appended to `npm test`.

`npm run perf:cpu -- --work-dir .cpu-profile` completed from freshly reseeded state, including `cf:build`, R2 population, 24 × (1 cold + 30 warm) successful route requests, the empty Worker floor, four warm V8 profiles and two cold profiles. The generated block records this run, not the interrupted run. A failure-path probe deliberately omitted fixtures: sign-in failed, the process exited 1, its workerd PID no longer existed and its HTTP port could be rebound. The successful run's final PID/port were checked too. No-URL remote invocation exited 2 without crawling. No remote CPU claim or deployment is made.

## Remote measurement, later

```sh
# Start a tail in one terminal BEFORE the crawl. Keep it running during the crawl.
npx wrangler tail <worker-name> --env production --format json > tail.jsonl
# In another terminal (use the real deployed URL):
npm run perf:cpu:remote -- --url https://<name>.<account>.workers.dev --tail-file tail.jsonl --out cpu-results-remote.md
```

The helper never deploys, seeds data or signs in, and makes GET requests only. An explicit `--url` or `CPU_REMOTE_URL` is required; no URL exits 2 before any fetch. HTTPS `*.workers.dev` origins are accepted by default; custom domains need `--allow-host`. Optional `CPU_LEARNER_COOKIE` / `CPU_ADMIN_COOKIE` stay in the shell environment. The remote run discovers existing public/course slugs and omits authenticated routes without cookies. It does not profile password verification remotely. The first crawl response is merely the first observed response; discovery or platform activity may already have warmed the isolate.

Checked the installed Wrangler 4.151.1 files without internet:

- `node_modules/wrangler/wrangler-dist/cli.d.ts` exposes no tail-event payload type and contains no `cpuTime` / `wallTime` declarations. Its tail-creation API types describe the WebSocket URL, not event timing fields.
- `src/tail/printing.ts` bundled into `node_modules/wrangler/wrangler-dist/cli.js` has `jsonPrintLogs()` call `logger.json(JSON.parse(data.toString()))`. `Logger.json()` uses `JSON.stringify(data, null, 4)`: consecutive multi-line objects, **not one JSON object per line**. `prettyPrintLogs()` reads top-level `outcome`, `eventTimestamp`, `event.request.url/method`, and `event.response.status`; `prettifyOutcome()` explicitly maps `exceededCpu` to “Exceeded CPU Limit”. Unknown outcomes are retained by this helper.
- `node_modules/@cloudflare/workers-types/index.d.ts`, `TraceItem`, declares top-level `cpuTime: number`, `wallTime: number`, `outcome: string`, and `event.request` / `event.response`. These are the exact Tail Worker timing names, in milliseconds. Do not assume every Wrangler tail event supplies them. Missing CPU stays `-`, never a fabricated zero.

The parser accepts consecutive pretty objects, JSONL or an array. It joins **only** by the per-request `x-cpu-probe` header (case-insensitive), so the tail must cover the same crawl/run ID. Re-running generates new IDs and cannot join an old tail file. Logs/Logpush exports must be normalized to that same event envelope, retaining the probe header; a URL alone cannot identify repeated requests. Accepted top-level CPU aliases are `cpuTime`, `cpuTimeMs`, `CPUTimeMs`, `cpu_time_ms`; analogous wall-time aliases are parsed but never substituted for CPU. Dashboard aggregates cannot be joined as individual requests. Tail sampling, redaction or missing events limit coverage; “no tail events” is not a passing CPU result. Request wall time includes network latency and is never presented as CPU.
