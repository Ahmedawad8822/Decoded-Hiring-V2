# Performance budget

Status: **budgets defined; build-time, platform-size and anonymous public edge CPU measurements exist.** Measured on 2026-10-24 with Next 16.4.2 (webpack), `npm run build` against a freshly migrated local D1. A feature that materially breaks a budget should fail the quality gate until justified or corrected.

## 1. User-facing budgets

| Metric / rule | Target | Measured today | Enforced today |
|---|---|---|---|
| LCP (mobile p75) | <= 1.5 s | Not measured | No |
| INP (mobile p75) | <= 200 ms | Not measured | No |
| CLS | <= 0.05 | Not measured | No |
| Cached public TTFB | < 200 ms from target markets | Not measured | No |
| Public DB reads on a cache hit | 0 where practical | Static and ISR routes (now including `/coaching` and `/workshop`): 0 at request time (see section 3). Reads happen only in `GET /api/public/booking-slots`, `/sitemap.xml` and preview | No |
| Initial JS | Aggressively small | See section 4 | No |
| Images | Responsive, modern formats, correct dimensions, lazy below the fold | See section 5 | No |
| Third-party scripts | No render-blocking analytics/marketing | None found in `src` (no `<script>` except JSON-LD in `src/lib/seo.tsx`; no external font/CSS import found) | By absence only |
| Test locations | Egypt, Saudi Arabia, UAE | Not measured | No |

## 2. Platform budgets that exist today

| Budget | Limit | Current | Enforcement |
|---|---|---|---|
| Worker size (uncompressed) | Workers Free and Paid **64 MiB (65536 KiB)**; CI budget **20480 KiB (20 MiB)**; no compressed size limit | 12.57 MiB uncompressed (about 20% of platform limit), 2.82 MiB gzip (information only), per `Docs/Engineering/DEPLOYMENT.md` (2026-10-24) | CI job `worker-size` (`npm run cf:build`, `npm run cf:size`, `scripts/check-worker-size.ts`); fails the PR |
| Worker startup (global scope) | Free and Paid: **1 second** | Not measured; imported module initialization counts | None; verify built Worker startup separately |
| Worker CPU | Workers Free: **10 ms per request** | Disposable test Worker, 2026-11-08: cached anonymous public-page p50 **5–11 → 3–5 ms** with cache interception; p95 **10–26 → 6–10 ms**. Dynamic/private routes not measured on the edge | `test:e2e:worker` gates cache/routing correctness locally; no CPU gate |
| Workers requests | 100,000/day (Free) | Not measured | None |
| D1 reads | 5 M rows/day (Free) | Not measured | None |
| D1 writes | 100 k rows/day (Free) | Not measured | None; writes are designed down (below) |
| D1 storage | 5 GB | Not measured | None |
| R2 | 10 GB-month; 1 M Class A, 10 M Class B ops/month | Not measured | None |

