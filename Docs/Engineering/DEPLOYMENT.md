# Deployment — Cloudflare Workers via OpenNext

Status: production resources are provisioned and selected by `env.production`
(2026-11-09). Production stays on workers.dev until launch; custom domain/DNS
cutover comes later. The coordinator deploys production manually on the owner's
GO; production must never be connected to Workers Builds. Resource configuration
is not proof of a successful deployment. The disposable test Worker uses
`env.cputest` and retains automatic deployment through
[Workers Builds](WORKERS-BUILDS.md). Do not use production scripts for that Worker.

## How it fits together

| Piece | What it does |
|---|---|
| `@opennextjs/cloudflare` (pinned **1.20.15**) | Turns the `next build` output into a Worker (`.open-next/worker.js`) plus static assets (`.open-next/assets`). We run Next 16.4.3 and wrangler 4.156.0. |
| `open-next.config.ts` | `enableCacheInterception: true` serves ISR/SSG hits in the routing layer after rewrites, bypassing server actions and draft-mode cookies. R2 incremental cache (`NEXT_INC_CACHE_R2_BUCKET`) uses our render-timestamp wrapper so an old render uploaded after a mutation cannot undo its invalidation. D1 persists tag expiry (`NEXT_TAG_CACHE_D1`, same database as `DB`); without it, `revalidatePath()`/`revalidateTag()` would do nothing on Workers. OpenNext population creates its own `revalidations` table; it is not a Drizzle migration. See [cache race analysis](CACHE-INTERCEPTION.md). |
| `src/lib/cloudflare/bindings.ts` | On Workers, bindings come from `getCloudflareContext().env`. In local Node (`next dev`, `next build`, tests, scripts), it falls back to wrangler's `getPlatformProxy` with persist path `DH_LOCAL_STATE_DIR` or `.wrangler/state/v3`. wrangler is imported with a computed specifier, so it is never bundled. |
| `wrangler.jsonc` | Top level = **local** config (dev, tests, `npm run preview`). `env.production` = provisioned production resources. Bindings: `DB` (D1), `MEDIA_BUCKET` (R2), `NEXT_INC_CACHE_R2_BUCKET` (R2), `WORKER_SELF_REFERENCE` (service), `ASSETS`. |
| `worker.ts` / ISR queue | Custom entry delegates to the generated Worker, re-exports `DOQueueHandler` and establishes the render-start clock, including background HEADs. Preview/production bind `NEXT_CACHE_DO_QUEUE` and the self service; each includes the `isr-queue-v1` migration creating a **SQLite** DO class supported on Workers Free. See [ISR queue analysis](ISR-QUEUE.md). |

## Scripts

| Script | Use |
|---|---|
| `npm run cf:build` | OpenNext build (runs `next build` first). Needs `BETTER_AUTH_SECRET` set and a migrated local DB (`npm run db:migrate:local`), because `/guides` and `/field-notes` prerender from D1. |
| `npm run cf:size` | Runs `wrangler deploy --dry-run` (no credentials), parses the uncompressed `Total Upload` size and fails above `WORKER_UNCOMPRESSED_BUDGET_KIB` (default 20480 KiB / 20 MiB; Free and Paid limit 64 MiB). Gzip is printed for information only. Run after `cf:build`. Runs in CI as the `worker-size` job. |
| `npm run preview` | Build, then run the real Worker locally in `wrangler dev` against local D1/R2. Put local-only secrets in `.dev.vars` (git-ignored), e.g. `BETTER_AUTH_SECRET=...`. |
| `npm run test:e2e:worker` | Builds and tests the real local Worker with cache interception; fresh disposable D1/R2 and test-only admin credentials. See below. |
| `npm run db:migrate:remote` | `wrangler d1 migrations apply DB --env production --remote` |
| `npx tsx scripts/build-env.ts --env production` | Migrate and build against fresh empty temporary local state; origin comes from production vars. Use `--env cputest` for the test Worker. Never deploys or seeds. |
| `npm run deploy` | Guard clean git tree and HEAD equal to freshly fetched `origin/main`; prewarm preflight, remote production D1 migrations, isolated production build, OpenNext deployment/cache population, then prewarming at the configured production origin. Manual coordinator command only, after owner GO. A failed prewarm exits nonzero after deployment; no rollback. |
| `npm run deploy -- --dry-run` | Print the steps and current local guard blockers; no fetch, build, HTTP requests or remote commands. Exit zero means the plan printed, not that deployment is authorized or guard checks passed. |
| `npm run prewarm -- --base-url https://deployment.example` | GET the public sitemap, published articles, static marketing paths and robots, with concurrency 2 and up to 2 retries. No credentials, content writes or Cloudflare APIs. |

