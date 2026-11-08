# Definition of Done

Quality checks for contributors. A feature is done when its applicable checks pass; document any remaining limitations.

**Workflow completeness:** if a feature is included, build the complete workflow. If it cannot be completed properly yet, leave it out of the release rather than ship placeholder-grade admin.

## How to read the tables

| Marker | Meaning |
|---|---|
| **CI** | Enforced automatically on every PR and push to `main` by `.github/workflows/ci.yml` (or by `audit.yml` where stated) |
| **Review** | A human or reviewer agent must check it; nothing automated catches it |
| **Gap** | Expected but **not automated or not built yet** |

## What CI runs today

| Job | Step | Command |
|---|---|---|
| `verify` | Lint (zero warnings) | `npm run lint` |
| `verify` | Typecheck | `npm run typecheck` (`next typegen && tsc --noEmit`) |
| `verify` | Unit/integration tests, each suite on its own throwaway local D1/R2 | `npm test` |
| `verify` | Apply local D1 migrations, then production build | `npm run db:migrate:local`, `npm run build` |
| `e2e` (after `verify`) | Playwright (Chromium), 40-minute timeout | `npm run test:e2e:ci` |
| `worker-size` (after `verify`) | Apply local D1 migrations, OpenNext build, uncompressed Worker must stay within **20480 KiB** (Free/Paid limit 64 MiB; gzip informational only) | `npm run db:migrate:local`, `npm run cf:build`, `npm run cf:size` |
| `audit.yml` `npm-audit` | Production dependencies, high and critical advisories fail the job; runs on PRs, pushes to `main` and weekly | `npm audit --omit=dev --audit-level=high` |

`test:e2e:ci` runs **seven** specs, all of `e2e/`: `mission-08-final-certification`, `field-notes`, `smoke`, `mission-06-learning-platform`, `mission-07-editorial-ai`, `csp`, `admin-security`. A new spec must be appended to that script, or it does not run in CI. `npm run test:e2e` runs them locally (needs `.env.local` admin vars, see `.env.example`).

Not CI-gated: `codeql.yml` remains manual (`workflow_dispatch`). Dependabot (`.github/dependabot.yml`: weekly, 7-day cooldown, grouped minor/patch, majors of framework packages ignored) opens update PRs that go through the normal CI.

CI uses fake secrets and local Miniflare D1/R2 only. It never contacts real services.

### Test environment rules

| Rule | Detail |
|---|---|
| **Suite registration** | `npm test` is an explicit `&&` chain of `tsx tests/<name>.test.ts` (34 suites today), not a glob. A suite not appended to the `test` script in `package.json` does not run in CI. Concurrent PRs conflict on that line; keep both entries |
| **E2E registration** | Same for `test:e2e:ci`: append `playwright test e2e/<name>.spec.ts || status=1` |
| **Migration registration** | Schema change: edit `src/lib/db/schema.ts`, `npm run db:generate`, commit the SQL **and** `meta/` (hand-written SQL must also be in `meta/_journal.json`). Migrations today: `0000` to `0023_business_events_retention_index`. Parallel PRs collide on the number; regenerate the later one after the earlier merges. Add a regression test; this is a high-risk change |
| **`clickAction` / `waitForHydration`** | Playwright clicks on SSR markup before React hydrates are silently lost, and hydration resets controlled inputs. Import both from `e2e/helpers/actions.ts`: `waitForHydration(page, locator)` before filling a form, `clickAction(page, target)` for every action button (asserts enabled, waits for hydration, then clicks). No bare `.click()` on action buttons, no `networkidle`, no `waitForFunction` on `readyState` |
| **`ADMIN_REQUIRE_2FA`** | Admin 2FA is enforced unless the variable is exactly `"false"` (`isAdmin2faRequired()` in `src/lib/auth/index.ts`). Playwright's web server (`playwright.config.ts`) and `.env.example` set it to `false`; `tests/helpers/env.ts` does **not**. A unit suite that signs in as an admin or calls `requireAdmin()` with a real admin session must set `process.env.ADMIN_REQUIRE_2FA = "false"` itself (as `tests/admin-audit-trail.test.ts` does) unless it is testing the 2FA gate (`tests/admin-two-factor.test.ts`). Never set it in production |

Before opening a PR run the same gates locally: `npm run lint`, `npm run typecheck`, `npm test`, `npm run db:migrate:local && npm run build` (with `BETTER_AUTH_SECRET` set), plus the relevant Playwright spec. When you add a test suite, append it to the `test` script in `package.json`.

---

## 1. Functional

The full intended workflow works, including dependencies, persistence and recovery from failure.

