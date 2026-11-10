# Worker cache interception and immediate editorial freshness

Branch: `perf/cache-interception`. Local, uncommitted work, 2026-11-08.
Installed versions inspected: Next 16.4.3, OpenNext AWS 4.1.14,
OpenNext Cloudflare 1.20.15. No dependency files were patched.

## Root cause and evidence

Both reported failures can arise from the same race: a pre-mutation page render
finishes its R2 write after the action expires its path tag. The stock R2 provider
reports the object's **upload time** as `lastModified`, so D1 treats that older
render as newer than the invalidation.

The coordinator's **interception-off** guide trace, inspected before the fresh
test runs, establishes the real
ordering: `/guides` segment prefetch started at `14:56:05.760Z`, took 136 ms,
and returned `MISS`; update and publish POSTs started at `.822Z` and `.848Z`
(the latter took 27 ms). The prefetch completed after publish. The first anonymous
index GET at `.974Z` returned `x-nextjs-cache: HIT` with the pre-publish list.
This is stronger evidence than assuming an action response or toast was early.
The framework awaits revalidations before rendering the action response:
`node_modules/next/dist/server/app-render/action-handler.js:947-977`.

Installed source chain:

- `node_modules/next/dist/server/web/spec-extension/revalidate.js:79-98` maps
  `revalidatePath("/guides")` to `_N_T_/guides`, without a stale profile.
  `node_modules/next/dist/server/revalidation-utils.js:99-139` passes those tags
  and durations to the incremental cache. `updateTag` reaches the same no-profile
  revalidation primitive (`revalidate.js:55-65`).
- `node_modules/next/dist/server/lib/implicit-tags.js:15-41,58-79` derives layout
  and page tags, including route groups, and adds the concrete URL tag. The
  populated guide index contains `_N_T_/layout`, `_N_T_/(site)/layout`,
  `_N_T_/(site)/guides/layout`, `_N_T_/(site)/guides/page`, `_N_T_/guides`.
  The existing literal invalidations match; this is not a missing path/type.
- `node_modules/@opennextjs/aws/dist/adapters/cache.js:394-424` converts a
  no-profile invalidation to `{tag, expire: now}`. The D1 provider writes those
  timestamps (`node_modules/@opennextjs/cloudflare/dist/api/overrides/tag-cache/d1-next-tag-cache.js:52-68`).
  Its expiry check requires `expire <= now && expire > lastModified`
  (`d1-next-tag-cache.js:28-43`).
- `node_modules/@opennextjs/aws/dist/adapters/cache.js:273-288,339-361` schedules
  APP_PAGE writes on the request's pending promise runner; a completed GET does
  not establish that its background R2 upload has finished.
  `node_modules/@opennextjs/cloudflare/dist/api/overrides/incremental-cache/r2-incremental-cache.js:17-42`
  reads `r2Object.uploaded.getTime()` and writes the JSON without a render timestamp.
  Thus an old render uploaded after expiry defeats the comparison above.
- `node_modules/@opennextjs/aws/dist/core/routing/cacheInterceptor.js:279-321`
  selects runtime ISR entries for dynamic routes with blocking fallback;
  `:366-392` checks tags then serves the cached page.
  `:228-232` preserves cached 404 status. Our detail routes use
  `generateStaticParams() => []`, `revalidate = 3600`, and `notFound()` for an
  unpublished slug (`src/app/(site)/guides/[slug]/page.tsx:8-23,49-60`,
  `src/app/(site)/field-notes/[slug]/page.tsx:8-23,49-60`). Those negative pages
  are APP_PAGE cache entries too. A response's `no-store` error header does not
  delete that internal entry (`cacheInterceptor.js:192-205`).
- Without interception, Next's cache handler does the same tag test
  (`node_modules/@opennextjs/aws/dist/adapters/cache.js:149-176`). The wider
  injected window reproduces the cached-404 race off too. The coordinator's
  on/off difference for A was timing-dependent, not proof of separate expiry APIs.

## Build entries and SWR

Build pages retain their HTML/RSC/segments/implicit tags in `.cache` assets,
without a stored lifetime or generation timestamp:
`node_modules/@opennextjs/aws/dist/build/createAssets.js:134-179`.
The route-scoped keys are collected and uploaded unchanged during population:
`node_modules/@opennextjs/cloudflare/dist/cli/commands/populate-cache.js:88-126,332-350`;
`node_modules/@opennextjs/cloudflare/dist/cli/workers/r2-cache.js:47-50`.
The stock provider therefore dates them at population/upload time too. Population
creates the D1 revalidation schema; it does not pre-expire these entries
(`populate-cache.js:490-545`). Build lifetimes come from the prerender manifest
(`node_modules/@opennextjs/aws/dist/adapters/cache.js:32-41`).

