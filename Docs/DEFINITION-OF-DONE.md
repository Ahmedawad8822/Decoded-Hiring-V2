# Definition of Done

The six permanent quality gates (blueprint §15), made checkable for this repo. A feature is not done until every gate that applies to it passes. Vocabulary follows `Docs/CONTEXT.md`.

**Rule for agents (blueprint §14):** if a feature is included, build the complete workflow. If it cannot be completed properly yet, leave it out of the release rather than ship placeholder-grade admin.

## How to read the tables

| Marker | Meaning |
|---|---|
| **CI** | Enforced automatically on every PR and push to `main` by `.github/workflows/ci.yml` |
| **Review** | A human or reviewer agent must check it; nothing automated catches it |
| **Gap** | Required by the blueprint, **not automated or not built yet** |

## What CI runs today

| Job | Step | Command |
|---|---|---|
| `verify` | Lint (zero warnings) | `npm run lint` |
| `verify` | Typecheck | `npm run typecheck` (`next typegen && tsc --noEmit`) |
| `verify` | Unit/integration tests, each suite on its own throwaway local D1/R2 | `npm test` |
| `verify` | Apply local D1 migrations, then production build | `npm run db:migrate:local`, `npm run build` |
| `e2e` (after `verify`) | Playwright (Chromium) | `npm run test:e2e:ci` |

`test:e2e:ci` runs three specs: `mission-08-final-certification`, `field-notes`, `smoke`. The `mission-06-learning-platform` and `mission-07-editorial-ai` specs exist in `e2e/` but do **not** run in CI; run them locally when you touch those areas (`npm run test:e2e`; needs `.env.local` admin vars, see `.env.example`).

CI uses fake secrets and local Miniflare D1/R2 only. It never contacts real services.

Before opening a PR run the same gates locally: `npm run lint`, `npm run typecheck`, `npm test`, `npm run db:migrate:local && npm run build` (with `BETTER_AUTH_SECRET` set), plus the relevant Playwright spec. When you add a test suite, append it to the `test` script in `package.json`.

---

## 1. Functional

The full intended workflow works, including dependencies, persistence and recovery from failure.

| Check | Enforced by |
|---|---|
| Lint, types and build pass | **CI** |
| Domain rules covered by a suite on an isolated D1 (state transitions, idempotency, concurrency) | **CI** (`npm test`); **Review** that a new suite was added and listed in `package.json` |
| Happy path works end to end in a browser | **CI** for the three specs above; **Review** for other areas (run the relevant spec locally) |
| Lifecycle is defined: Draft/Publish/Archive behave as in `CONTEXT.md`; permanent delete and Trash are not built, so do not imply them | **Review** |
| Failure paths recover: retries are idempotent, a second submit does not duplicate, provider outage does not strand an Order or Booking | **Review**, backed by orchestration/idempotency tests |
| Docs updated: `Docs/PROJECT-STATUS.md` (see below) and any mission or spec doc | **Review** |

## 2. UX

Obvious, consistent, responsive, accessible enough for the audience, with empty, loading and error states.

| Check | Enforced by |
|---|---|
| Empty, loading and error state exists for every new list/form/page | **Review** |
| Mobile and desktop both checked (Learner and public pages are mobile-first) | **Review** |
| Copy uses glossary terms; no broken checkout is shown when no payment provider is active | **Review** |
| Keyboard operable, labelled controls, visible focus, sensible heading order | **Review** |
| Automated accessibility checks (axe or equivalent) | **Gap**: none configured |
| Visual regression | **Gap**: none configured (manual notes in `Docs/QA/`) |

## 3. Security

Authentication/authorization, validation, uploads, destructive actions and abuse cases are covered.

| Check | Enforced by |
|---|---|
| Server-side authorization on every action and route: admin role for Studio, ownership/enrollment for Classroom (`hasLearnerAccess`); never trust client-supplied roles | **CI** partly (`tests/auth-gates.test.ts` and domain suites); **Review** for new surfaces |
| Inputs validated with schemas (Zod); queries via Drizzle; redirects through `safe-redirect` | **Review** |
| Uploads: MIME/content check, size limit, server-generated storage key, private storage for Lesson Resources | **Review**, backed by upload tests |
| Errors never leak internals (see error convention below) | **Review** |
| Public abuse-prone endpoints are rate limited (booking, leads, telemetry use the D1 limiter) | **Review** |
| Secrets only in environment/bindings, never in code, D1 or client bundles | **Review** |
| Security headers set in `next.config.ts` (nosniff, frame, referrer, permissions, COOP/CORP, HSTS) | **CI** only as part of the build |
| Content-Security-Policy | **Gap**: not set |
| Turnstile; rate limits on Better Auth sign-in/sign-up | **Gap**: not wired |
| Audit trail for high-impact admin mutations | **Review**; exists for editorial AI, commerce and booking history, not universal |

### High-risk change policy (blueprint §17.4)

Changes touching any of the following **never self-merge or self-promote; they need Ahmed's explicit approval**:

- authentication and authorization
- payments and the commerce/Order truth model
- database schema changes and any data deletion
- security controls (headers, rate limits, upload rules)
- secrets and credentials
- admin permissions
- destructive operations (including Trash/permanent delete when built)

