# Engineering Standards

Blueprint §14, §15, §18.1 and §18.6. Status: **living document**, written against `main` at `b902784`. These are the conventions the code **actually follows**; "Must" rules are checked by CI or by review, "Gap" marks where the code does not yet comply. If code and this file disagree, the code wins; fix this file. Related: `Docs/DEFINITION-OF-DONE.md` (gates), `Docs/ARCHITECTURE.md` (seams), `Docs/PROJECT-STATUS.md` §8 (workflow).

## 1. Structure

| Rule | Detail |
|---|---|
| Modular monolith | Domain code in `src/features/<domain>/` (`service.ts` for D1 logic, `actions.ts` for server actions, `types.ts` for zod schemas and types). Cross-cutting code in `src/lib/`. Pages in `src/app/` stay thin |
| Reuse shared primitives first | Lifecycle, slug, cover-image and block rules live in `features/publishing`. Do not fork them per domain |
| No generic repositories | Database access is explicit per domain through `getDb()` (`src/lib/db`). Use the raw D1 binding (`getD1Database()`) only for atomic `batch()` work |
| Atomic multi-row writes | Use one `db.batch([...])` (a D1 transaction). Slug rename plus redirect row is the model (`slug-redirects/service.ts`) |
| Unique constraints are the backstop | Pre-check for a friendly error, then catch the unique violation (`isUniqueConstraintError`, `lib/db/sqlite-errors.ts`) and convert it only if the expected conflict really exists; otherwise rethrow |
| Idempotency keys | Public mutations carry a client or server key (`requestKey`, `idempotencyKey`, `eventKey`) backed by a unique index. Same key with different content is a conflict |
| Optimistic versioning | Booking and Order rows carry `version` plus `transitionKey`; a lost race throws `CONCURRENT_MODIFICATION` |
| Test-only seams | Production exports gated by an env flag set in `tests/helpers/env.ts` (`DH_BOOKING_LIFECYCLE_TEST_SEAM`, `DH_COMMERCE_TEST_SEAM`, `DH_LEADS_TEST_SEAM`). Never set in production code |

## 2. Errors

| Piece | Rule |
|---|---|
| `AppError(kind, message)` (`src/lib/errors.ts`) | Throw it for any failure whose message was **written for the end user**. Kinds: `unauthorized`, `forbidden`, `not_found`, `invalid`, `conflict` (HTTP 401/403/404/400/409 via `httpStatusFor`) |
| Any other error | Internal. `publicErrorMessage(error, fallback)` returns the AppError text or logs and returns the generic fallback. Never return `error.message` for a non-AppError |
| `ActionResult<T>` (`src/lib/action-result.ts`) | Server actions **return** `{ ok: true, data }` or `{ ok: false, error }` and never throw (Next replaces thrown messages with a digest in production and leaks them in dev). Wrap the body in `toActionResult(run, fallback)`; it also flattens `ZodError` messages. Client code may use `unwrapActionResult` |
| Domain errors | Mission 08 domains keep their own typed classes with machine codes: `SchedulingDomainError` (`scheduling/errors.ts`), `CommerceDomainError` (`commerce/orders.ts`), `LeadDomainError` (`leads/service.ts`). Public actions map codes to safe messages; do not pass raw domain messages through |
| Route handlers | Catch, then respond with `publicErrorMessage` and `httpStatusFor` (see `app/api/*/upload/route.ts`) |

**Gap:** the older Guide, Field Note, Course, Enrollment and Progress actions return their own local `ActionState` type (`{ ok, data?, error? }`) built by a per-file `fail()` helper, not `ActionResult` / `toActionResult`. Only the Editorial AI actions use `toActionResult`. New actions must use `toActionResult`. Also `offers/service.ts` throws plain `Error` for validation, which `publicErrorMessage` would hide behind the fallback.

## 3. Auth gates

| Gate (`src/lib/auth`) | Use in | Behaviour |
|---|---|---|
| `requireAdmin()` | Server actions, route handlers, services that mutate | Throws `AppError` `unauthorized` / `forbidden` |
| `requireAdminPage()` | Every admin `page.tsx` | Redirects to `/admin/login` or `/admin/login?error=forbidden`. It is **not** in `admin/layout.tsx` because `/admin/login` lives under that layout. No middleware or `proxy.ts` gate exists |
| `requireUser()` | Learner actions and routes | Throws `unauthorized` |
| `getServerSession()` / `getAuth()` | Anywhere a session is optional | Request-cached with React `cache()`; no process singleton |

Must: hidden buttons are never authorization. Check on the server, in the action or service, every time. `BETTER_AUTH_SECRET` is required in every environment (fails closed). Single flat role `admin`. Both admin gates also require TOTP 2FA (redirect to `/admin/security` or `forbidden`) unless `ADMIN_REQUIRE_2FA` is exactly `false`; only the security page passes `allowWithout2fa`.

## 4. Cloudflare bindings

