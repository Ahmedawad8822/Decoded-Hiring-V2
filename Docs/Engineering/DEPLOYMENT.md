# Deployment — Cloudflare Workers via OpenNext

Status: production is not provisioned; `env.production` contains placeholders.
The disposable test Worker uses `env.cputest`. For test-only Git integration,
follow [Workers Builds](WORKERS-BUILDS.md). Do not use the production scripts for it.

## How it fits together

| Piece | What it does |
|---|---|
| `@opennextjs/cloudflare` (pinned **1.20.15**) | Turns the `next build` output into a Worker (`.open-next/worker.js`) plus static assets (`.open-next/assets`). We run Next 16.4.3 and wrangler 4.156.0. |
| `open-next.config.ts` | `enableCacheInterception: true` serves ISR/SSG hits in the routing layer after rewrites, bypassing server actions and draft-mode cookies. R2 incremental cache (`NEXT_INC_CACHE_R2_BUCKET`) uses our render-timestamp wrapper so an old render uploaded after a mutation cannot undo its invalidation. D1 persists tag expiry (`NEXT_TAG_CACHE_D1`, same database as `DB`); without it, `revalidatePath()`/`revalidateTag()` would do nothing on Workers. OpenNext population creates its own `revalidations` table; it is not a Drizzle migration. See [cache race analysis](CACHE-INTERCEPTION.md). |
| `src/lib/cloudflare/bindings.ts` | On Workers, bindings come from `getCloudflareContext().env`. In local Node (`next dev`, `next build`, tests, scripts), it falls back to wrangler's `getPlatformProxy` with persist path `DH_LOCAL_STATE_DIR` or `.wrangler/state/v3`. wrangler is imported with a computed specifier, so it is never bundled. |
| `wrangler.jsonc` | Top level = **local** config (dev, tests, `npm run preview`). `env.production` = real resources (placeholders). Bindings: `DB` (D1), `MEDIA_BUCKET` (R2), `NEXT_INC_CACHE_R2_BUCKET` (R2), `WORKER_SELF_REFERENCE` (service), `ASSETS`. |
| `worker.ts` / ISR queue | Custom entry delegates to the generated Worker, re-exports `DOQueueHandler` and establishes the render-start clock, including background HEADs. Preview/production bind `NEXT_CACHE_DO_QUEUE` and the self service; each includes the `isr-queue-v1` migration creating a **SQLite** DO class supported on Workers Free. See [ISR queue analysis](ISR-QUEUE.md). |

## Scripts

| Script | Use |
|---|---|
| `npm run cf:build` | OpenNext build (runs `next build` first). Needs `BETTER_AUTH_SECRET` set and a migrated local DB (`npm run db:migrate:local`), because `/guides` and `/field-notes` prerender from D1. |
| `npm run cf:size` | Runs `wrangler deploy --dry-run` (no credentials), parses the uncompressed `Total Upload` size and fails above `WORKER_UNCOMPRESSED_BUDGET_KIB` (default 20480 KiB / 20 MiB; Free and Paid limit 64 MiB). Gzip is printed for information only. Run after `cf:build`. Runs in CI as the `worker-size` job. |
| `npm run preview` | Build, then run the real Worker locally in `wrangler dev` against local D1/R2. Put local-only secrets in `.dev.vars` (git-ignored), e.g. `BETTER_AUTH_SECRET=...`. |
| `npm run test:e2e:worker` | Builds and tests the real local Worker with cache interception; fresh disposable D1/R2 and test-only admin credentials. See below. |
| `npm run db:migrate:remote` | `wrangler d1 migrations apply DB --env production --remote` |
| `npm run deploy` | Validate `PREWARM_BASE_URL`, build and deploy with `--env production`, then run anonymous GET prewarming. **Fails until the placeholders are filled.** A failed prewarm exits nonzero after deployment; it does not roll the deployment back. |
| `npm run prewarm -- --base-url https://deployment.example` | GET the public sitemap, published articles, static marketing paths and robots, with concurrency 2 and up to 2 retries. No credentials, content writes or Cloudflare APIs. |

## Cold article prewarming (2026-11-08)