## Cold article prewarming (2026-11-08)

Use prewarming after **every deployment**, before directing visitors to the new
build, and optionally after an editorial batch. A new build ID creates a fresh R2
namespace, so runtime ISR article entries cannot survive deployment. We retain
`generateStaticParams() => []` on articles: a build-local D1 snapshot cannot
safely represent production publication state. Existing publish/edit/rename and
unpublish invalidation remains authoritative.

The guarded production deploy command reads and validates the origin from
`env.production.vars` in `wrangler.jsonc` and passes it explicitly to both
preflight and prewarming. It does not depend on `PREWARM_BASE_URL`. Run it only
under the manual production procedure below.

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

## Production deployment (provisioned; manual only)

`wrangler.jsonc → env.production` selects the following provisioned resources:

| Resource | Name / origin |
| --- | --- |
| Worker | `decoded-hiring-v2` (`workers_dev: true`) |
| Site/auth origin | https://decoded-hiring-v2.hdv2.workers.dev |
| D1 (`DB` and `NEXT_TAG_CACHE_D1`) | `decoded-hiring-v2-db` |
| Media R2 | `decoded-hiring-v2-media` |
| Incremental cache R2 | `decoded-hiring-v2-next-cache` |
| ISR queue | `NEXT_CACHE_DO_QUEUE → DOQueueHandler`, SQLite migration `isr-queue-v1` |
| Self reference | `WORKER_SELF_REFERENCE → decoded-hiring-v2` |

Source of resource selectors: the checked-in production environment. These
names are not credentials. Do not recreate the resources or connect production
to Workers Builds. `dh-cputest` keeps its existing auto-deploy build command
`npm ci && npx tsx scripts/build-cputest.ts` unchanged.

1. **Review and authorization.** Merge reviewed changes into `main`. After the
   owner's GO, the coordinator uses a clean checkout at `origin/main` with
   installed locked dependencies (`npm ci`). The script accepts any branch name
   only when HEAD is exactly the fetched main revision; ahead, behind and
   diverged commits all fail. Staged, unstaged and untracked files all fail.
   Fetch failure or unresolved main fails closed. Never run concurrent builds
   or edit the checkout while deploying.
2. **Runtime secrets.** The coordinator must ensure production has its real
   `BETTER_AUTH_SECRET` (32+ random characters) through Cloudflare's secure
   secret management. No real value belongs in source, logs or command arguments.
   Build-time auth uses a new ephemeral random value that is never the runtime
   secret. Provider secrets are needed only when providers are activated.
   Keep `ADMIN_REQUIRE_2FA` unset in production; setting it to `false` bypasses
   the required TOTP gate.
3. **Inspect the plan:**

   ```sh
   npm run deploy -- --dry-run
   ```

   This prints blockers against the local tracking ref without fetching. It
   never executes the deployment and does not approve it.
4. **Manual deploy (coordinator, after owner GO):**

   ```sh
   npm run deploy
   ```

   `scripts/deploy-production.ts` refuses local modifications, fetches main
   from origin (read-only on GitHub), and requires a clean tree and matching
   HEAD. It then runs these steps, stopping on the first failure:

   ```sh
   npx tsx scripts/prewarm.ts --check --base-url https://decoded-hiring-v2.hdv2.workers.dev
   npm run db:migrate:remote
   npx tsx scripts/build-env.ts --env production
   npx opennextjs-cloudflare deploy --env production
   npm run prewarm -- --base-url https://decoded-hiring-v2.hdv2.workers.dev
   ```

   Remote migrations apply to production D1 before building. OpenNext deploy
   populates remote R2/D1 cache before Wrangler uploads the Worker (installed
   `node_modules/@opennextjs/cloudflare/dist/cli/commands/deploy.js`). A later
   build/deploy failure does not undo earlier migrations/cache writes; a failed
   prewarm does not undo deployment. Inspect the completed step before retrying.
