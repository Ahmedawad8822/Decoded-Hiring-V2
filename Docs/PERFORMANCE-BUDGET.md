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
| Worker size (gzip) | Workers Free 3072 KiB; CI budget **2950 KiB** | 2.82 MiB (about 2888 KiB) gzipped, 12.57 MiB total, per `Docs/Engineering/DEPLOYMENT.md` (2026-10-24) | CI job `worker-size` (`npm run cf:build`, `npm run cf:size`, `scripts/check-worker-size.ts`); fails the PR |
| Worker CPU | Workers Free: **10 ms per request** | Not measured. Dynamic SSR (learner, Studio, booking) likely exceeds it | None. Expect Workers Paid or measure first (DEPLOYMENT.md risks) |
| Workers requests | 100,000/day (Free) | Not measured | None |
| D1 reads | 5 M rows/day (Free) | Not measured | None |
| D1 writes | 100 k rows/day (Free) | Not measured | None; writes are designed down (below) |
| D1 storage | 5 GB | Not measured | None |
| R2 | 10 GB-month; 1 M Class A, 10 M Class B ops/month | Not measured | None |

### How D1 writes are spent

| Writer | Writes per event | Notes |
|---|---|---|
| Public rate limits (`public_rate_limits`) | 1 upsert per consume | Leads: 2 (email plus kind). Bookings: 2. Analytics: 1. Rows never pruned (security gap G5) |
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