Use prewarming after **every deployment**, before directing visitors to the new
build, and optionally after an editorial batch. A new build ID creates a fresh R2
namespace, so runtime ISR article entries cannot survive deployment. We retain
`generateStaticParams() => []` on articles: a build-local D1 snapshot cannot
safely represent production publication state. Existing publish/edit/rename and
unpublish invalidation remains authoritative.

For the production deploy command, supply the origin explicitly in the environment
(the preflight validates it before any build/deploy command):

```sh
PREWARM_BASE_URL=https://deployment.example npm run deploy
```

For a deployment performed separately, or to retry incomplete prewarming:

```sh
npm run prewarm -- --base-url https://deployment.example
# Equivalent:
PREWARM_BASE_URL=https://deployment.example npm run prewarm
```

`scripts/prewarm.ts` GETs `/sitemap.xml` first, takes the primary `<loc>` from each
entry, and adds the shared static marketing paths plus `/robots.txt`. Canonical
sitemap hosts may differ from a workers.dev/custom deployment origin: only the
allowlisted public **paths** are rebased onto the supplied origin. It skips query
strings (including `?preview`), fragments, credentials, private paths and nested
article paths. Redirects are reported without following them. It sends no cookies
or authorization, consumes every response body, and never issues a method other
than GET. It writes no files or content; ordinary server-side cache fills are the
intended effect of these GETs.

Defaults: concurrency **2**, **30 s** timeout per attempt, **2** retries after
**500/1000 ms** backoff for network/body errors, invalid sitemap responses, 429
or 5xx. Other HTTP errors, including redirects/404, fail without retry. The reusable
function accepts bounded options; the CLI deliberately keeps the conservative
defaults. A bad sitemap still permits static-route warming but fails the run.
The summary lists each URL, status/error, attempts and cache header, plus totals;
exit status is nonzero if any URL remains failed. A 200 is a successful GET, not
proof that a background R2 upload has finished or that every edge location is warm.
A subsequent run can confirm cache HITs. Concurrent editorial changes remain safe:
server queries and path invalidation control publication, not sitemap discovery.

With **G** published guides and **F** published notes and the current **13** static
paths, a no-retry run uses **G + F + 15** requests (sitemap + robots included).
At most **3 × (G + F + 15)** attempts are made with the default retry limit.
Every attempt counts against the Workers Free **100,000 requests/day** budget,
shared with visitor traffic; multiply by deploys/reruns per day. The CLI reports
its actual request count. GET-only does not make these requests free of quota.