Always go through `src/lib/cloudflare/bindings.ts` (`getCloudflareBindings`, `getD1Database`, `getR2Bucket`, `getDb`). Resolution order: test-only D1 override, then `getCloudflareContext()` (Worker), then wrangler `getPlatformProxy` (local Miniflare; state dir from `DH_LOCAL_STATE_DIR`, default `.wrangler/state/v3`). Must not import `wrangler` or read `process.env` for bindings directly; wrangler is imported through a computed specifier so it is never bundled. Public R2 keys are limited to the `guides/` and `field-notes/` namespaces (`isPublicMediaKey`); course PDFs and knowledge sources are private.

## 5. Migrations

1. Edit `src/lib/db/schema.ts`.
2. `npm run db:generate` (drizzle-kit writes `drizzle/migrations/NNNN_*.sql` and `meta/`). Commit the SQL **and** the meta files. Triggers, FTS5 and raw-SQL tables are hand-written (0006, 0012, 0018) and must also be listed in `meta/_journal.json`.
3. Read the SQL. Migrations must be additive or reversible by a later migration; a schema change is a high-risk change (`SECURITY-THREAT-MODEL.md`).
4. `npm run db:migrate:local` (`src/lib/db/migrate.ts`): records each file in `d1_migrations` like wrangler, applies each file atomically, fails loudly on non-idempotent errors. Covered by `tests/migrations-tracking.test.ts`.
5. Remote: `npm run db:migrate:remote` (`wrangler d1 migrations apply DB --env production --remote`). Never run against production without Ahmed's approval.
6. Parallel PRs that each add a migration collide on the number; regenerate the later one after the earlier one merges (done for 0019/0020).

## 6. Testing

| Topic | Rule |
|---|---|
| Runner | `tsx tests/<suite>.test.ts`, using `node:test` and `node:assert/strict` |
| Bootstrap | First import of every suite is `./helpers/env` (`../helpers/env` in `tests/editorial-ai/`). It supplies a fake `BETTER_AUTH_SECRET`, switches auth rate limiting off, enables the test seams, and creates a throwaway `DH_LOCAL_STATE_DIR` so each suite gets its own empty D1/R2 and never touches dev state |
| Setup | `test.before(() => migrateLocalDb())` and `test.after(() => disposeCloudflareBindings())`; use `crypto.randomUUID().slice(0, 8)` suffixes for slugs and keys |
| New suite | **Append it to the `test` script in `package.json`** (one long `&&` line). Concurrent PRs conflict on that line; resolve by keeping both entries. A suite not on that line does not run in CI |
| Real DB, no mocks | Suites run against local Miniflare D1. Inject fakes only through the documented seams (`setD1DatabaseForTest`, provider fakes, `FakeProvider` for Editorial AI) |
| Seams worth a test | Authorization, lifecycle transitions, idempotency, concurrency (lost race), money and booking state machines |
| E2E | Playwright, Chromium, `workers: 1`, `retries: 0`; `npm run test:e2e` (needs `.env.local` admin vars from `.env.example`). CI runs seven specs in `test:e2e:ci` (`mission-08-final-certification`, `field-notes`, `smoke`, `mission-06-learning-platform`, `mission-07-editorial-ai`, `csp`, `admin-security`). Add a new spec to that script too. The web server sets `ADMIN_REQUIRE_2FA=false`; a unit suite that uses a real admin session must set it itself (`tests/helpers/env.ts` does not) |
| **Hydration rule** | After a navigation or reload, SSR markup is clickable before React attaches `onClick`; a click in that window is silently lost. Use `clickAction(page, target)` from `e2e/helpers/actions.ts`: assert the button is enabled, wait until the DOM node has a `__reactProps$` key, then click. Call `waitForHydration(page, locator)` before filling a form (hydration resets controlled inputs). Do not use `networkidle` or `waitForFunction` on `readyState`. Used by the mission-06, 07, 08 and `admin-security` specs |
| Evidence | Report the gate output, not a claim. UI changes need a screenshot or a Playwright run |

## 7. CI and budgets

| Workflow / job | What it enforces |
|---|---|
| `ci.yml` `verify` | `npm ci`, `npm run lint` (zero warnings), `npm run typecheck`, `npm test`, `npm run db:migrate:local`, `npm run build` (fake `BETTER_AUTH_SECRET`, local Miniflare only) |
| `ci.yml` `e2e` (after `verify`) | `npm run test:e2e:ci`, 40-minute timeout; Playwright artifacts uploaded on failure |
| `ci.yml` `worker-size` (after `verify`) | `npm run cf:build` then `npm run cf:size`: uncompressed Worker must stay within **20480 KiB** (Free/Paid limit 64 MiB; gzip informational only) |
| `audit.yml` | `npm audit --omit=dev --audit-level=high` on PRs, `main`, and weekly. Known dev-only moderates are listed in `Docs/Engineering/DEPENDENCY-AUDIT.md` |
| `codeql.yml` | Manual only until GitHub code scanning is enabled on the private repo |

Local gate before a PR: `npm run lint`, `npm run typecheck`, `npm test`, `npm run db:migrate:local && npm run build` (with `BETTER_AUTH_SECRET` set), and the relevant Playwright spec. Performance budgets: `Docs/PERFORMANCE-BUDGET.md`.

