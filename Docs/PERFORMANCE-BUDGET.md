# Performance budget

Blueprint §9 ("Flashlight Speed" as a budget) and §18.9 (free-first guardrails). Status: **budgets defined, only build-time and platform-size measurements exist.** Measured on 2026-10-24 with Next 16.4.2 (webpack), `npm run build` against a freshly migrated local D1. A feature that materially breaks a budget should fail the quality gate until justified or corrected.

## 1. User-facing budgets (blueprint §9)

| Metric / rule | Target | Measured today | Enforced today |
|---|---|---|---|
| LCP (mobile p75) | <= 1.5 s | Not measured | No |
| INP (mobile p75) | <= 200 ms | Not measured | No |
| CLS | <= 0.05 | Not measured | No |
| Cached public TTFB | < 200 ms from target markets | Not measured | No |
| Public DB reads on a cache hit | 0 where practical | Static and ISR routes: 0 at request time (see section 3). Dynamic public routes (`/coaching`, `/workshop`, preview) read D1 | No |
| Initial JS | Aggressively small | See section 4 | No |
| Images | Responsive, modern formats, correct dimensions, lazy below the fold | See section 5 | No |
| Third-party scripts | No render-blocking analytics/marketing | None found in `src` (no `<script>` except JSON-LD in `src/lib/seo.tsx`; no external font/CSS import found) | By absence only |
| Test locations | Egypt, Saudi Arabia, UAE | Not measured | No |

## 2. Platform budgets that exist today

| Budget | Limit | Current | Enforcement |
|---|---|---|---|
| Worker size (gzip) | Workers Free 3072 KiB; CI budget **2950 KiB** | 2867.94 KiB gzipped, 12795.73 KiB total upload, local `npm run cf:build && npm run cf:size` (2026-11-08) | CI job `worker-size` (`npm run cf:build`, `npm run cf:size`, `scripts/check-worker-size.ts`); fails the PR |
| Worker CPU | Workers Free: **10 ms per request** | Not measured. Learner content preparation now uses the shared Data Cache; session gates, progress and React SSR still run per request. Studio and booking remain dynamic | None. Expect Workers Paid or measure first (DEPLOYMENT.md risks) |
| Workers requests | 100,000/day (Free) | Not measured | None |
| D1 reads | 5 M rows/day (Free) | Not measured | None |
| D1 writes | 100 k rows/day (Free) | Not measured | None; writes are designed down (below) |
| D1 storage | 5 GB | Not measured | None |
| R2 | 10 GB-month; 1 M Class A, 10 M Class B ops/month | Not measured | None |

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
| ● ISR on demand (`generateStaticParams` returns `[]`, `revalidate = 3600`) | `/guides/[slug]`, `/field-notes/[slug]` |
| ƒ Dynamic public | `/coaching`, `/workshop` (`force-dynamic`, live scheduling), `/preview/guides/[slug]`, `/preview/field-notes/[slug]` (staff preview, session read), `/sitemap.xml`, `/api/*` |
| ƒ Dynamic private | `/admin/*` (all, plus `/admin/login`), `/learn`, `/learn/courses`, `/learn/courses/[courseSlug]`, `/learn/courses/[courseSlug]/lessons/[lessonSlug]` |