Cache interception answers ISR/SSG hits before the Next server runs, after routing
and preview rewrites; actions and draft mode bypass it. These edge numbers are
from the deployed test Worker, not local workerd timing. Cold article renders
remain expensive (135–331 ms with interception in that test). Run
`npm run test:e2e:worker` for isolated local freshness/routing regression proof
([setup](Engineering/DEPLOYMENT.md#worker-cache-regression-suite)).
The local render-timestamp fix prevents late R2 writes from resurrecting expired
pages ([analysis](Engineering/CACHE-INTERCEPTION.md)); its edge CPU overhead has
not been measured. Local size on this branch: 12613.68 KiB uncompressed.

### Worker import audit (2026-11-08, offline)

Same worktree and installed dependencies, before/after `npm run cf:build` and
`npm run cf:size` (wrangler dry-run, no deployment):

| Measurement | Before | After |
|---|---|---|
| Uncompressed Total Upload | 12769.90 KiB | 12818.90 KiB |
| Gzip (informational only) | 2857.59 KiB | 2869.06 KiB |

The additional async chunks increase total upload by 49.00 KiB uncompressed
and 11.47 KiB gzip. These changes defer initialization; they do not reduce the
total bundle or establish a measured startup-time improvement.

| Module / dependency | Before | After / safety boundary |
|---|---|---|
| `qrcode-generator` | Static import in `admin/security/security-client.tsx`; QR implementation in `.next/server/app/admin/security/page.js` | Imported in the enrollment event before calling Better Auth; QR implementation moves to async `.next/server/chunks/1950.js`. Same SVG options and error handler; no server-rendered QR is needed |
| Offers `./types` (create/update Zod schemas) | Static dependency of the shared offer read/mutation service | Imported inside `createOffer` / `updateOffer`, before the same validation and DB work. Public `/mission-01` and `/coaching` no longer statically reach offer schemas through this service |
| Scheduling `./schemas` | Static import in shared `policy.ts` | Imported inside `createBookingType`, `updateBookingType`, `createAvailabilityWindow`, before validation and writes. Public hold operations still statically use this shared schema module; this is not complete schema isolation |
| Editorial providers, knowledge retrieval, active memory, Aha Authority skill | Static imports of the draft service | Imported inside `generateDraft`; listing and reading drafts do not need generation. Existing provider configuration checks and evidence-first behavior remain; OpenAI and FakeProvider implementations were already dynamic |
| Editorial draft `./types` schemas | Static import of the draft service | Imported inside `generateDraft` / `updateDraft` before the same validation; action-level validation is retained |
| Knowledge `./storage` and `./chunker` | Static imports of the knowledge service | Imported inside ingestion's existing `try` block; list/detail reads do not need R2 loading or chunking; lease/error recovery stays in place |

Checked source import graphs (after TypeScript type erasure), `.next/server`
chunks and OpenNext's `handler.mjs.meta.json`. Editorial modules were already
admin-scoped in the source graph; root/public layouts do not import them.
Motion is used by public client components and remains for their animations.
Zod remains in public paths that validate public inputs. Built Worker startup
time and deployed request CPU are not measured by this audit.

### How D1 writes are spent

| Writer | Writes per event | Notes |
|---|---|---|
| Public rate limits (`public_rate_limits`) | 1 upsert per consume | Each also adds 1 per-IP upsert (#42), so leads: 3 (IP, email, kind), bookings: 3, analytics: 2. Expired rows are pruned on ~1% of consumes (24 h retention, at most 500 rows per pass; #34) |
| Auth rate limits | 1 upsert per sign-in/up, password flow, or other non-session auth call | `/get-session` is excluded (`UNLIMITED_PATHS`) so session reads cost no write |
| Better Auth itself | Session and account rows on sign-in/up | Default behaviour |
| Business events (`business_events`) | 1 `INSERT OR IGNORE` per event, dedupe key | Written best-effort on offer CTA, booking started/created, order transitions |
| Booking, hold, order, history rows | Several per booking/order lifecycle step | Business state, necessary |
| Editorial audit log | 1 per key editorial action | Best-effort |
| Learner reads | **0** | Learner pages no longer write; progress and enrolment status reconcile only on write paths (`markLessonComplete`, admin curriculum edits), per comments in `progress/service.ts` and `learn/page.tsx` |

## 3. Route rendering (from `npm run build`)

Static (○) means served from prerender/cache with no D1 read at request time. Dynamic (ƒ) renders per request on the Worker.

| Type | Routes |
|---|---|
| ○ Static | `/`, `/about`, `/contact`, `/cookies`, `/field-notes`, `/guides`, `/login`, `/privacy`, `/programmes`, `/robots.txt`, `/signup`, `/terms`, `/_not-found` |
| ○ Static, timed ISR (`revalidate = 300`) | `/mission-01`, `/ai-recruiter-os` |
| ○ Static, timed ISR (`revalidate = 300`), live part client-side | `/coaching`, `/workshop` |
| ● ISR on demand (`generateStaticParams` returns `[]`, `revalidate = 3600`) | `/guides/[slug]`, `/field-notes/[slug]` |
| ƒ Dynamic public | `/api/public/booking-slots` (live slots, `no-store`, reads only), `/preview/guides/[slug]`, `/preview/field-notes/[slug]` (staff preview, session read), `/sitemap.xml`, other `/api/*` |
| ƒ Dynamic private | `/admin/*` (all, plus `/admin/login`), `/learn`, `/learn/courses`, `/learn/courses/[courseSlug]`, `/learn/courses/[courseSlug]/lessons/[lessonSlug]` |

Observations:
- `/guides` and `/field-notes` are ○ but are **prerendered from the build machine's D1** and refreshed by `revalidatePath()` on publish (R2 incremental cache). They need a revalidation strategy before launch (DEPLOYMENT.md).
- `/guides/[slug]` and `/field-notes/[slug]` no longer read `searchParams`. They render the published article only, cache in the R2 incremental cache and are refreshed by `revalidatePath("/guides/<slug>")` on create, edit, publish, unpublish and archive (Studio actions), on a slug **rename** (the old slug is revalidated too so it becomes a 308), and on editorial-AI publish (`publishDraftAction`). `revalidate = 3600` is only a safety net. Slug redirects (`permanentRedirect` from `slug_redirects`) and 404s for unpublished content still run inside the cached render; 404s are not cached (`no-store`), 308s and 200s are.
- Staff preview (`?preview=true`) is rewritten in `next.config.ts` (`beforeFiles`, matches `has: query preview=true`) to `/preview/guides/[slug]` and `/preview/field-notes/[slug]`, which are `force-dynamic`, read the session, return 404 to anyone who is not an admin, and are `noindex`. The browser URL is unchanged. Verified with `opennextjs-cloudflare preview`: published article `x-nextjs-cache: MISS` then `HIT`; `?preview=true` is `private, no-store`.
- `/contact` reads `?reason=` in a client component (`useSearchParams` inside `<Suspense>`), which only selects the form variant and the `audiencePath` bound into the `submitLead` action (server-validated, max 80 chars). The static fallback is the generic contact form.
- `/mission-01` and `/ai-recruiter-os` were `force-dynamic` only because they read the offer row; there is no per-request input, so they are ISR (`revalidate = 300`) and `refreshCommerce()` revalidates them on every Studio offer or booking-type change.
- `/coaching` and `/workshop` were `force-dynamic` (before: ƒ) because `resolvePublicSchedulingModel()` reads live availability, bookings and slot holds. They are now a cached shell (after: ○, `revalidate = 300`, 5m / 1y expire in the build table) plus a small live part:
  - The page only reads configuration through `resolvePublicSchedulingConfig()` (offer + booking type: eligible or not, title, duration, timezone). `refreshCommerce()` revalidates both paths on every Studio offer or booking-type change.
  - `<PublicScheduler>` (client) fetches `GET /api/public/booking-slots?offer=coaching|workshop` (same-origin, `Cache-Control: no-store`, zod-validated query limited to the two public offer slugs). The handler (`features/scheduling/public-slots-handler.ts`) reuses `resolvePublicSchedulingModel()`; slot logic is not duplicated. It is reads only (about 5 small D1 queries, at most 60 slots, bounded probe window), so it has **no rate-limit counter**: a counter would make every GET a D1 write. Revisit with a Cloudflare rate-limiting rule if abused.
  - UI states: loading, error (with retry), "not available" (offer/booking type changed since the shell was cached, calendar provider unverifiable, or booking type mismatch), empty, and ready. A `SLOT_UNAVAILABLE` submit result re-fetches the list in place instead of `router.refresh()`.
  - Unchanged: slot validation, hold acquisition, admission limits and analytics all stay in `submitPublicBooking` / `recordPublicBookingStarted`.
  - Trade-off: the hero CTA ("Choose a time" vs the enquiry form) and whether the scheduler section exists now follow the cached configuration (up to 5 minutes stale, or the build machine's D1 until the first revalidation), not the live calendar-provider state. A provider outage shows the "not available" state inside the section instead of hiding it.

## 4. Client JavaScript (approximate, gzip)

Method: gzip each chunk in `.next/static/chunks` and sum the chunks listed in `build-manifest.json` `rootMainFiles` (webpack runtime, framework, `main-app`, one shared chunk) plus the extra chunks named in each route's client reference manifest. This is an upper-bound estimate of JS the route can load; it is not a Lighthouse number. Polyfills (about 38.7 KiB gz) load only for legacy browsers (`nomodule`).

| Scope | Gzip |
|---|---|
| All static JS in the build (73 files) | about 384 KiB (1229 KiB raw) |
| Shared app shell (`rootMainFiles`) | about 130 KiB |
| Home `/`, `/about`, `/guides`, `/privacy`, etc. | shell plus about 20 KiB |
| `/coaching`, `/workshop` | shell plus about 27-28 KiB (re-measure; the scheduler now includes the fetch and state logic) |
| `/login`, `/signup` | shell plus about 34 KiB (auth client) |
| `/learn/*` | shell plus about 33 KiB |
| `/admin/*` | shell plus about 35-57 KiB (`/admin/content` 57, `/admin/editorial/memory` 54, structured block editor) |

A numeric JS budget is not defined yet. Proposal: public pages <= 170 KiB gz total initial JS (shell plus route), learner <= 200 KiB, admin exempt but tracked; enforce in CI from the manifests with a small script like the worker-size check.

## 5. Images

`public/images` is 856 KB on disk across 9 files (largest 172 KB).

| File | Size |
|---|---|
| ahmed-awad-editorial-signal-v1.webp | 172 KB |
| ahmed-coaching-conversation-cinematic.jpg | 124 KB |
| mission-01-ahmed-v2-optimized.jpg | 124 KB |
| workshop-ahmed-identity-v2.jpg | 104 KB |
| ai-recruiter-os-portrait-v2.jpg | 84 KB |
| ahmed-awad-hero-human-signal-v1.webp | 76 KB |
| ahmed-awad-studio-source.webp | 72 KB |
| ahmed-about-window-portrait.webp | 56 KB |
| ahmed-workshop-conversation.webp | 44 KB |

- Pages use `next/image` (`workshop`, `mission-01`, `about`, `ai-recruiter-os`, `coaching`), with `priority` on four of them. Field Note articles use a raw `<img>` (`field-notes/[slug]/page.tsx`).
- There is **no `IMAGES` binding**, so `/_next/image` returns the original file with no resizing or format conversion (DEPLOYMENT.md). Responsive `srcset` therefore does not shrink bytes today. Four images are still JPEG (not modern format).
- Editorial media uploads are capped at 5 MB with no server-side resize.
- Fonts: `--font-ui` / `--font-display` CSS variables are used; no `next/font` or external font import was found, so font loading strategy is unverified.

## 6. Not measured yet: how to measure

| Gap | Proposal |
|---|---|
| Lighthouse (LCP, CLS, TBT, JS weight) | Add a CI job running Lighthouse CI against `npm run preview` (built Worker, local D1) for `/`, `/guides`, a seeded article, `/coaching`, mobile emulation, with assertions at the section 1 targets (warn first, fail later). Lab data only |
| Field Core Web Vitals (LCP, INP, CLS, p75) | `web-vitals` library or Cloudflare Web Analytics / Zaraz after deploy; report to PostHog or an aggregate. Tag by route and country. Needs a cookie/consent decision |
| TTFB from EG/SA/AE | Cloudflare edge colo is not the user; use WebPageTest or Cloudflare Observatory with Cairo, Riyadh/Jeddah, Dubai locations, or a scheduled synthetic check from three regions. Record cache status (`cf-cache-status`) separately for HIT and MISS |
| Cache-hit DB reads | Add a test that renders each ○ route with D1 stubbed to throw; log D1 query counts per route in `preview` |
| Worker CPU per request | `wrangler tail` / Workers Logs CPU time on the deployed Worker, or `wrangler dev` timing; decide Free vs Paid from p95 of dynamic routes |
| D1 row reads/writes per day | Cloudflare dashboard D1 metrics after deploy; alert at 50% of daily allowance |
| JS budget | Script over `.next/build-manifest.json` plus client reference manifests (section 4 method) as a CI check |
| Image weight | CI check on `public/images` total and per-file size; add Cloudflare Images (or pre-generated variants) before launch |