The observed B failure is **not SWR recovery on the next visit**. On both baseline
modes, the first, second, third and later reads through about 5.3 seconds stayed
old, reporting `HIT`, never `STALE`. Once the late upload appears newer than the
expiry, the D1 provider's stale test also returns false
(`d1-next-tag-cache.js:70-90`). The index pages have no time-based revalidation,
so there is no short automatic recovery; another invalidation/build is needed.
Detail pages have the one-hour safety net. Normal time expiry can take the SWR
path (`cacheInterceptor.js:52-95`), but that does not repair a non-expiring index.

The old serial HTTP spec checked the index, but did not warm a public draft 404
or leave a pre-publication index render's upload outstanding. A serial baseline
probe returned fresh first GETs; that did not disprove the browser race.

## Fix and alternatives evaluated

`src/lib/cloudflare/render-cache.ts` wraps the supported R2 cache override. It
records the first cache read's time per request/key, before rendering/data reads,
and persists that time with runtime route entries. On retrieval it reports that
render time as `lastModified`, stripping its private field before returning the
value. A conservative one-millisecond margin also expires a render that started
in the same millisecond as invalidation. A late old write remains older than the invalidation, so the next GET
blocks on fresh rendering. Even if it overwrites a newer render, it cannot
resurrect old content; it can only cause another cache miss.

`open-next.config.ts` installs the wrapper for both routing and server handling
through `defineCloudflareConfig`. The R2 provider name, keys, build population,
HTML/RSC/segments, tags, status and cache controls are preserved. Build entries
without the field retain their original timestamp; fetch/composable caches are
passed through. This also fixes `refreshCommerce()`'s `/coaching`, `/workshop`,
`/mission-01`, `/ai-recruiter-os` paths (`src/features/commerce/admin-actions.ts:20-34`)
and editorial-AI publication without duplicating invalidation code.

The installed Next docs were read before implementation:
`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md`,
`updateTag.md`, `revalidateTag.md`. Literal `revalidatePath` already requests
immediate expiry. Changing it to `updateTag` or `revalidateTag(..., {expire: 0})`
would still compare against the incorrect upload timestamp. `"max"` intentionally
allows stale data and fails the requirement. Adding `"page"` blindly changes the
tag to an ungrouped page tag; the literal URL tag is already correct. Broad layout
invalidation would over-invalidate without fixing late uploads. Public 404
`no-store` headers are already present. The installed interception option is a
boolean, without a per-route exclusion callback
(`node_modules/@opennextjs/cloudflare/dist/api/config.d.ts:28-32`). Disabling it
also leaves B exposed. Existing action calls and their unit-test stubs stay
unchanged because their invalidation contract is correct.

The native OpenNext config loader needs the helper's explicit `.ts` extension;
`allowImportingTsExtensions` is enabled with the existing `noEmit` setting.

## Reproduction and checks

The local-only harness accepts three explicit diagnostic options. They generate
a temporary OpenNext config; they do not alter deployment configuration:

- `WORKER_E2E_INTERCEPTION_OFF=1`: allow the otherwise-rejected off build.
- `WORKER_E2E_CACHE_WRITE_DELAY_MS=750`: hold route writes across the mutation.
  Range 0–5000 ms; default 0. This widens the observed browser race, without
  changing application queries or invalidation semantics.
- `WORKER_E2E_ORIGINAL_R2=1`: use the installed R2 provider without our timestamp
  wrapper to reproduce the baseline. Default is the fixed provider.

Run HTTP-only checks (no Chromium launch):

```sh
npm run test:e2e:worker:http
npm run test:e2e:worker:race
WORKER_E2E_INTERCEPTION_OFF=1 npm run test:e2e:worker:race
# Baseline regression demonstration: expected first-GET failure
WORKER_E2E_ORIGINAL_R2=1 npm run test:e2e:worker:race
WORKER_E2E_ORIGINAL_R2=1 WORKER_E2E_INTERCEPTION_OFF=1 npm run test:e2e:worker:race
```