| Check | Enforced by |
|---|---|
| Lint, types and build pass | **CI** |
| Domain rules covered by a suite on an isolated D1 (state transitions, idempotency, concurrency) | **CI** (`npm test`); **Review** that a new suite was added and listed in `package.json` |
| Happy path works end to end in a browser | **CI** for the seven specs above; **Review** for areas none of them cover (add a spec) |
| Lifecycle is defined: Draft/Publish/Archive behave as in `CONTENT-MODEL.md`; permanent delete and Trash are not built, so do not imply them | **Review** |
| Failure paths recover: retries are idempotent, a second submit does not duplicate, provider outage does not strand an Order or Booking | **Review**, backed by orchestration/idempotency tests |
| Docs updated: the relevant public implementation references | **Review** |

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
| Public abuse-prone endpoints are rate limited with the D1 limiter: booking, leads and analytics check a salted per-IP bucket (`PUBLIC_IP_LIMITS`) before the shared email/kind/global counters; Better Auth sign-in, sign-up, 2FA verify and password flows are 5/min/IP | **Review**, backed by `tests/auth-rate-limit.test.ts` and the public-intake suites |
| Secrets only in environment/bindings, never in code, D1 or client bundles | **Review** |
| Security headers set in `next.config.ts` (nosniff, frame, referrer, permissions, COOP/CORP, HSTS) | **CI** only as part of the build |
| Content-Security-Policy (static header; any new script, font, frame, image or connect origin updates the CSP, `Docs/ENGINEERING-STANDARDS.md` section 9 and `e2e/csp.spec.ts` together) | **CI** (`csp` spec) |
| Admin 2FA: new admin pages call `requireAdminPage()` and new admin actions/routes call `requireAdmin()`, which enforce TOTP; only `/admin/security` passes `allowWithout2fa` | **CI** (`tests/admin-two-factor.test.ts`, `admin-security` spec); **Review** for new surfaces |
| Audit trail: every **new admin mutation** (create, update, publish, archive, delete, upload) records a row with `recordAdminAudit()` from `src/features/audit/service.ts`, adding the entity to `AUDIT_ENTITY_TYPES` if new. Prefer `buildAdminAuditStatement()` inside the mutation's D1 batch when the actor is available. Entities covered today: guide, field note, course, section, lesson, lesson resource, media, offer, booking type, availability window | **Review**, backed by `tests/admin-audit-trail.test.ts`. Booking decisions and orders keep their own history tables; `editorial_audit_log` is separate and best-effort |
| Turnstile; passkeys; CSRF/origin test | **Gap**: not wired / not built |

### High-risk change policy

Changes touching any of the following **never self-merge or self-promote; they need the owner's explicit approval**:

- authentication and authorization
- payments and the commerce/Order truth model
- database schema changes and any data deletion
- security controls (headers, rate limits, upload rules)
- secrets and credentials
- admin permissions
- destructive operations (including Trash/permanent delete when built)

Also approval-gated: merging a mission to `main`, any deploy or production resource change, activating a provider (payment, calendar, mailbox, meeting, analytics), and public publication at launch. Mark such PRs clearly and stop for sign-off.

## 4. Performance

Stays inside the agreed budgets and adds no unjustified client or runtime weight. See `PERFORMANCE-BUDGET.md`.

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
| Worker size: uncompressed at most 20480 KiB (20 MiB budget; Free/Paid limit 64 MiB; gzip informational only, `Docs/Engineering/DEPLOYMENT.md`) | **CI** (`worker-size`) |
| Worker startup: global-scope initialization within 1 second on Free and Paid | **Review** at deploy time; not measured by the size gate |
| Worker CPU limits | **Review** at deploy time; not measured |
| Rendering mode of a new public route is deliberate (static, ISR with `revalidate`, or `force-dynamic`) and recorded in `Docs/PERFORMANCE-BUDGET.md` section 3 | **Review** |
| Regional (EG/SA/AE) measurement | **Gap**: nothing set up |

A feature that materially breaks the budget fails this gate until justified or fixed.

## 5. Discoverability

For public content: crawlability, metadata, structured semantics, internal linking and discovery mechanics.

| Check | Enforced by |
|---|---|
| Canonical URL, title, description, Open Graph via shared SEO helper (`src/lib/seo.tsx`) | **Review** |
| Page is in the sitemap and `robots` rules are intended (`src/app/sitemap.ts`, `robots.ts`) | **Review** |
| Structured data only where appropriate (Article/Organization/Breadcrumb); no schema spam | **Review** |
| Internal links to related content; renaming a published slug goes through `features/slug-redirects` (old URL answers 308 to the current one, written in the same D1 batch as the rename) | **Review**, backed by slug-redirect tests |
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
| Canonical event dictionary (`ANALYTICS-EVENTS.md`) | **Review**: see the current inventory in `ANALYTICS-EVENTS.md` |
| Page-level analytics, Command Center, alerting on regressions | **Gap**: not built |

---

## Error-handling convention

- **User-facing failure:** throw `AppError(kind, message)` from `src/lib/errors.ts`. Kinds: `unauthorized`, `forbidden`, `not_found`, `invalid`, `conflict`. The message is written for end users and may be shown verbatim.
- **Server actions** return `ActionResult<T>` (`{ ok: true; data } | { ok: false; error }`) via `toActionResult(run, fallback)` from `src/lib/action-result.ts`. Do not throw out of an action: Next.js hides or leaks the message. Zod errors are summarised; any other error is logged and replaced by the fallback text.
- **Route handlers** use `publicErrorMessage(error, fallback)` and `httpStatusFor(error)`.
- **Internal errors** (SQL, driver, provider, bugs) are logged server-side only. The caller sees a generic fallback.
- **Mission 08 domains** use their own typed errors with stable codes and safe fallbacks: `SchedulingDomainError`, `CommerceDomainError`, `LeadDomainError`, and `SchedulingProviderError` for provider adapters. Map them to user-safe text at the boundary; do not display `error.message` from provider errors.

## Documentation

Update the public implementation references when behavior changes. Private status
is optional for contributors; see `AGENTS.md` for the `internal/` convention.

## Reviewer checklist (copy into PR)

- [ ] CI green (verify, e2e, worker-size, audit); new Playwright spec listed in `test:e2e:ci`
- [ ] Tests added and listed in `package.json`; e2e uses `clickAction` / `waitForHydration`
- [ ] New admin mutation writes an admin audit row; new migration committed with `meta/`
- [ ] Authorization and validation on every new action/route
- [ ] Errors use `AppError` / `ActionResult` / domain errors; no raw messages leak
- [ ] Empty, loading, error states; mobile checked
- [ ] Performance: no unjustified client JS or images
- [ ] Public pages: metadata, sitemap, internal links
- [ ] Business Event / observability considered
- [ ] High-risk category? If yes, owner approval recorded
- [ ] Relevant public implementation docs updated