## 8. Dependencies

| Rule | Detail |
|---|---|
| **7-day-old rule** | Adopt only package versions published at least 7 days ago. Dependabot enforces it with `cooldown.default-days: 7` (`.github/dependabot.yml`); for manual bumps check the publish date yourself (the OpenNext adapter was pinned to 1.20.12 over 1.20.13 for this reason) |
| Pinning | Runtime framework packages are pinned exactly (`next`, `react`, `react-dom`, `motion`, `zod`, `lucide-react`, `@opennextjs/cloudflare`, `tailwindcss`); a few tools use `^`. Keep the existing style when bumping |
| Dependabot ignores | Semver-**major** updates are ignored for `next`, `react`, `react-dom`, `@opennextjs/cloudflare`, `wrangler`, `better-auth`, `drizzle-orm`, `typescript` (TS 7 breaks typescript-eslint), `eslint` (v10 unsupported by the plugins in `eslint-config-next`), `eslint-config-next`. Majors are manual, planned upgrades. Minor and patch updates arrive as one weekly group; GitHub Actions are grouped too |
| Overrides | Two `overrides` in `package.json` (`undici`, `@node-minify/core` > `glob`) patch dev-tool advisories; remove them when upstream updates |
| New dependency | Needs a reason in the PR; watch the Worker size budget (about 6% headroom) |
| Next.js 16 | Differs from older docs. Read `node_modules/next/dist/docs/` before writing framework code (`AGENTS.md`) |

## 9. Content Security Policy

Set as a **static** header in `next.config.ts` (no per-request nonce, so public pages stay prerendered or ISR). Verified by `e2e/csp.spec.ts`.

| Directive | Value | Consequence |
|---|---|---|
| `script-src` | `'self' 'unsafe-inline'` (+ `'unsafe-eval'` in dev only) | Next's inline bootstrap cannot be hashed in a static header. Tightening needs nonces or hashes |
| `style-src` | `'self' 'unsafe-inline'` | React `style={{}}` allowed |
| `img-src` | `'self' data: blob:` | No external image hosts. Content `https://` cover URLs pass `isSafeMediaUrl` but will not render under this CSP unless the CSP is widened (see Divergence below) |
| `font-src` | `'self' data:` | System fonts only; no `next/font`, no Google Fonts |
| `connect-src` | `'self'` (+ `ws:` `wss:` in dev) | **No third-party analytics endpoint can be called from the browser** |
| `frame-src` | `https://www.youtube-nocookie.com` | Lesson videos only, via `courses/youtube.ts` |
| `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`, `worker-src 'self' blob:` | | Production adds `upgrade-insecure-requests` |

Must: no new third-party script, font, frame or image origin without updating this table, the CSP and `csp.spec.ts` together. No render-blocking third-party scripts (performance budget). JSON-LD `<script type="application/ld+json">` is data and is allowed.

## 10. Branches, PRs and docs

From `PROJECT-STATUS.md` §8:

- One branch per task, PR to `main` (or the mission integration branch). Subagents work in isolated worktrees under `.claude/worktrees/` (git- and lint-ignored), commit to `hardening/*`-style branches, and the coordinator reviews, pushes and opens PRs.
- Mission merges need Ahmed's explicit GO. Never deploy or touch production resources without approval.
- Read `Docs/PROJECT-STATUS.md` before starting; update it last (snapshot, branch/PR map, next steps, session log) when code, branches, PRs or plans change.
- Commits end with the `Co-Authored-By` trailer for the model that wrote them.
- Comments explain *why* and name the invariant (see existing "REVIEW CORRECTION" style); avoid ticket-reference comments (listed as hygiene debt).
- Docs: per-mission docs in `Docs/Engineering/`, vocabulary in `Docs/CONTEXT.md`, content in `Docs/CONTENT-MODEL.md`, events in `Docs/ANALYTICS-EVENTS.md`.

## ⚠ Divergences

1. **ActionResult adoption is partial** (section 2): five feature action files define their own `ActionState`. `AGENTS` and `PROJECT-STATUS.md` §8 state the rule as universal.
2. **Blueprint §18.1 clean-code rules are not written down in the repo**; this file records only observed practice. Module-depth and naming reviews have no tool support.
3. **Cover images vs CSP: resolved.** `isSafeMediaUrl` now accepts only same-origin `/api/media/...` paths, matching `img-src`; the field-note article omits any stored cover that fails it. Plain `Error` remains deliberately on internal invariant paths (re-read failures, orchestration, providers, rate-limit, migrations). Validation, not-found and conflict throws in `offers/service.ts`, `scheduling/policy.ts` and guide/field-note discard are now `AppError`, and Studio commerce `fail()` surfaces them through `publicErrorMessage` (the old message-regex allowlist is gone).
4. **Pinning is mixed:** blueprint and Dependabot cooldown imply deliberate versions, but `better-auth`, `drizzle-orm`, `drizzle-kit`, `wrangler`, `playwright`, `@playwright/test` and `@cloudflare/workers-types` use `^` ranges.