This is mitigation, not a guarantee that SSR fits Workers Free. Reported cold
article renders at **85–340 ms CPU** remain individual requests over the **10 ms**
allowance. Cloudflare allows occasional overages per isolate, but consistent
excess terminates execution with **1102 / exceededCpu**. A burst of cold prewarms
can exhaust that flexibility; retries may fail too. There is no documented
probability or fixed "one in N" rate. Neither HTTP success nor local workerd can
quantify it. Measure cold deploy batches, error counts and subsequent HIT CPU on
the edge before claiming reliability; no remote measurement was run here.
See [Cloudflare CPU/request limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

### Metadata cache and freshness

`src/app/sitemap.ts` now exports `revalidate = 3600`. Guide and field-note create,
edit/rename, publish, unpublish and archive actions, and Editorial AI publication,
call `revalidatePath("/sitemap.xml")`. The next anonymous GET regenerates against
D1; hourly expiry is a safety net (normal time expiry can use SWR). The render-time
wrapper also covers `APP_ROUTE` entries, preventing a late old sitemap upload from
undoing action invalidation.

Because Next prerenders a cacheable sitemap against **build-local** D1,
`withRenderTimestamp` rejects only **unstamped sitemap route entries** populated
from the build. The first deployed GET then reads the deployed D1 binding and
writes a stamped runtime cache entry. This prevents prewarming a stale local
article list after deployment. Other build-populated routes keep their existing
behavior. No dependency files are patched.

`robots.ts` has the same explicit one-hour cache lifetime. Its policy and sitemap
URL do not depend on article status or slugs, so editorial actions need not expire
it. A configuration/code change deploys it in the new build namespace. HTTP tests
check repeat GET cache HITs for both metadata routes.

Installed-source analysis and verification results:
[COLD-RENDER.md](COLD-RENDER.md).

## Worker cache regression suite

Run `npm run test:e2e:worker` (Chromium installed via `npx playwright install chromium`).
Use `E2E_WORKER_PORT=3151 npm run test:e2e:worker` if the default loopback port
3107 is occupied. An existing server is never reused. Playwright arguments can
be appended, e.g. `npm run test:e2e:worker -- --headed`.

`playwright.worker.config.ts` starts `scripts/worker-e2e-server.ts`, which reuses
`e2e-bootstrap.ts`, the baseline guide seed and OpenNext's pinned cache population
implementation. It runs `opennextjs-cloudflare build`, populates R2 and the D1 tag
table, then runs `wrangler dev --local`. The generated config copies
`wrangler.preview.jsonc`, including its self-reference service. A fresh OS temp
directory holds `.dev.vars` (random auth secret, fixture origin and
`ADMIN_REQUIRE_2FA=false`), Wrangler config/logs and `.wrangler/state`.
`DH_LOCAL_STATE_DIR` points to that directory's `state/v3`; `--persist-to` points
to `state`. OpenNext cache population runs from that same temp cwd, since it
has no persistence-path option. The harness stops the Worker and deletes the
temp directory on completion/interruption; it never uses the developer's
`.wrangler/state` or credentials. It rebuilds `.next`/`.open-next`, so do not run
another build or dev server in this worktree concurrently.

The suite checks routing-layer `x-opennext-cache: HIT`, security headers and
HEAD, real Studio guide/field-note actions (publish, edit, rename, unpublish,
archive), authenticated and anonymous draft preview, Link/RSC navigation,
contact lead persistence and the coaching shell's live slots. Mutation checks
assert the **first** subsequent GET; only cache-write preconditions poll.
Failures retain screenshots/traces in `test-results/worker`.

HTTP-only: `npm run test:e2e:worker:http`. This launches no browser. The final
clean build passed **5/5** (53.6 s including setup), covering headers/HEAD,
HTML/RSC, preview rewrites, live slots, both article lifecycles, first-GET
commerce freshness on all four public offer pages, anonymous prewarming, and
sitemap/robots caching. Sitemap lifecycle checks cover publish, edit, rename,
unpublish, republish and archive. Discovery includes a guide created after the
build without invalidation, proving runtime D1 bootstrap.

`npm run test:e2e:worker:race` adds 750 ms latency before cache writes, forcing
a pre-mutation render's upload to finish after tag expiry. The current metadata/
prewarmer suite passed **2/2** (1.1 min including setup); the lifecycle check
took 31.0 s. Earlier page/commerce checks also passed with interception off. For the off A/B,
use `WORKER_E2E_INTERCEPTION_OFF=1 npm run test:e2e:worker:race`; the default
guard still requires interception on. `WORKER_E2E_ORIGINAL_R2=1` selects the
unwrapped baseline in this disposable harness; with latency it reproduces the
stale 404/index failure. These options only generate a temporary local config.
See [source citations, reproduction and results](CACHE-INTERCEPTION.md).

Chromium cannot launch in this sandbox (`bootstrap_check_in …
MachPortRendezvousServer`, `Permission denied (1100)`). The coordinator's earlier
browser run exposed the late-upload race fixed here; the five browser tests
still need rerunning on the final code outside the sandbox before merge.
Worker shutdown and throwaway-state removal were verified after HTTP runs.

## Verified locally (2026-10-24)

- `npm run cf:build`: OpenNext build complete.
- `wrangler deploy --dry-run`: total upload **12.57 MiB, 2.82 MiB gzipped** (Next 16.4.2, adapter 1.20.12).
- `opennextjs-cloudflare preview` (built Worker in `wrangler dev`):
  - 200 on `/`, `/guides`, `/field-notes`, `/coaching`, `/workshop`, `/admin/login` and `/sitemap.xml` (dynamic, reads D1).
  - `/learn` redirects anonymous users to `/login`.
  - `/api/auth/get-session` returns `null` when anonymous.
  - Email sign-up wrote to D1, and the session cookie then opened `/learn`.
  - `/_next/image` returns the original WebP (no `IMAGES` binding, so no resizing).

## Production deployment reference (not provisioned)

1. **Account and plan.** Choose the Cloudflare account. See the risks below about script size, startup time and request CPU limits.
2. **Provision:**
   - `wrangler d1 create <name>`
   - `wrangler r2 bucket create <media>`
   - `wrangler r2 bucket create <next-cache>`

   Put the names and the D1 id into `env.production`.
3. **Secrets:**
   - `wrangler secret put BETTER_AUTH_SECRET --env production` (32+ random characters)
   - provider secrets later, when providers are activated
4. **Vars:** set `BETTER_AUTH_URL` and `NEXT_PUBLIC_SITE_URL` to the real origin. **Do not set `ADMIN_REQUIRE_2FA` in production.** Admin TOTP 2FA is enforced unless that variable is exactly `false`; it is `false` only in `.env.example` (local dev) and the Playwright web server (CI/e2e). An admin without 2FA is redirected to `/admin/security` (pages) or rejected (actions) until they enroll.
5. **Migrations:** `npm run db:migrate:remote`.
6. **Admin account:** create the first admin in remote D1 with the script (credentials come from the environment, never argv; password at least 12 characters; idempotent, an existing email is only promoted unless `--reset-password` is added):

   ```bash
   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<12+ chars>' ADMIN_NAME='Your Name' \
     npm run admin:create -- --remote --env production
   ```

   `--remote` without `--env` is refused. Without flags it targets local D1 (honours `DH_LOCAL_STATE_DIR`). Run it after step 5, then sign in at `/admin/login`. The first sign-in lands on `/admin/security`: enroll an authenticator app and save the backup codes before anything else works. Lost-device recovery: a backup code, or, with D1 access, delete the user's row in `two_factor` and set `user.two_factor_enabled = 0` (they re-enroll on next sign-in).
7. **Deploy:** `PREWARM_BASE_URL=https://your-deployment-origin npm run deploy`. For the existing test environment use [Workers Builds](WORKERS-BUILDS.md).
8. **Domain:** add a custom domain or route in Cloudflare. DNS cutover from V1 is a Phase 8 launch step.

## Risks and open decisions

- **Script size.** Workers Free and Paid both allow **64 MiB uncompressed** (65536 KiB); there is no compressed size limit. Per the [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/) updated 2026-10-29. The historical 12.57 MiB total upload above uses about 20% of that limit; its 2.82 MiB gzip size is informational. CI enforces an early-growth budget of **20480 KiB (20 MiB) uncompressed** (`npm run cf:size`, override `WORKER_UNCOMPRESSED_BUDGET_KIB`). It parses wrangler's `Total Upload` line, so a format change fails loudly (exit 2). The script warns above 90% of the platform's 64 MiB uncompressed limit.
- **Startup time.** Both plans limit global-scope startup to **1 second**. Imported module initialization counts toward startup CPU; load admin-only providers, ingestion code and validation inside the functions that need them. Bundle size checks do not measure startup time; verify it separately with the built Worker before deploying.
- **CPU time.** Workers Free allows **10 ms CPU** per request. On the deployed disposable test Worker (2026-11-08), cache interception reduced cached anonymous public-page CPU p50 from **5–11 ms to 3–5 ms** (p95 **10–26 ms to 6–10 ms**). Cold article renders and dynamic/private routes remain separate risks; the local regression suite verifies behavior, not edge CPU.
- **Build-time data.** `/guides` and `/field-notes` are statically prerendered from the build machine's local D1, so the first deploy ships whatever that DB contains (usually nothing). They refresh when a publish action calls `revalidatePath()`. Before launch, decide between:
  - `export const revalidate = <seconds>`
  - rendering them dynamically
  - running `opennextjs-cloudflare populateCache` after deploy
- **Image resizing.** No `IMAGES` binding yet, so `next/image` serves originals. Add Cloudflare Images if resizing is needed (it has its own pricing).
- **Local `npm run preview` state.** It shares `.wrangler/state/v3` with `next dev`.

## Follow-ups

- Use `npm run admin:create -- --remote --env <name>` for admin provisioning; public fixture passwords are rejected for every remote target.
- Test Git integration is documented in [Workers Builds](WORKERS-BUILDS.md); production and non-production branch builds are not connected.

## ISR queue: first deploy and disposable edge check

Keep `main: "worker.ts"` and include the migration below in each hosted environment. Wrangler applies it
on the first deploy to each Worker; there is no separate DO create command.
The class must be **SQLite-backed** for Workers Free. Keep the tag immutable
after it has been applied. This is a DO class migration, not a D1/Drizzle
migration; the existing D1/R2 provisioning and OpenNext population still apply.

```json
"migrations": [
  { "tag": "isr-queue-v1", "new_sqlite_classes": ["DOQueueHandler"] }
]
```

Before first deploy, ensure each hosted environment has both
`NEXT_CACHE_DO_QUEUE → DOQueueHandler` and
`WORKER_SELF_REFERENCE → <that environment's worker name>`. Binding arrays are
not inherited. The custom entry is inherited;
`wrangler.preview.jsonc` separately repeats the migration and bindings for local
Worker previews. Ordinary Next dev/build/getPlatformProxy deliberately omits
the service, internal DO bindings and migrations (a migration alone also causes
the proxy to emulate an unimplemented class). Do not deploy the top-level local config.

For the existing disposable CPU test resources, add the following member under
`wrangler.jsonc → env` in the coordinator's deployment checkout. The resource
identities were read from the local `tmp/cputest` worktree config on 2026-11-08;
no remote existence check was performed. Verify them in the coordinator's
environment before use. No production identifiers are involved.

```json
"cputest": {
  "name": "dh-cputest",
  "workers_dev": true,
  "migrations": [
    { "tag": "isr-queue-v1", "new_sqlite_classes": ["DOQueueHandler"] }
  ],
  "services": [
    { "binding": "WORKER_SELF_REFERENCE", "service": "dh-cputest" }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "NEXT_CACHE_DO_QUEUE", "class_name": "DOQueueHandler" }
    ]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "dh-cputest-db",
      "database_id": "48a2e827-8d37-4041-a311-4642aa5a2d76",
      "migrations_dir": "drizzle/migrations"
    },
    {
      "binding": "NEXT_TAG_CACHE_D1",
      "database_name": "dh-cputest-db",
      "database_id": "48a2e827-8d37-4041-a311-4642aa5a2d76"
    }
  ],
  "r2_buckets": [
    { "binding": "MEDIA_BUCKET", "bucket_name": "dh-cputest-media" },
    { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "dh-cputest-next-cache" }
  ],
  "vars": {
    "BETTER_AUTH_URL": "https://dh-cputest.hdv2.workers.dev",
    "NEXT_PUBLIC_SITE_URL": "https://dh-cputest.hdv2.workers.dev"
  }
}
```

Coordinator-only steps **outside the sandbox** (not performed by this change):

```sh
# In the checkout with env.cputest above and its existing auth secret:
npx opennextjs-cloudflare build --env cputest
npx opennextjs-cloudflare deploy --env cputest
npm run prewarm -- --base-url https://dh-cputest.hdv2.workers.dev
# In a separate terminal, record edge CPU/outcomes and queue errors:
npx wrangler tail --env cputest --format json > /tmp/dh-cputest-isr-tail.jsonl
```

Confirm a routing HIT before testing expiry. For a disposable coaching/workshop
offer only, snapshot its D1 row, change `active` directly in **dh-cputest-db**
(not through a Server Action, which immediately invalidates the path), and
confirm the pre-expiry shell still contains the old availability. At the real
300s boundary, issue one GET: expect STALE with the old body, then poll at most
20 times / 15s for HIT with the changed availability. Confirm two more HITs and
one signed revalidation HEAD, no repeated queue failure, and no exceededCpu
outcome. Restore the exact fixture row and verify its availability returns on
the next natural refresh or through the existing approved admin path. Repeat
an hourly article/metadata sample at its natural boundary when practical.
The local tests already accelerate all eight route windows without adding a
test route or shorter lifetime to this deployment. Never deploy the temporary
fixture entry from `scripts/worker-e2e-server.ts`.

Edge CPU must be reported separately for HIT, STALE, and the background
regeneration request, plus DO request/duration usage. The queue fixes stale
loops but does not make full SSR fit the Workers Free 10ms CPU allowance.
No test-only control path should exist on the edge:
`POST /__worker-e2e/control` must return 404. See [ISR-QUEUE.md](ISR-QUEUE.md)
for installed-source evidence, alternatives and quota calculations.