5. **First admin (owner runs this themselves, after migrations).** Supply
   `ADMIN_EMAIL`, `ADMIN_PASSWORD` and optional `ADMIN_NAME` privately through
   the process environment, without literal credentials in shell history:

   ```sh
   npm run admin:create -- --remote --env production
   ```

   This is a separate, explicit remote data mutation; the deploy script never
   creates users or seeds content. Passwords must be at least 12 characters;
   public fixture passwords are rejected. Existing users are promoted without
   resetting their password unless `--reset-password` is explicitly supplied.
   First sign-in at `/admin/login` redirects to `/admin/security`: enroll an
   authenticator and save backup codes before using the admin workspace.
   Lost-device recovery uses a backup code, or a separately authorized D1
   recovery resetting the user's 2FA state so they can re-enroll. See
   `scripts/create-admin.ts` and the admin gates in `src/lib/auth`.
6. **Verify.** Check anonymous public pages and cache HITs, authenticated admin
   2FA, publication invalidation and time-based ISR on the deployed Worker.
   Run the [edge health check](ISR-QUEUE.md#regeneration-cpu-watch) for Worker/DO
   errors and CPU. These are distinct from a successful local build.
7. **Launch later.** Remain on workers.dev until a separately approved custom
   domain and DNS cutover. Update both production origin vars before building
   for the new domain; `NEXT_PUBLIC_SITE_URL` is compiled into the build.

### Build isolation

`scripts/build-env.ts --env <cputest|production>` parses JSONC with TypeScript's
JSONC parser (no evaluation or regex comment stripping), requires matching
HTTPS `BETTER_AUTH_URL` / `NEXT_PUBLIC_SITE_URL` origins, and rejects absent
values, placeholders, credentials, paths, queries and fragments. It always
creates a fresh empty OS temporary directory and overrides
`DH_LOCAL_STATE_DIR` for local migrations and the full OpenNext build, even if
the caller exported another path. Wrangler registry/log files also stay inside
that directory and Wrangler telemetry is disabled. It disables the skip-build environment
option so old Next output cannot be reused. No seed runs.

`scripts/migrate-local.ts → migrateLocalDb() → getD1Database()` uses
`src/lib/cloudflare/bindings.ts`, whose local `getPlatformProxy` persist path
honors `DH_LOCAL_STATE_DIR`. Next prerendering follows that same local binding
path. Both commands receive the same disposable state. The directory is removed
in `finally` on success/failure; cancellation is forwarded to the active command
before cleanup. Forced process termination (for example SIGKILL) can leave an
unused temp directory. Ordinary developer state is never selected by this path.
Raw `npm run build` / `cf:build` remain contributor commands; use `build-env`
for deployable environment builds.

## Risks and open decisions

- **Script size.** Workers Free and Paid both allow **64 MiB uncompressed** (65536 KiB); there is no compressed size limit. Per the [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/) updated 2026-10-29. The historical 12.57 MiB total upload above uses about 20% of that limit; its 2.82 MiB gzip size is informational. CI enforces an early-growth budget of **20480 KiB (20 MiB) uncompressed** (`npm run cf:size`, override `WORKER_UNCOMPRESSED_BUDGET_KIB`). It parses wrangler's `Total Upload` line, so a format change fails loudly (exit 2). The script warns above 90% of the platform's 64 MiB uncompressed limit.
- **Startup time.** Both plans limit global-scope startup to **1 second**. Imported module initialization counts toward startup CPU; load admin-only providers, ingestion code and validation inside the functions that need them. Bundle size checks do not measure startup time; verify it separately with the built Worker before deploying.
- **CPU time.** Workers Free allows **10 ms CPU** per request. On the deployed disposable test Worker (2026-11-08), cache interception reduced cached anonymous public-page CPU p50 from **5–11 ms to 3–5 ms** (p95 **10–26 ms to 6–10 ms**). Cold article renders and dynamic/private routes remain separate risks; the local regression suite verifies behavior, not edge CPU.
- **Build-time freshness.** Environment builds prerender `/guides` and `/field-notes` from a fresh empty local D1, preventing developer content from entering bundles. Their initial indexes can still be empty until publication invalidation; an empty build is not a production-content snapshot. Before launch, decide between:
  - `export const revalidate = <seconds>`
  - rendering them dynamically
  - running `opennextjs-cloudflare populateCache` after deploy
- **Image resizing.** No `IMAGES` binding yet, so `next/image` serves originals. Add Cloudflare Images if resizing is needed (it has its own pricing).
- **Local `npm run preview` state.** It shares `.wrangler/state/v3` with `next dev`.

## Follow-ups

- Use `npm run admin:create -- --remote --env <name>` for admin provisioning; public fixture passwords are rejected for every remote target.
- Test Git integration is documented in [Workers Builds](WORKERS-BUILDS.md); production remains manual and must never be connected; non-production branch builds are off.

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
