# Cold renders and metadata caching — 2026-11-08

Branch `perf/cold-render`, from `b5466cb`. Local, uncommitted implementation.
No remote Cloudflare commands or browser launches. PROJECT-STATUS.md is unchanged.

## Design

Use post-deploy anonymous GET prewarming, not build-time article snapshots.
The build machine's D1 is not production's; publication state cannot be trusted
there. Runtime ISR articles retain `generateStaticParams() => []`, 3600-second
revalidation and their existing first-GET publication freshness contract.
`npm run deploy` validates an explicit target origin before deployment and runs
`npm run prewarm` after deployment. A failed prewarm fails the command but does
not undo the completed deployment. Usage, request costs and remaining 1102 risk
are in [DEPLOYMENT.md](DEPLOYMENT.md#cold-article-prewarming-2026-11-08).

The script issues only credential-free GETs, never follows redirects, discovers
public guide/note paths from the deployed sitemap, adds shared marketing routes
and robots, caps concurrent requests at 2 by default and retries transient failures
at most twice. It consumes bodies, reports each outcome and exits nonzero on
remaining failures. Every request/retry consumes quota; no success-rate or CPU
improvement claim follows from local verification.

The sitemap's former `force-dynamic` setting forced D1 work every request.
Replacing it with an hourly revalidation interval allows an APP_ROUTE response
cache. Every editorial mutation now expires the literal sitemap URL tag. The
runtime timestamp wrapper ignores unstamped build-local sitemap snapshots so
the first deployed discovery reads the deployed D1, then caches that response.
Robots is explicitly cached for an hour; it contains no article-dependent data.

## Installed-source evidence (Next 16.4.3 / OpenNext Cloudflare 1.20.15)

All paths below are relative to this checkout; line numbers refer to installed
packages. The installed sitemap, robots, revalidatePath and ISR guides were read
before implementation.

- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/sitemap.md:42-44`
  and `robots.md:20-22` document metadata handlers' default caching and dynamic
  opt-outs. For this non-Cache-Components build, positive `revalidate` explicitly
  enables static generation:
  `node_modules/next/dist/server/route-modules/app-route/helpers/is-static-gen-enabled.js:11-12`.
- `node_modules/next/dist/build/webpack/loaders/next-metadata-route-loader.js:40-44,213-237`
  re-exports the sitemap's `revalidate` config into a generated GET route and
  serializes its default export. Robots uses the same re-export mechanism in the
  text handler (`:111-135`). The generated browser cache-control is
  `public, max-age=0, must-revalidate` (`:46-48`); it does **not** mean the internal
  Worker route cache is disabled.
- `node_modules/next/dist/lib/metadata/get-metadata-route.js:133-161` maps robots
  to `/robots.txt/route` and the single sitemap to `/sitemap.xml/route`.
  `node_modules/next/dist/server/route-modules/app-route/module.js:549-551` derives
  implicit tags from the route and concrete URL;
  `node_modules/next/dist/server/lib/implicit-tags.js:58-79` adds
  `_N_T_/sitemap.xml` (and `_N_T_/robots.txt`).
  `node_modules/next/dist/server/web/spec-extension/revalidate.js:79-98` maps
  `revalidatePath("/sitemap.xml")` to that literal tag without a stale profile.
  No `page` type or `/route` suffix should be appended to the invalidation URL.
- `node_modules/@opennextjs/aws/dist/utils/routeCacheKey.js:107-114,190-209`
  identifies metadata owners as `APP_ROUTE` and computes
  `/route-cache/APP_ROUTE/<sha256 of /sitemap.xml/route>/$/sitemap.xml`.
  `node_modules/@opennextjs/aws/dist/adapters/cache.js:298-313` persists these
  responses as `type: "route"`, with body, headers, status and revalidation
  interval. Our existing wrapper stamps these runtime entries as well as pages.
- `node_modules/@opennextjs/aws/dist/core/routing/cacheInterceptor.js:366-387,410-429`
  reads the scoped entry, checks route tags before serving it, and serves route
  bodies directly from the routing layer. `node_modules/@opennextjs/aws/dist/adapters/cache.js:394-424`
  converts no-profile invalidation to an immediate expiry timestamp;
  `node_modules/@opennextjs/cloudflare/dist/api/overrides/tag-cache/d1-next-tag-cache.js:28-43,52-68`
  compares expiry with `lastModified` and persists invalidation in D1. The existing
  render-start timestamp prevents late old uploads from appearing fresh.
- `node_modules/@opennextjs/cloudflare/dist/api/overrides/incremental-cache/r2-incremental-cache.js:60-65`
  includes `OPEN_NEXT_BUILD_ID` in the R2 key. Each deployment therefore begins
  with a new article-cache namespace; prewarming cannot preserve the old build.

## Files changed

- `scripts/prewarm.ts`, `src/lib/public-routes.ts`, `package.json`: reusable GET-only
  prewarmer, CLI/deploy integration and shared public path list.
- `src/app/sitemap.ts`, `src/app/robots.ts`, `src/lib/sitemap-entries.ts`,
  `src/lib/cloudflare/render-cache.ts`: metadata cache lifetimes and deployed-D1
  sitemap bootstrap.
- `src/features/guides/actions.ts`, `src/features/field-notes/actions.ts`,
  `src/features/editorial-ai/drafts/actions.ts`: immediate sitemap invalidation.
- `tests/prewarm.test.ts`, `tests/render-cache.test.ts`,
  `tests/admin-audit-trail.test.ts`: URL/concurrency/retry/error/anonymous-GET tests,
  snapshot exclusion and consistent lifecycle invalidation assertions.
- `e2e-worker/server-actions.spec.ts`, `scripts/worker-e2e-server.ts`,
  `scripts/worker-e2e-setup.ts`: HTTP prewarming and metadata lifecycle/cache checks;
  a guide created after the build proves first sitemap discovery uses runtime D1.
- This report and `Docs/Engineering/DEPLOYMENT.md`.

## Verification

- `npm run lint`: passed, zero warnings.
- `npm run typecheck`: passed (Next type generation and TypeScript).
- Targeted units: **56/56** across `prewarm` (4), `render-cache` (6),
  `admin-audit-trail` (10), `foundation-remediation` (10),
  `editorial-ai/publishing` (24) and `worker-e2e-tooling` (2).
  Wrangler config/log paths pointed to dedicated `/tmp` locations. The full
  `npm test` chain was not rerun; the prewarmer suite is appended to that chain.
- `npm run test:e2e:worker:http`: **5/5**, 53.6 s including fresh setup/build.
  No Chromium launch. Anonymous prewarming succeeds, the runtime-only guide is
  discovered on the first sitemap GET, both metadata paths become cache HITs,
  and first-GET sitemap lifecycle assertions pass for both content types.
- `npm run test:e2e:worker:race`: **2/2**, 1.1 min including setup/build;
  750 ms cache-write delay. Lifecycle/commerce test time 31.0 s. The sitemap read
  before publish is allowed to upload after publish; the first post-action read
  still includes the newly published article. No freshness polling after actions;
  polling is only used to establish HIT preconditions.
- `npm run db:migrate:local && npm run cf:build && npm run cf:size`: passed on
  fresh throwaway local D1 and normal config (no diagnostic write delay).
  **12597.34 KiB uncompressed / 2849.25 KiB gzip**, under the 20480 KiB budget.
  `cf:size` used local `wrangler deploy --dry-run`; nothing was deployed.
- Final `.next/prerender-manifest.json` records **3600** seconds for both
  `/sitemap.xml` and `/robots.txt` and their concrete `_N_T_` URL tags.
- `git diff --check`: passed; PROJECT-STATUS.md has no diff. Both Worker harness
  throwaway directories were checked absent after shutdown; build temp state is
  removed by Python's `TemporaryDirectory`.

The coordinator must run `npm run test:e2e:worker` outside the sandbox for the five
browser tests (the full suite is now ten tests including the five HTTP tests).
On an authorized edge environment, measure a newly deployed cold batch and repeat
HITs, recording actual `exceededCpu`/1102 counts as well as CPU p50/p95. In
particular measure sitemap miss/HIT CPU and article prewarm failures/retries.
Local workerd does not reproduce Free-plan CPU enforcement or establish an edge
failure frequency. No commit, deployment, secret/resource operation, remote D1/R2
operation or tail command was run.