Also approval-gated: merging a mission to `main`, any deploy or production resource change, activating a provider (payment, calendar, mailbox, meeting, analytics), and public publication at launch. Mark such PRs clearly and stop for sign-off.

## 4. Performance

Stays inside the agreed budgets and adds no unjustified client or runtime weight. Budgets are from blueprint §9.

| Metric | Target |
|---|---|
| LCP (mobile p75) | ≤ 1.5 s |
| INP (mobile p75) | ≤ 200 ms |
| CLS | ≤ 0.05 |
| Cached public TTFB | < 200 ms from target markets |
| Public DB reads on a cache hit | 0 where practical |
| Initial JS | Aggressively small; every client dependency needs a reason |
| Images | Responsive, modern formats, correct dimensions, lazy-load below the fold |
| Third-party scripts | None render-blocking |
| Test locations | Include Egypt, Saudi Arabia and UAE |

| Check | Enforced by |
|---|---|
| Server-first rendering; client components only for real interactivity | **Review** |
| New client dependency has a stated reason | **Review** |
| Images are WebP/AVIF at right size (hero PNGs already converted) | **Review** |
| No analytics or marketing script added outside the planned central tag layer | **Review** |
| Lighthouse / Core Web Vitals check, bundle-size budget | **Gap**: not in CI |
| Worker size and CPU limits (`Docs/Engineering/DEPLOYMENT.md`: 2.78 MiB of 3 MiB gzipped on Workers Free) | **Review** at deploy time |
| Regional (EG/SA/AE) measurement | **Gap**: nothing set up |

A feature that materially breaks the budget fails this gate until justified or fixed.

## 5. Discoverability

For public content: crawlability, metadata, structured semantics, internal linking and discovery mechanics.

| Check | Enforced by |
|---|---|
| Canonical URL, title, description, Open Graph via shared SEO helper (`src/lib/seo.tsx`) | **Review** |
| Page is in the sitemap and `robots` rules are intended (`src/app/sitemap.ts`, `robots.ts`) | **Review** |
| Structured data only where appropriate (Article/Organization/Breadcrumb); no schema spam | **Review** |
| Internal links to related content; slug changes noted (no redirects exist yet) | **Review** |
| Archived/unpublished content leaves the sitemap and public navigation | **Review** |
| Broken-link check | **Gap**: not automated |
| IndexNow, AI-crawler policy review | **Gap**: not built |

## 6. Measurability

Agreed events/KPIs, consent behaviour, failure observability, enough instrumentation to prove it works.

| Check | Enforced by |
|---|---|
| New funnel step emits a Business Event, using an existing name from `BUSINESS_EVENT_NAMES` where one fits; no near-duplicate event names | **Review** |
| Failures are logged server-side and surfaced safely (no silent catch) | **Review** |
| Consent respected for any analytics/marketing tool | **Gap**: no analytics provider is active and no consent layer exists |
| Canonical event dictionary (`ANALYTICS-EVENTS.md`) | **Gap**: not written; blueprint taxonomy and code names differ (see `CONTEXT.md`) |
| Page-level analytics, Command Center, alerting on regressions | **Gap**: not built |

---

## Error-handling convention

- **User-facing failure:** throw `AppError(kind, message)` from `src/lib/errors.ts`. Kinds: `unauthorized`, `forbidden`, `not_found`, `invalid`, `conflict`. The message is written for end users and may be shown verbatim.
- **Server actions** return `ActionResult<T>` (`{ ok: true; data } | { ok: false; error }`) via `toActionResult(run, fallback)` from `src/lib/action-result.ts`. Do not throw out of an action: Next.js hides or leaks the message. Zod errors are summarised; any other error is logged and replaced by the fallback text.
- **Route handlers** use `publicErrorMessage(error, fallback)` and `httpStatusFor(error)`.
- **Internal errors** (SQL, driver, provider, bugs) are logged server-side only. The caller sees a generic fallback.
- **Mission 08 domains** use their own typed errors with stable codes and safe fallbacks: `SchedulingDomainError`, `CommerceDomainError`, `LeadDomainError`, and `SchedulingProviderError` for provider adapters. Map them to user-safe text at the boundary; do not display `error.message` from provider errors.

## Updating `Docs/PROJECT-STATUS.md`

Update it **last** in every task that changes code, branches, PRs or plans: snapshot, branch/PR map, next-steps queue and a session-log entry (newest first). Keep it short and factual. If it disagrees with the code or GitHub, fix it. Update `Docs/CONTEXT.md` when you add or rename a domain term or state.

## Reviewer checklist (copy into PR)

- [ ] CI green (verify + E2E); relevant non-CI Playwright spec run locally
- [ ] Tests added and listed in `package.json`
- [ ] Authorization and validation on every new action/route
- [ ] Errors use `AppError` / `ActionResult` / domain errors; no raw messages leak
- [ ] Empty, loading, error states; mobile checked
- [ ] Performance: no unjustified client JS or images
- [ ] Public pages: metadata, sitemap, internal links
- [ ] Business Event / observability considered
- [ ] High-risk category? If yes, Ahmed approval recorded
- [ ] `Docs/PROJECT-STATUS.md` (and `CONTEXT.md` if vocabulary changed) updated