Observations:
- `/guides` and `/field-notes` are ○ but are **prerendered from the build machine's D1** and refreshed by `revalidatePath()` on publish (R2 incremental cache). They need a revalidation strategy before launch (DEPLOYMENT.md).
- `/guides/[slug]` and `/field-notes/[slug]` no longer read `searchParams`. They render the published article only, cache in the R2 incremental cache and are refreshed by `revalidatePath("/guides/<slug>")` on create, edit, publish, unpublish and archive (Studio actions), on a slug **rename** (the old slug is revalidated too so it becomes a 308), and on editorial-AI publish (`publishDraftAction`). `revalidate = 3600` is only a safety net. Slug redirects (`permanentRedirect` from `slug_redirects`) and 404s for unpublished content still run inside the cached render; 404s are not cached (`no-store`), 308s and 200s are.
- Staff preview (`?preview=true`) is rewritten in `next.config.ts` (`beforeFiles`, matches `has: query preview=true`) to `/preview/guides/[slug]` and `/preview/field-notes/[slug]`, which are `force-dynamic`, read the session, return 404 to anyone who is not an admin, and are `noindex`. The browser URL is unchanged. Verified with `opennextjs-cloudflare preview`: published article `x-nextjs-cache: MISS` then `HIT`; `?preview=true` is `private, no-store`.
- `/contact` reads `?reason=` in a client component (`useSearchParams` inside `<Suspense>`), which only selects the form variant and the `audiencePath` bound into the `submitLead` action (server-validated, max 80 chars). The static fallback is the generic contact form.
- `/mission-01` and `/ai-recruiter-os` were `force-dynamic` only because they read the offer row; there is no per-request input, so they are ISR (`revalidate = 300`) and `refreshCommerce()` revalidates them on every Studio offer or booking-type change.
- `/coaching` and `/workshop` stay `force-dynamic` on purpose: `resolvePublicSchedulingModel()` reads live availability windows, bookings and slot holds relative to the current time and (when a calendar provider is configured) checks provider availability. A cached copy would show stale or taken slots. Making them cacheable would mean moving the slot picker into a client component that fetches slots from an API route (proposal, not built).

### Learner content Data Cache (2026-11-08)

The course overview and lesson player remain dynamic routes. They use
`unstable_cache` from the installed Next 16.4.2 without enabling Cache Components
or changing app-wide rendering. `use cache` / `cacheTag` require that opt-in in
this version. Cache entries have no timed expiry (`revalidate: false`); every
live content-write entry point expires their tags with
`revalidateTag(tag, { expire: 0 })`, so the next read blocks for fresh data rather
than serving stale-while-revalidate content.

| Work | Before | Now |
|---|---|---|
| Session, course visibility/status and enrollment/access checks | Every request | Every request, outside the cache; archived courses still require an entitled learner |
| Lesson publication/slug lookup | Full lesson row on each request (also metadata) | Live identity/title/slug projection only, before any protected cache read; draft/archived lessons still 404 |
| Body preparation | JSON parse on each lesson render | Parsed `ContentBlock[]` per lesson, tagged `lesson:<id>` and `course:<id>`; no raw body retained in the prepared entry |
| Video and resources | YouTube URL normalization, resource query and display sizing on every render | Prepared embed URL and resource id/title/size labels in the lesson entry; no storage keys or PDF bytes cached |
| Curriculum and navigation | Two curriculum queries plus grouping per page, then two more through progress | Published lesson summaries grouped by ordered section, flat list and previous/next positions cached per course under `course:<id>`; no draft bodies or summaries included |
| Progress/completion and resume UI | Per enrollment | Completion rows and progress calculations remain per request; pages reuse the shared curriculum input without querying it again |
| Course overview metadata and offer/access policy | Per request | Per request, preserving live lifecycle/access behavior and avoiding a second invalidation dependency on Offers |
| JSX / inline formatting / response rendering | Per request | Still per request; prepared data is cached, not HTML or React elements |

The course loader queries sections and published lesson summaries only; the
lesson loader queries the published body and its resources only on a miss.
Lesson cache keys contain course/lesson ids, and curriculum keys contain the
course id, never learner/session identifiers. Dynamic course and lesson slug
checks stay live, so renames still use the existing redirect service.

Invalidation coverage (all application entry points; services stay usable by
offline scripts and isolated DB tests):

| Entry point | Service write | Tags expired |
|---|---|---|
| `createCourseAction`, `updateCourseAction` | `createCourse`, `updateCourse` (including title/description/access mode/slug/cover) | `course:<id>` |
| `publishCourseAction`, `unpublishCourseAction`, `archiveCourseAction` | Corresponding course lifecycle services | `course:<id>` |
| `createSectionAction`, `renameSectionAction`, `moveSectionAction` | `createSection`, `renameSection`, `moveSection` | Parent `course:<id>` |
| `createLessonAction`, `updateLessonAction` | `createLesson`, `updateLesson` (including body/title/slug/video/required) | `lesson:<id>` and parent `course:<id>` |
| `publishLessonAction`, `unpublishLessonAction`, `moveLessonAction` | `publishLesson`, `unpublishLesson`, `moveLesson` | `lesson:<id>` and parent `course:<id>` |
| `POST /api/course-resources/upload` | `uploadCourseResource` (the only resource write; delete/replace/reorder do not exist) | `lesson:<id>` and parent `course:<id>` |