The race check saves a draft, warms a public 404, checks private previews,
performs the save-before-publish sequence, and GETs the invalidated draft/detail
and index before publication. After publish, it lets the *old upload* land and
asserts the **first** public detail and index responses. This delay does not poll
away staleness: it deliberately places the stale write before the first assertion.
The same spec checks first-GET edit, rename (both old/new links in one index
response), unpublish, republish, archive, and commerce deactivate/reactivate.
Only establishing a cache precondition polls. The browser suite retains toast
completion and has no `response.finished()` wait.

Baseline delayed-write diagnostics, each kind, both modes:

| Read after publish | Detail | Index | Cache |
| --- | --- | --- | --- |
| first (~0.9 s) | old 404 | article absent | HIT |
| second / third | old 404 | article absent | HIT |
| later (~1.2, 2.3, 5.3 s) | old 404 | article absent | HIT |

Fixed delayed-write probes on **and** off: first GETs were fresh (`MISS`); later
writes became `HIT` while remaining fresh. The strict HTTP lifecycle/commerce
spec passed with 750 ms write latency in both modes (27.3 s on, 27.7 s off).
The three routing HTTP tests also passed on (2.7 s): headers/HEAD, HTML/RSC and
dynamic preview, and live coaching slots. Final clean-build results are below.

Final validation:

- `npm run lint`: passed with zero warnings.
- `npm run typecheck`: passed (`next typegen` and `tsc --noEmit`).
- `npm test`: **527/527**, 43 test programs, zero failures. In this sandbox,
  `XDG_CONFIG_HOME` and `WRANGLER_LOG_PATH` point to dedicated `/tmp` directories
  because the default Wrangler registry/log directory is not writable.
- `npm run test:e2e:worker:http`: **4/4**, final clean normal-config build, 42.8 s.
- `npm run test:e2e:worker:race`: **1/1**, clean build with 750 ms late writes,
  27.1 s test time / approximately 1.1 min including setup.
- The same strict HTTP lifecycle/commerce spec on the fixed off build: **1/1**,
  27.7 s test time. Baseline diagnostic probes reproduced both stale indexes and
  negative entries in both modes; second/third reads did not heal them.
- Throwaway directories from baseline, A/B and regression runs were checked
  absent after shutdown. No Chromium launch was attempted in this task.
- `npm run cf:size`: passed using local `wrangler deploy --dry-run` only;
  **12613.68 KiB** uncompressed / **2850.36 KiB** gzip, under the 20480 KiB
  project budget. Final build is the normal config, with no diagnostic delay.

The coordinator must rerun `npm run test:e2e:worker` outside the sandbox for the
five actual-browser tests (Studio lifecycle for both kinds, Link/RSC navigation,
contact action, scheduler hydration). The completed HTTP checks cannot establish
browser behavior or edge CPU. No remote Cloudflare command, deployment, or commit
is part of this work.

## Studio lifecycle flake (2026-11-10)

`cache-interception.spec.ts` › "guides/field-notes: admin lifecycle…" failed
intermittently in two ways. Neither was a tag-invalidation bug in the R2/D1 path.

- **404 on the first GET after publish.** The Studio editor's `Preview ↗` and
  list-row `Preview` links (`<Link href="/guides/<slug>?preview=true" target="_blank">`)
  were prefetched. The segment-cache `/_tree` prefetch is sent to the slug
  **without** `?preview=true`, so it skips the preview rewrite and renders the
  public ISR route (a 404 for a draft). It repeats after every action/refresh,
  including while "Publish Now" runs. HTML GETs and RSC prefetches share the
  response-cache key `/guides/<slug>`, and Next's `ResponseCache.getBatcher`
  coalesces concurrent renders of a key
  (`node_modules/next/dist/server/response-cache/index.js`). A prefetch that read
  the draft before the publish committed, and was still rendering when the first
  anonymous GET arrived, handed that GET its 404, bypassing the tag check.
  Render timestamps protect only the persisted entry, not an in-flight render.
  Fix: `prefetch={false}` on the new-tab Studio links. The spec now asserts that
  the browser never requests a public `worker-*` article.
- **"Archived" toast never seen.** `showToast` never cancelled the previous
  4-second dismiss timer. A toast that appeared just before an older timer fired
  was removed after a few ms, before Playwright could read it. Fix: shared
  `useToast()` (`src/app/admin/_ui/interactive.tsx`) clears the previous timer.

The spec also signs in once per run and uses a unique slug per attempt, so
`--repeat-each` no longer hits the auth rate limit or a "Creation Failed" slug clash.
