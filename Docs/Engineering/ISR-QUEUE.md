# Time-based ISR on Workers

Implementation: Next 16.4.3, OpenNext Cloudflare 1.20.15 / AWS 4.1.14.
This change is local until the coordinator deploys it. No dependency patches,
Cloudflare API calls, production data writes or PROJECT-STATUS edits are needed.

## Root cause (installed source)

- `node_modules/@opennextjs/cloudflare/dist/api/config.js:9-18,39-43,56-61`:
  omitting `queue` selects `"dummy"` for both the server and routing middleware.
- `node_modules/@opennextjs/aws/dist/core/routing/cacheInterceptor.js:27-96`:
  the interceptor calculates age from `lastModified`, calculates an ETag and,
  when the remaining TTL reaches 1 second, **awaits** `queue.send()` before
  returning the cached response with `x-opennext-cache: STALE`. HIT follows the
  same R2/tag read path but does not send a queue message. Pages/RSC use
  `:160-205`; metadata route responses use `:410-427`.
- The message contains `{host, url, eTag, lastModified}`; its deduplication ID
  hashes the cache key, timestamp and ETag, and its group identifies a stable
  shard (`cacheInterceptor.js:69-84`; `core/routing/queue.js:21-28`, default ten
  shards). The scoped cache key and encoded public revalidation path are distinct.
- `node_modules/@opennextjs/aws/dist/overrides/queue/dummy.js:1-8`:
  `send()` throws `FatalError("Dummy queue is not implemented")`. It does not
  enqueue anything. The interceptor catches this at `cacheInterceptor.js:433-436`
  and falls through to the server, even though it already read a usable body.
- On that normal path, Next's cache adapter reads the same R2 entry, performs
  the D1 tag checks, and reports `lastModified`/cache control to Next
  (`node_modules/@opennextjs/aws/dist/adapters/cache.js:149-180,194-221`).
  OpenNext suppresses Next's in-process background render for ordinary stale
  requests (`node_modules/@opennextjs/aws/dist/build/patch/patches/patchBackgroundRevalidation.js:3-44`),
  replacing the cache-return condition with `true` when not on-demand.
  The response completion hook sees `x-nextjs-cache: STALE` and sends the same
  message shape. This throw is caught/logged and the stale response survives
  (`core/routing/util.js:282-319,365-376`). No cache writer is running.

Thus a stale request with the dummy queue does more work than a routing HIT:
failed queue send/error handling, fallthrough into the full Next handler, a
second cache/tag lookup and a second failed queue send. This explains the
reported edge 12–18 ms stale requests versus the earlier 4–6 ms routing HITs;
those numbers are prior edge observations, not measurements from this patch.
With a working queue the stale body can remain in the interception path.

Affected safety nets: `/coaching`, `/workshop`, `/mission-01`,
`/ai-recruiter-os` (300 seconds), `/guides/[slug]`, `/field-notes/[slug]`,
`/sitemap.xml`, `/robots.txt` (3600 seconds). Coaching caches offer and booking
configuration; its live slot list separately uses the no-store
`/api/public/booking-slots` endpoint. Fixing shell ISR does not replace that API.

## Queue choice and Free-plan constraints

| Option | Behavior | Decision |
| --- | --- | --- |
| Adapter `do-queue` | `NEXT_CACHE_DO_QUEUE` RPC routes by group, cross-isolate dedup; SQLite records sync/failure state; background signed HEAD via `WORKER_SELF_REFERENCE`; retry alarms | Selected for coordination and bounded concurrency across isolates |
| Adapter `memory-queue` | Self-fetch in the caller's isolate, in-memory dedup only while a send is pending; needs `WORKER_SELF_REFERENCE`; errors logged without durable retries | Simpler, but duplicate renders across isolates spend scarce CPU/request quota |
| `queue-cache` wrapper | Adds local and regional Cache API TTL (default 5s) before forwarding to another queue; optional wait for acknowledgement; catches/logs failures | Omitted: another I/O/cache layer and possible delayed retry; unnecessary at present traffic. Can add after measured contention |

Installed implementation references:
`node_modules/@opennextjs/cloudflare/dist/api/overrides/queue/do-queue.js:4-15`,
`memory-queue.js:6-65`, `queue-cache.js:2-39,45-105`,
`api/durable-objects/queue.js:24-78,80-145,148-204,207-246`.
The DO acknowledges scheduling rather than waiting for the render;
`ctx.waitUntil` keeps it alive. Defaults: 5 concurrent renders per shard,
10s timeout, 2s retry interval with backoff, maximum retry setting 6.
Keep SQLite enabled so failures can be restored after eviction.

Verified against current primary docs on 2026-11-08:

- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/):
  Free permits **SQLite-backed classes only**, 100,000 DO requests/day and
  13,000 GB-s/day. These are separate from Worker request limits. Wrangler's
  installed schema explicitly supports `new_sqlite_classes`
  (`node_modules/wrangler/config-schema.json:3761-3784`). Do not replace it with
  `new_classes` (legacy KV storage). No paid plan is required by this queue.
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/):
  Cloudflare Queues is **no longer paid-only**: Free includes 10,000 operations/day,
  normally three operations per delivered message and 24h retention. It is a
  different product from the adapter's DO queue; we do not provision it.
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/):
  Free has 100,000 requests/day and 10ms CPU per HTTP request; request waitUntil
  extends up to 30s after completion. CPU excludes network/storage I/O.

Budget conservatively for **one extra Worker invocation/self-fetch per successful
regeneration**, one DO RPC per stale hit, and additional invocations/alarms on
failure/retry. DO dedup reduces regeneration count, not incoming RPC count.
Service-binding billing has a no-additional-fee rule for Workers Standard
([pricing](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings));
do not interpret that as free CPU or unlimited requests on Workers Free.
If all four 300s routes are continuously visited, about 1152 regenerations/day
plus `24 × (published guides + notes + 2 metadata routes)` are possible before
retries and on-demand invalidations. Add visitors and prewarm/deploy requests.
The DO's AbortSignal timeout can keep it active toward the 10s timeout even on
success (installed `queue.js:93-94`); at 128MiB that is roughly 1.25 GB-s per
isolated 10s active interval. Concurrent work on the same DO shares duration.
Track DO duration, requests, failures and Worker resource-limit statuses on the edge
with the [edge health check](#regeneration-cpu-watch).
This fixes endless staleness; it does **not** establish that each full SSR
regeneration fits 10ms CPU. Local HTTP success cannot prove edge CPU compliance.

## Entry points, bindings and clocks

`open-next.config.ts` selects the DO queue for middleware and the server while
retaining interception, D1 tags and `withRenderTimestamp(R2)`.
`worker.ts` delegates fetch to `.open-next/worker.js` and re-exports its
`DOQueueHandler`. The installed generated template exports this class
(`node_modules/@opennextjs/cloudflare/dist/cli/templates/worker.js:9-10`).
The installed README links the adapter documentation; see also
[custom Worker](https://opennext.js.org/cloudflare/howtos/custom-worker) and
[queue configuration](https://opennext.js.org/cloudflare/caching#queue).

Top-level `wrangler.jsonc` remains a Node/getPlatformProxy configuration with
no self service or internal DO binding. That proxy has no running Worker/DO
implementation; installed Wrangler warns about internal DOs
(`node_modules/wrangler/wrangler-dist/cli.js:378511-378523`).
`wrangler.preview.jsonc` and `env.production` both provide the DO namespace,
self reference and `isr-queue-v1` SQLite migration. Each extra hosted environment
must also include that migration. Even without a binding, a top-level migration
makes getPlatformProxy emulate an unimplemented class, so migrations stay out
of the top-level local config too.

Every Worker fetch, including queued HEADs, gets its own async-local render-start
clock. Separately bundled interceptor/server cache modules read the same global
ALS instance. Cache reads record that start per key; writes with no preceding
read also use it. An ISR self-fetch never inherits the stale entry's timestamp.
The queued request carries the signed `x-prerender-revalidate` and `x-isr: 1`
headers (`queue.js:85-95`); interception bypasses it
(`cacheInterceptor.js:323-326`), so Next really regenerates it. A one-millisecond
margin retains the conservative same-millisecond invalidation rule.
Build entries still use upload time, except the existing sitemap build-snapshot
rejection. No change to build population, deploy or prewarm sequencing.

## Local verification

`npm run test:e2e:worker:http` includes `e2e-worker/isr-queue.spec.ts` for all eight
paths. The local harness generates a separate entry in its temporary directory,
re-exporting the production DO class and adding fixture controls from
`scripts/worker-e2e-control.ts`. Only that disposable config points at the entry;
neither `worker.ts`, the Next app nor deployment config imports those controls.
There is no production route or runtime flag enabling them.

The fixture changes one stored entry's TTL to 3s, retaining its real cached body,
then waits just over 3s. Coaching/workshop D1 changes deliberately bypass path
invalidation. Assertions require HIT with old data, the first expired response
STALE with the same body, a new HIT within 15s and at most 20 polls, changed
offer availability, exactly one queued self-fetch, a newer render timestamp,
the original 300/3600s TTL restored, and two further stable HITs.
The same suite can run with `WORKER_E2E_INTERCEPTION_OFF=1` to verify the normal
Next path. `npm run test:e2e:worker:race` retains first-GET Server Action tests
with delayed R2 writes; they must still pass without freshness polling.

For the edge deployment configuration and verification steps see
[DEPLOYMENT.md](DEPLOYMENT.md#isr-queue-first-deploy-and-disposable-edge-check).

## Verified locally (2026-11-08)

| Check | Result |
| --- | --- |
| `npm run lint` | Passed, zero warnings |
| `npm run typecheck` | Passed |
| `tsx tests/isr-queue.test.ts`, `tests/render-cache.test.ts`, `tests/worker-e2e-tooling.test.ts` | 12 assertions/tests passed; new suite appended to `npm test` |
| `npm run test:e2e:worker:http` | 13 passed; all eight time-based cases: STALE then HIT on first follow-up poll, exactly one self-fetch each |
| `npm run test:e2e:worker:race` | 2 passed; 750ms delayed cache writes, first-GET freshness retained |
| `WORKER_E2E_INTERCEPTION_OFF=1 npx playwright test --config playwright.worker.config.ts isr-queue.spec.ts` | 8 passed; same eight transitions through Next's normal cache path |
| `npm run cf:build` | Passed against a separately migrated, disposable local D1; final artifacts use production queue/config, no test overrides |
| `npm run cf:size` | Passed: 12580.34 KiB uncompressed / 2847.75 KiB gzip; uncompressed budget 20480 KiB |
| Preview-config bundle dry-run | Passed: SQLite DO binding/class resolved; 12582.00 KiB uncompressed / 2848.01 KiB gzip |
| Production-entry fixture isolation | Dry-run bundle contained neither the fixture route string nor its enable flag; HTTP POST to `/__worker-e2e/control` returned 404 using the real `worker.ts` entry |
| `git diff --check`; PROJECT-STATUS unchanged | Passed |

All Worker checks used HTTP, without launching Chromium. Each harness and the
final build/runtime check removed its disposable state. The standalone local
Worker logged a disabled asset hot-reload watcher due to a platform limit;
serving/HTTP assertions passed. No remote Cloudflare commands or commits ran.
Edge CPU/duration, deployment and actual remote resource state remain for the
coordinator's external verification.

Changed files:

- Queue/deployment: `open-next.config.ts`, `wrangler.jsonc`,
  `wrangler.preview.jsonc`, `worker.ts`.
- Render clock: `src/lib/cloudflare/render-cache.ts`,
  `src/lib/cloudflare/render-clock.ts`, `src/lib/cloudflare/render-context.ts`.
- Local Worker harness: `scripts/worker-e2e-server.ts`,
  `scripts/worker-e2e-setup.ts`, `scripts/worker-e2e-control.ts`,
  `playwright.worker.config.ts`.
- Tests: `e2e-worker/isr-queue.spec.ts`, `tests/isr-queue.test.ts`,
  `tests/render-cache.test.ts`, `tests/worker-e2e-tooling.test.ts`, `package.json`.
- Documentation: this file and `Docs/Engineering/DEPLOYMENT.md`.


## Regeneration CPU watch

The coordinator's historical `dh-cputest` observation for **2026-11-02 through
2026-11-08**: **1548 requests**, **0 errors**, **success status only**, maximum
CPU **728 ms**, p99 **334 ms**, and **no 1102s**. This supplied observation was
not re-queried during this implementation. Requests above the documented
**10 ms Free CPU limit** succeeding are consistent with Cloudflare's allowance
for occasional CPU overages/burst flexibility; this does not guarantee future
regenerations will succeed. Keep watching cold batches and background renders.
Source: [Cloudflare CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

Use the read-only GraphQL Analytics check (production by default):

```sh
npm run edge:health -- --env cputest --hours 24
npm run edge:health -- --env production --hours 24
```

Set `CLOUDFLARE_ACCOUNT_ID` privately in the environment, or pass `--account`
with the account ID. There is no account discovery, `whoami` or deployments-list
fallback. `--worker` overrides the selected environment's Worker name from
`wrangler.jsonc`; `--hours` accepts positive hours up to 744 (default 24).
Actual account dataset/retention limits may be shorter and will fail the query.
Credentials come from `CLOUDFLARE_API_TOKEN`, otherwise captured JSON output
from `npx wrangler auth token --json`. Neither token nor raw credential command
output is printed. The credential needs **Account Analytics Read** access;
existing Wrangler OAuth may lack the required analytics permission.

`scripts/edge-health.ts` queries `workersInvocationsAdaptive` with only `status`
as the grouping dimension: requests/errors, CPU p50/p99/p999 and maximum.
`cpuTime` values are **microseconds**, converted by dividing by 1000 for every
printed **ms** value. Percentiles are requested for the full status group; they
are never averaged from time buckets. It also queries
`durableObjectsInvocationsAdaptiveGroups` for the same Worker/time window,
grouped by status, with requests/errors. Source:
[Workers GraphQL tutorial](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
and [Durable Objects analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/).

Any status other than `success`, or any `sum.errors > 0` in either dataset,
exits nonzero. `exceededResources` includes **1102** (also other resource-limit
errors); status alone does not isolate CPU as the cause. See
[invocation status mapping](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).
CPU above 10 ms alone is a watch item, not a failure threshold for this check.
Missing/malformed/partial GraphQL results, request/auth failures and no Worker
traffic also fail closed. An empty DO dataset can mean no queue invocations.
Adaptive sampling, analytics delay, the selected window and no per-route or
per-render breakdown limit what this check establishes. It does not measure DO
duration/GB-s or prove every regeneration fits the limit; use the DO dashboard
for duration as well. Synthetic fixtures and mocked fetch tests verify parsing,
units, status/error thresholds and request construction without live credentials.
