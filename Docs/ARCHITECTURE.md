# Architecture

Blueprint §6, §7, §18.1 (clean-code rules) and §18.6 (repository knowledge contract). Status: **living document**, written against `main` at `8351e55` (2026-10-26). Nothing is deployed yet; production values in `wrangler.jsonc` are placeholders. If code and this file disagree, the code wins; fix this file. Vocabulary lives in `Docs/CONTEXT.md`; delivery state in `Docs/PROJECT-STATUS.md`.

## 1. Runtime

```
Browser
  |
Cloudflare Worker  (.open-next/worker.js, built by @opennextjs/cloudflare 1.20.12; wrangler ^4.151.1)
  |  Next 16.4.2 App Router, React 19.3.1, server components + server actions + route handlers
  |-- ASSETS            static files (.open-next/assets)
  |-- DB                D1 (SQLite) via Drizzle
  |-- MEDIA_BUCKET      R2: public editorial media, private course PDFs, knowledge sources
  |-- NEXT_INC_CACHE_R2_BUCKET   R2: OpenNext incremental cache (ISR, revalidatePath)
  `-- WORKER_SELF_REFERENCE      service binding to itself (cache revalidation)
```

- **Build:** `next build --webpack`, then `opennextjs-cloudflare build`. Config: `open-next.config.ts` (R2 incremental cache only), `wrangler.jsonc`, `next.config.ts` (security headers, `serverExternalPackages: wrangler, miniflare, esbuild`).
- **Flags:** `nodejs_compat`, `global_fetch_strictly_public`; compatibility date 2026-09-15.
- **Bindings seam:** `src/lib/cloudflare/bindings.ts` `getCloudflareBindings()` resolves, in order: a test-only D1 override, the Worker request context (`getCloudflareContext()`), then a local `getPlatformProxy` from wrangler (Miniflare state in `DH_LOCAL_STATE_DIR` or `.wrangler/state/v3`). wrangler is imported through a computed specifier so it is never bundled. Everything else calls `getD1Database()` / `getR2Bucket()` / `getDb()`.
- **Rendering:** server-first, four modes (detail and route list in `Docs/PERFORMANCE-BUDGET.md` section 3):

| Mode | Routes |
|---|---|
| Static (○) | Marketing and legal pages, `/guides` and `/field-notes` indexes (prerendered from D1, refreshed by `revalidatePath()` on publish) |
| Timed ISR (`revalidate = 300`) | `/mission-01`, `/ai-recruiter-os`; `refreshCommerce()` revalidates them on Studio offer or booking-type changes |
| ISR on demand (`generateStaticParams` returns `[]`, `revalidate = 3600` as safety net) | `/guides/[slug]`, `/field-notes/[slug]`: published article only, no `searchParams`, cached in the R2 incremental cache, revalidated by Studio actions and editorial-AI publish; slug redirects (308) and 404s resolve inside the render |
| Dynamic (ƒ) | `/coaching`, `/workshop` (live availability), `/preview/guides/[slug]` and `/preview/field-notes/[slug]`, `/admin/*`, `/learn/*`, `/api/*`, `/sitemap.xml` |

- **Staff preview:** `?preview=true` on an article URL is rewritten in `next.config.ts` (`beforeFiles`) to the `force-dynamic`, `noindex`, admin-only routes under `src/app/(site)/preview/`; the browser URL does not change.
- **CSP:** static `Content-Security-Policy` header in `next.config.ts` (no nonce, so ISR stays cacheable); directives in `Docs/ENGINEERING-STANDARDS.md` section 9, verified by `e2e/csp.spec.ts`.
- **No middleware/proxy file.** Access control is in server code (section 4).

## 2. Data

| Store | Use | Access |
|---|---|---|
| D1 `DB` | All application data. Schema in `src/lib/db/schema.ts` (Drizzle, SQLite) | `getDb()` in `src/lib/db/index.ts`; a few modules use the raw D1 binding for atomic batches (`analytics/service.ts`) |
| R2 `MEDIA_BUCKET` | `guides/`, `field-notes/` (public images), `course-resources/<courseId>/` (private PDFs), knowledge sources (private) | `lib/media/service.ts`, `lib/course-resources/service.ts`, `editorial-ai/knowledge/storage.ts` |
| R2 `NEXT_INC_CACHE_R2_BUCKET` | OpenNext incremental cache | OpenNext only |

**Migrations:** SQL files in `drizzle/migrations` (0000-0023, generated with `drizzle-kit generate`; some hand-written, e.g. 0012 booking overlap trigger; latest: 0020 `slug_redirects`, 0021 `admin_audit_log`, 0022 `two_factor` plus `user.two_factor_enabled`, 0023 `business_events_occurred_idx` for retention pruning). Local: `npm run db:migrate:local` (`scripts/migrate-local.ts` -> `src/lib/db/migrate.ts`), which records applied files in wrangler's `d1_migrations` table and fails loudly on non-idempotent errors (`tests/migrations-tracking.test.ts`). Remote: `npm run db:migrate:remote` (`wrangler d1 migrations apply DB --env production --remote`). Schema changes are a high-risk change (`Docs/SECURITY-THREAT-MODEL.md` section 6).

**Table groups:** identity (`user`, `session`, `account`, `verification`); content (`guides`, `field_notes`, `field_note_revisions`, `media`); learning (`courses`, `course_sections`, `lessons`, `lesson_resources`, `enrollments`, `lesson_progress`); editorial AI (`knowledge_*`, `editorial_*`); scheduling (`booking_types`, `booking_availability_windows`, `slot_holds`, `bookings`, `booking_history`); commerce (`offers`, `orders`, `order_history`, `payment_events`, `orchestration_effects`, `orchestration_history`); intake and operations (`lead_submissions`, `public_rate_limits`, `business_events`); security and routing (`two_factor`, `admin_audit_log`, `slug_redirects`).

## 3. Auth

- **Better Auth** (^1.7.10) with the `admin` plugin (`defaultRole: "user"`, `adminRole: "admin"`) and the `twoFactor` plugin (TOTP plus single-use backup codes, issuer "Decoded Hiring"), Drizzle adapter over D1, email and password, no email verification. Code: `src/lib/auth/index.ts`; browser client: `src/lib/auth/client.ts`; HTTP: `src/app/api/auth/[...all]/route.ts`.
- **Request-cached:** `getAuth` and `getServerSession` use React `cache()`; there is no process-lifetime singleton, so each request resolves its own D1 binding and secret.
- **Fail closed:** `BETTER_AUTH_SECRET` is required in every environment.
- **Guards:** `requireAdmin()` and `requireUser()` throw `AppError` (actions, routes); `requireAdminPage()` redirects (pages). Both admin guards also enforce **2FA**: an admin without `twoFactorEnabled` is redirected to `/admin/security` (pages) or rejected (actions) unless `ADMIN_REQUIRE_2FA` is exactly `"false"` (`isAdmin2faRequired()`; set only in `.env.example` and the Playwright web server, never in production). Only `/admin/security` passes `allowWithout2fa`. Pure decision functions `checkAdminPage` / `checkAdmin` are exported for tests. Learner access to a course goes through `features/enrollments` and `lib/course-resources/access.ts`.
- **Rate limiting:** Better Auth `customStorage.consume` is backed by the D1 fixed-window primitive in `features/public-intake/rate-limit.ts`. Per client IP per path: sign-in, sign-up and `/two-factor/verify-*` 5/min; password flows and password-confirming 2FA management 5/min; default 120/min; `/get-session` unthrottled (`src/lib/auth/rate-limit.ts`).
- First admin: `npm run admin:create` (`scripts/create-admin.ts`, credentials from env).

## 4. Module map (`src/features/*`)

| Module | Responsibility | Main seams |
|---|---|---|
| `publishing` | Content lifecycle (`draft`/`published`/`archived`), preview rules, shared types | `lifecycle.ts`, `preview.ts` |
| `guides` | Guide CRUD, publish, ISR revalidation | `service.ts`, `actions.ts` (admin) |
| `field-notes` | Field Note CRUD, revisions, publish | `service.ts`, `actions.ts` (admin) |
| `content` | Approved homepage content model | `homepage-model.ts`, `approved-homepage.tsx` |
| `courses` | Courses, sections, lessons, resources, YouTube embed handling | `service.ts`, `actions.ts` (admin), `youtube.ts` |
| `enrollments` | Enrolment and access checks | `service.ts`, `access.ts`, `actions.ts` (learner) |
| `progress` | Lesson completion and progress maths, reconciliation on write paths | `service.ts`, `reconcile.ts`, `actions.ts` (learner) |
| `editorial-ai` | Knowledge library, chunking and retrieval, editorial memory, skills, drafts, audit log, LLM providers | subfolders `knowledge`, `memory`, `skills`, `drafts`, `audit`, `providers` |
| `offers` | Offer catalog and public presentation | `catalog.ts`, `service.ts`, `presentation.ts` |
| `scheduling` | Booking types, availability, holds, bookings, policy, time, provider contracts, public booking | `index.ts`, `bookings.ts`, `holds.ts`, `availability.ts`, `public-actions.ts`, `providers.ts` |
| `commerce` | Orders, orchestration effects, admin operations and read models | `index.ts`, `orders.ts`, `orchestration.ts`, `admin-operations.ts`, `admin-actions.ts` |
| `leads` | Public enquiry capture with idempotency and fallback | `service.ts`, `actions.ts` (public), `lead-form.tsx` |
| `public-intake` | Shared D1 fixed-window rate-limit primitive, salted per-IP buckets (`PUBLIC_IP_LIMITS`), opportunistic pruning of expired rows (24 h retention, 1% of consumes, 500 rows) | `rate-limit.ts` |
| `audit` | Admin audit trail: `recordAdminAudit()` / `buildAdminAuditStatement()` write `admin_audit_log` rows (actor, action, entity, small JSON details); read-only viewer at `/admin/audit` | `service.ts` |
| `slug-redirects` | Records a redirect when an ever-published Guide, Field Note, Course or Lesson slug is renamed, in the same D1 batch; target resolved at request time (A to B to C resolves A to C); a live entity reusing a slug deletes its redirect row | `service.ts` |
| `analytics` | Business events (best-effort, no PII), public funnel events | `service.ts`, `public-actions.ts`, `types.ts` |

Outside features: `src/lib` (cross-cutting infra: `auth`, `db`, `cloudflare`, `media`, `course-resources`, `uploads/sniff.ts`, `errors.ts`, `action-result.ts`, `safe-redirect.ts`, `upload-limits.ts`, `seo.tsx`, `sitemap-entries.ts`); `src/app` (routes: `(site)` public incl. `preview/`, `admin` Studio incl. `security` (2FA enrolment) and `audit`, `learn` classroom, `api`); `src/components` (`home`, `learner`, `products`, `publishing`, `site`). Note: `src/lib/media` and `src/lib/course-resources` hold domain logic that has not been moved into `features/` (candidate cleanup, blueprint §18.1).

## 5. Cross-cutting conventions

| Convention | Rule | Code |
|---|---|---|
| Errors | `AppError(kind, message)` is user-safe (kinds map to HTTP 401/403/404/400/409). Any other error is internal: logged, replaced by a generic fallback | `src/lib/errors.ts` |
| Server action results | Actions **return** `ActionResult<T>` (`{ ok, data } or { ok, error }`) via `toActionResult()`; they do not throw to the client (Next serialises thrown errors unsafely) | `src/lib/action-result.ts` |
| Domain errors | Modules define typed errors with codes (`LeadDomainError`, scheduling `errors.ts`, `SchedulingProviderError`) | per feature |
| Validation | Zod at every boundary (actions, routes, analytics metadata) | per feature `*-schemas.ts` |
| Authorization | Server-side only, in the action or route; role never read from input | `src/lib/auth` |
| Rate limiting | Atomic D1 upsert (`consumePublicFixedWindowLimit`, `consumeFixedWindowMs`); scope keys hash PII. Public intake checks a salted per-IP bucket first (`consumePublicIpLimit`: lead 10, booking 8, analytics 20 per 15 min), then the shared email/kind/global counters; the IP check is skipped when there is no request context (tests, scripts) | `public-intake/rate-limit.ts` |
| Race safety | Conditional-WHERE updates, unique indexes and a DB trigger, rather than read-then-write | `scheduling`, `commerce`, `enrollments`, migrations |
| Business events | `recordBusinessEventBestEffort()` with a dedupe key; never blocks the main path; forbids PII-looking metadata keys | `features/analytics/service.ts` |
| Audit | `recordAdminAudit()` for admin mutations (guide, field note, course, section, lesson, lesson resource, media, offer, booking type, availability window), awaited after the mutation, failures logged not surfaced; `logAudit()` for editorial AI (best-effort); history tables for bookings and orders | `features/audit`, `editorial-ai/audit`, `booking_history`, `order_history` |
| Test seams | Opt-in env flags (`DH_*_TEST_SEAM`) and `setD1DatabaseForTest`; never set in production code | see threat model T19 |
| Safe redirects | `safeRedirectPath()` for any `?redirect=` | `src/lib/safe-redirect.ts` |
| Uploads | Size guard in three layers, server-minted keys; images: MIME allowlist plus magic-byte sniffing, the sniffed type is stored; PDFs: `%PDF-` check | `src/lib/upload-limits.ts`, `src/lib/uploads/sniff.ts`, services |
| Slug changes | Rename plus redirect row in one `db.batch`; article routes revalidate old and new slug | `features/slug-redirects`, `guides`, `field-notes`, `courses` |

## 6. Provider adapters (dormant)

- **Contracts:** `src/features/scheduling/providers.ts` defines payment, calendar, mailbox and meeting capabilities with `ProviderRuntimeStatus` and `SchedulingProviderError`. Unconfigured providers throw `PROVIDER_NOT_CONFIGURED` and never fake a success. No concrete SDK, credential or provider choice exists (`tests/mission-08-provider-adapters.test.ts`).
- **Commerce:** orders are provider-neutral; a manual-payment admin operation exists (`recordManualPaymentForAdmin`). Payment webhooks and signature verification are modelled in contracts and schemas, not wired to a live provider.
- **Editorial LLM:** the only provider adapter with real code. `editorial-ai/providers/` offers an OpenAI-compatible client (`openai.ts`, env `EDITORIAL_MODEL_BASE_URL`, `EDITORIAL_MODEL_API_KEY`, `EDITORIAL_MODEL_NAME`) and a fake for tests. Resolution fails closed when unconfigured; the fake is used only when `EDITORIAL_FORCE_FAKE_PROVIDER=1` (see `drafts/actions.ts`), for E2E.

## 7. CI/CD

`.github/workflows/ci.yml` and `audit.yml`, on pull requests and pushes to `main`, Node 22, fake CI-only secrets, local Miniflare only.

| Job | Steps | Notes |
|---|---|---|
| `verify` | `npm ci`, `lint` (`--max-warnings=0`), `typecheck` (`next typegen && tsc`), `npm test` (tsx suites in `tests/`), `db:migrate:local`, `build` | Migrations first because `/guides` and `/field-notes` prerender from D1 |
| `e2e` (needs verify) | Playwright Chromium, 40-minute timeout; `test:e2e:ci` runs all seven specs: `mission-08-final-certification`, `field-notes`, `smoke`, `mission-06-learning-platform`, `mission-07-editorial-ai`, `csp`, `admin-security` | Uploads report artifacts on failure. Web server sets `ADMIN_REQUIRE_2FA=false`; shared `e2e/helpers/actions.ts` (`clickAction`, `waitForHydration`) |
| `worker-size` (needs verify) | `db:migrate:local`, `cf:build`, `cf:size` | Fails above 20480 KiB uncompressed (`scripts/check-worker-size.ts`, override `WORKER_UNCOMPRESSED_BUDGET_KIB`); Free/Paid limit 64 MiB, gzip informational only |
| `audit.yml` `npm-audit` | `npm audit --omit=dev --audit-level=high`; PRs, `main`, weekly (Monday) | Dev-only moderates are documented in `Docs/Engineering/DEPENDENCY-AUDIT.md` |
| `codeql.yml` | CodeQL javascript-typescript | `workflow_dispatch` only until code scanning is enabled on the private repo |

`.github/dependabot.yml`: weekly npm and GitHub Actions updates, 7-day cooldown, minor/patch grouped, semver-major ignored for `next`, `react`, `react-dom`, `@opennextjs/cloudflare`, `wrangler`, `better-auth`, `drizzle-orm`, `typescript`, `eslint`, `eslint-config-next`.

There is **no deploy job** and no preview deployments yet (`Docs/Engineering/DEPLOYMENT.md` follow-ups). Deploy is manual: `npm run deploy`.

## 8. Environments

| Environment | Config | Data | Status |
|---|---|---|---|
| Local dev | `npm run dev` (`next dev --webpack`); wrangler top-level config via `getPlatformProxy`; `.env.local` for `BETTER_AUTH_SECRET` | Miniflare D1/R2 in `.wrangler/state/v3` | In use |
| Local Worker | `npm run preview` (OpenNext build in `wrangler dev`); secrets in `.dev.vars` | Same local state | In use |
| CI | `ci.yml` env block | Fresh Miniflare per job | In use |
| Production | `wrangler.jsonc` `env.production`; `BETTER_AUTH_SECRET` as Worker secret; `BETTER_AUTH_URL`, `NEXT_PUBLIC_SITE_URL` vars | Remote D1 + two R2 buckets | **Placeholders; not provisioned** |
| Staging | Not defined (suggested `env.staging`, same shape) | | Not started |

Bindings are not inherited between wrangler environments, so every binding is repeated under `env.production`.

## 9. Where to put new code

Follows blueprint §18.1: modular monolith, organise by business capability, deep modules, no `helpers/`, `utils/` or `services/` dumping grounds, no layers that only forward arguments.

| You are adding | Put it in |
|---|---|
| A business rule or lifecycle | The owning `src/features/<domain>/` module (`service.ts` or a named file). One source of truth; routes, actions and UI call it |
| A new capability with its own vocabulary and tables | A new `src/features/<domain>/` folder; add terms to `Docs/CONTEXT.md` |
| A server action | `src/features/<domain>/actions.ts` (admin/learner) or `public-actions.ts` (anonymous). Start with the auth guard or rate limit, validate with Zod, return `ActionResult` |
| A route handler | `src/app/api/...` only for binary/streaming or webhooks; keep it thin and delegate to the feature. Gate with `requireAdmin()` or a session check first |
| A page | `src/app/(site)` (public), `src/app/learn` (learner), `src/app/admin` (Studio, gate with `requireAdminPage()`). Pages call feature services, never D1 or R2 directly |
| UI components | `src/components/<area>/`; one-off feature UI may live next to its feature (as `leads/lead-form.tsx`) |
| Cross-cutting infrastructure used by many domains | `src/lib/` (auth, db, cloudflare, errors, safe redirect, upload limits) |
| An external provider | Behind a contract in the owning feature (as `scheduling/providers.ts`), failing closed when unconfigured; add an adapter only when variation is real |
| A schema change | Edit `src/lib/db/schema.ts`, `npm run db:generate`, review the SQL, commit the migration and `meta/`; add a regression test. High-risk: needs Ahmed's approval |
| An admin mutation | Guard with `requireAdmin()`, then call `recordAdminAudit()` (add the entity to `AUDIT_ENTITY_TYPES` if new). Renaming a published slug goes through `slug-redirects` |
| A rate limit on a public path | `consumePublicFixedWindowLimit` with a hashed scope key; remember each consume is a D1 write (`Docs/PERFORMANCE-BUDGET.md`) |
| A test | `tests/<name>.test.ts` and add it to the `npm test` script (it is an explicit `&&` chain, not a glob); E2E in `e2e/`, added to `test:e2e:ci`, using `clickAction` / `waitForHydration`. A suite using a real admin session sets `ADMIN_REQUIRE_2FA=false` |
| A new Cloudflare binding | `wrangler.jsonc` top level **and** `env.production`; extend `CloudflareEnv` in `bindings.ts`; update `DEPLOYMENT.md` |