Lesson edits/lifecycle/moves invalidate in a `finally` boundary: a service can
commit a lesson change and then fail enrollment reconciliation, and that error
must not leave the old shared entry valid. Course-wide invalidation also covers
the other lesson affected by a move. There is no lesson archive/delete or
section delete service today; future write paths must use the same invalidator.
Direct DB edits/offline scripts bypass Next revalidation and need an explicit
invalidation or cache reset before serving traffic.

**Cloudflare backing:** R2 remains the incremental data store. OpenNext's
installed `d1-next-tag-cache` replaces the previous dummy tag cache. Both Wrangler
configs (and the production environment) bind `NEXT_TAG_CACHE_D1` to the same
D1 database as `DB`. OpenNext `populateCache` (used by preview/deploy) owns and
creates the `revalidations` table; it is not an application Drizzle migration.
Production placeholders must resolve both bindings to the same database.
Tag lookups add D1 reads, and invalidations add writes only on content changes;
a cache hit does **not** mean zero D1 reads for these protected routes.

**Evidence and remaining measurement:** `tests/lesson-content-cache.test.ts`
uses the isolated D1/R2 bootstrap, real authenticated actions and page functions,
and direct data-preparation checks. Plain `tsx` reports `incrementalCache missing`
for the real Next cache API, so the suite uses a deterministic cache double to
check keys/tags, warm reads and edit/publish/unpublish/upload invalidation. It
also exercises the installed OpenNext D1 tag adapter against the local binding.
These are wiring/data/security checks, not browser or deployed cache-hit proof.
The local production Next/OpenNext build passes and both learner routes remain
ƒ dynamic; the Worker passes the 2950 KiB gzip size gate at 2867.94 KiB.
No deployed Worker CPU measurement exists: this change removes repeated shared
preparation but does **not establish** compliance with the Free plan's 10 ms
budget. Measure warm and cold requests (including auth, tag lookups and React
SSR) on the built/deployed Worker before claiming that budget is met.

## 4. Client JavaScript (approximate, gzip)

Method: gzip each chunk in `.next/static/chunks` and sum the chunks listed in `build-manifest.json` `rootMainFiles` (webpack runtime, framework, `main-app`, one shared chunk) plus the extra chunks named in each route's client reference manifest. This is an upper-bound estimate of JS the route can load; it is not a Lighthouse number. Polyfills (about 38.7 KiB gz) load only for legacy browsers (`nomodule`).

| Scope | Gzip |
|---|---|
| All static JS in the build (73 files) | about 384 KiB (1229 KiB raw) |
| Shared app shell (`rootMainFiles`) | about 130 KiB |
| Home `/`, `/about`, `/guides`, `/privacy`, etc. | shell plus about 20 KiB |
| `/coaching`, `/workshop` | shell plus about 27-28 KiB |
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
| Field Core Web Vitals (LCP, INP, CLS, p75) | `web-vitals` library or Cloudflare Web Analytics / Zaraz (blueprint §18.9 lists Zaraz at 1 M free events) after deploy; report to PostHog or an aggregate. Tag by route and country. Needs a cookie/consent decision |
| TTFB from EG/SA/AE | Cloudflare edge colo is not the user; use WebPageTest or Cloudflare Observatory with Cairo, Riyadh/Jeddah, Dubai locations, or a scheduled synthetic check from three regions. Record cache status (`cf-cache-status`) separately for HIT and MISS |
| Cache-hit DB reads | Add a test that renders each ○ route with D1 stubbed to throw; log D1 query counts per route in `preview` |
| Worker CPU per request | `wrangler tail` / Workers Logs CPU time on the deployed Worker, or `wrangler dev` timing; decide Free vs Paid from p95 of dynamic routes |
| D1 row reads/writes per day | Cloudflare dashboard D1 metrics after deploy; alert at 50% of daily allowance |
| JS budget | Script over `.next/build-manifest.json` plus client reference manifests (section 4 method) as a CI check |
| Image weight | CI check on `public/images` total and per-file size; add Cloudflare Images (or pre-generated variants) before launch |
