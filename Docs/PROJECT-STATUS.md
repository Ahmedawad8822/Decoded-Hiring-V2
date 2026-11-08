# Decoded Hiring V2 — Project Status & Roadmap

**This is the living hand-off document for every agent and contributor.**

- **Read it first**, before starting any task.
- **Update it last**, at the end of every task that changes code, branches, PRs or plans:
  edit the snapshot, the branch/PR map, the next-steps queue and the session log
  at the bottom. Keep it short and factual. Link to mission docs for detail.
- If this file disagrees with the code or GitHub, the code/GitHub wins. Fix this file.

Last updated: **2026-11-08**

---

## 1. Where we stand (snapshot)

| | |
|---|---|
| `main` | `44b8820` (plus this doc): **Missions 01–08, CI (verify, Playwright E2E with all 7 specs, Worker size gate on the 64 MiB uncompressed limit, npm audit; CodeQL on demand; Dependabot active), security fixes and CSP, hardening batches 1–7, free-plan perf batch (#67, #68, #71–#74), deploy-path prep, Next 16.4.3, OpenNext 1.20.15, wrangler 4.156.0, Better Auth 1.7.15, React 19.3.1, motion 14.9.** Unit tests: 41 suites, each on its own throwaway D1/R2. Migrations through `0023_business_events_retention_index`. Admin 2FA is enforced unless `ADMIN_REQUIRE_2FA=false`. `.env.example` and the Playwright web server set it, and so do the unit suites that sign in admins (`admin-audit-trail`, `admin-two-factor`). `tests/helpers/env.ts` doesn't. |
| Open PRs to `main` | None |
| CPU test env | **Live, throwaway:** https://dh-cputest.hdv2.workers.dev (Worker `dh-cputest`, D1 `dh-cputest-db`, R2 `dh-cputest-media` / `dh-cputest-next-cache`) on Ahmed's Free account. Seeded with public fixture content only; no user/auth rows, so nobody can sign in. Config lives on local branch `tmp/cputest` (`env.cputest` in `wrangler.jsonc`), not on `main`. Delete with `wrangler delete --env cputest`, `wrangler d1 delete dh-cputest-db`, `wrangler r2 bucket delete …` when done. |
| Production | **Not deployed.** The OpenNext adapter and config are prepared and verified locally (`Docs/Engineering/DEPLOYMENT.md`). No real Cloudflare resources exist yet; `wrangler.jsonc → env.production` holds placeholders. |
| **GitHub Actions** | **Blocked:** jobs won't start ("recent account payments have failed or your spending limit needs to be increased"). The repo is private, so minutes are billed. Since #62, every PR is verified with a local mirror of `ci.yml` and `audit.yml` instead (see the session log), with the result as a PR comment. Ahmed has to fix billing in GitHub Settings → Billing & plans. |
| Providers | All dormant by design: no payment, calendar, mailbox, meeting or analytics provider is active. |
| Blueprint phase | Phases 1–6 built and on `main`. **Phase 7 (Hardening & Growth) is in progress** (CI merged; #14 open), then Phase 8 (Launch). |

---

## 2. Branch & PR map

| Branch | Base | State | What it is |
|---|---|---|---|
| `main` | — | current | Missions 01–08, CI, security fixes + CSP, hardening batches 1–5, deploy-path prep, Next 16.4.2 |
| `hardening/*` (5) | — | merged (#18–#22) | Playwright CI, images, isolated test DB, progress maths, auth cache/admin gate |
| `docs/context-and-dod` | — | merged ([#25](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/25)) | `Docs/CONTEXT.md` (41 terms, 12 ⚠ conflicts) and `Docs/DEFINITION-OF-DONE.md` |
| `ci/worker-size-budget` | — | merged ([#26](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/26)) | CI job `worker-size`: fails above 2950 KiB gzip (`npm run cf:size`) |
| `hardening/migration-tracking` | — | merged ([#27](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/27)) | `migrateLocalDb` records `d1_migrations` like wrangler; atomic per file; one-time legacy baseline |
| `hardening/auth-rate-limit` | — | merged ([#28](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/28)) | Better Auth limits on D1: sign-in/up and password flows 5/min/IP, default 120, `/get-session` exempt |
| `deploy/admin-seed-script` | — | merged ([#29](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/29)) | `npm run admin:create` (`--local` or `--remote --env`); Better Auth hash; idempotent |
| `hardening/progress-write-paths` | — | merged ([#30](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/30)) | Learner reads no longer write; `reconcileCourseEnrollments()` on curriculum writes; archived lessons can't be published |
| `upgrade/next-16.4-opennext` | — | merged ([#31](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/31)) | Next 16.4.2, adapter 1.20.12, wrangler 4.151.1; Worker 2.82 MiB gzip |
| `docs/status-batch-3` | — | merged (#32) | Status doc |
| `docs/foundation-security-perf-arch` | — | merged ([#33](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/33)) | `SECURITY-THREAT-MODEL.md` (16 gaps), `PERFORMANCE-BUDGET.md`, `ARCHITECTURE.md` |
| `hardening/rate-limit-pruning` | — | merged ([#34](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/34)) | Bounded pruning of `public_rate_limits` (24h retention, 500/call, ~1% of calls); index via **migration 0019** |
| `feature/slug-redirects` | — | merged ([#35](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/35)) | `slug_redirects` table (**migration 0020**) + 308s for renamed guides/notes/courses/lessons |
| `security/npm-audit` | — | merged ([#36](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/36)) | 22 → 4 advisories (moderate, dev-only); zod 4.6.7 (real runtime fix); drop unused `@better-auth/cli`; 2 overrides |
| `ci/all-e2e-specs` | — | merged ([#37](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/37)) | All 5 Playwright specs in CI; e2e timeout 40 min |
| `security/csp` | — | merged ([#38](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/38)) | Static CSP header + `e2e/csp.spec.ts`; fixes anonymous `/learn` null-session crash |
| `docs/status-batch-4` | — | merged (#39) | Status doc |
| `ci/supply-chain-checks` | — | merged ([#40](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/40)) | Dependabot (7-day cooldown, majors of the framework packages ignored), `audit.yml` (`npm audit --omit=dev --audit-level=high`), CodeQL **manual only** until code scanning/GHAS is enabled on the private repo. Dependabot is already active (it opened #46–#52) |
| `security/image-magic-bytes` | — | merged ([#41](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/41)) | `lib/uploads/sniff.ts`; `uploadMedia` rejects bytes that don't match the declared type and stores the sniffed type (G11) |
| `security/per-ip-intake-limits` | — | merged ([#42](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/42)) | Salted per-IP buckets for lead 10, booking 8 and analytics 20 per 15 min, checked before the shared counters (G6) |
| `perf/static-content-pages` | — | merged ([#43](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/43)) | `/guides/[slug]` and `/field-notes/[slug]` ISR; `/contact`, `/mission-01` and `/ai-recruiter-os` static; `?preview=true` rewritten to dynamic `/preview/...`; revalidation on rename, editorial publish and offers |
| `ci/e2e-stability` | — | merged ([#44](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/44)) | mission-07 drops from 3.4 min to 25 s (the old helper's 15 s dead waits); no `networkidle` |
| `docs/status-batch-5` | — | merged (#45) | Status doc |
| `dependabot/*` | — | merged #46–#50; closed #51 and #52 | Dependabot triage: see the 2026-10-26 session log entry |
| `chore/dependabot-triage` | — | merged (#53) | Dependabot ignores TS/ESLint majors; status doc |
| `docs/phase0-content-standards-analytics` | — | merged ([#54](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/54)) | `CONTENT-MODEL.md`, `ENGINEERING-STANDARDS.md`, `ANALYTICS-EVENTS.md`, each with a ⚠ Divergences section |
| `security/admin-audit-trail` | — | merged ([#55](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/55)) | `admin_audit_log` (migration 0021), `recordAdminAudit()` on every content/commerce admin mutation, `/admin/audit` (G4) |
| `test/e2e-hydration-clicks` | — | merged ([#56](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/56)) | Shared `e2e/helpers/actions.ts` `clickAction` in mission-06/07/08 |
| `security/admin-2fa` | — | merged ([#57](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/57)) | Better Auth TOTP and backup codes, `/admin/security`, `ADMIN_REQUIRE_2FA` (enforced unless `"false"`), migration `0022_admin_two_factor` (G3) |
| `docs/status-batch-6` | — | merged (#58) | Status doc |
| `docs/refresh-dod-architecture` | — | merged ([#59](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/59)) | DoD, ARCHITECTURE, threat model (G1/G5/G6/G16 fixed, T20/T21), perf budget brought up to date |
| `feature/leads-inbox` | — | merged ([#60](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/60)) | `/admin/leads` + detail; NEW/REVIEWED/CLOSED transitions with a conditional UPDATE; `lead.*` audit rows with no PII; `ActionResult` |
| `fix/media-urls-and-offer-errors` | — | merged ([#61](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/61)) | `isSafeMediaUrl` accepts only `/api/media/…`; offers/scheduling validation throws `AppError`; commerce `fail()` uses `publicErrorMessage` |
| `hardening/business-events` | — | merged ([#62](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/62)) | Drizzle model, summary no longer writes, 400-day pruning, **migration 0023** `occurred_at` index; D1 write-headroom test limit raised from 50k to 60k |
| `ci/worker-self-ref-noise` | — | merged ([#63](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/63)) | `WORKER_SELF_REFERENCE` removed from the local wrangler config, kept in `env.production`; new `wrangler.preview.jsonc` for `npm run preview` |
| `test/mission-06-complete-wait` | — | merged ([#64](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/64)) | mission-06 waits up to 30 s for completion and fails fast on the button's error |
| `docs/status-batch-7` | — | merged (#65) | Status doc |
| `perf/cached-booking-pages` | — | merged ([#68](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/68)) | `/coaching` and `/workshop` are `revalidate = 300` shells; slots come from `GET /api/public/booking-slots` client-side. Slot generation rewritten (lazy, stops at 60, batched D1 reads): resolver CPU median 185 → 11 ms. Equivalence tests against a frozen reference |
| `perf/worker-slim-and-size-limit` | — | merged ([#67](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/67)) | `cf:size` gates **uncompressed** size (Cloudflare limit 64 MiB, no compressed limit since 2026-10-29); budget `WORKER_UNCOMPRESSED_BUDGET_KIB` 20480; gzip informational. Lazy `import()` for editorial AI and the 2FA QR code |
| `perf/reuse-drizzle-instance` | — | merged ([#71](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/71)) | One Drizzle instance per D1 binding (`WeakMap`); `drizzle()` re-derived the schema config on every `getDb()`, the top CPU cost of dynamic pages |
| `perf/d1-tag-cache` | — | merged ([#73](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/73)) | OpenNext D1 tag cache (`NEXT_TAG_CACHE_D1`, same D1 as `DB`); without it `revalidatePath`/`revalidateTag` are no-ops on Workers |
| `test/slots-proxy-reset` | — | merged ([#74](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/74)) | Fixes a local-only `ECONNRESET` flake in `slots-equivalence` (Miniflare undici socket reused after >5 s sync work) |
| `perf/cpu-profiler` | — | merged ([#72](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/72)) | `npm run perf:cpu` (local workerd CPU per route + V8 profiles) and `perf:cpu:remote -- --url https://<name>.workers.dev` (GET-only, reads a `wrangler tail` file). `Docs/Engineering/CPU-PROFILE.md` |
| `perf/lesson-content-cache` | — | **on hold** (#69 closed) | Per-lesson/course `unstable_cache` content. Locally it made lesson pages slower (20 → 31 ms) because cache reads are in-process; revisit after a workers.dev measurement |
| `chore/status-hardening-batch` | — | merged (#23) | Status doc; git/eslint ignore `.claude/` |
| `deploy/opennext-cloudflare` | — | merged ([#24](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/24)) | `@opennextjs/cloudflare@1.20.9`, `getCloudflareContext()` bindings with local fallback, `wrangler.jsonc` local + `env.production` placeholders, R2 incremental cache, deploy scripts, `DEPLOYMENT.md` |
| `docs/project-status` | — | merged (#16) | This file + `AGENTS.md` pointer |
| `mission-08-commerce-scheduling` | — | merged (#17) | Mission 08 integration branch; sub-PRs #7–#13 |
| `ci/github-actions` | — | merged (#15) | CI workflow |
| `fix/security-quick-fixes` | — | merged (#14) | Security fixes, `AppError`/`ActionResult` |
| `decoded-hiring-v2/t_*-mission-08.1-*` (2) | — | stale | Early Mission 08.1 worktree branches, superseded. Safe to delete. |
| `mission-04*` … `mission-08*` | — | merged | Historical mission branches |

When adding a test suite, append it to the `package.json`
`test` script. Concurrent PRs doing the same will conflict on that one line, so keep both entries.

---

## 3. Blueprint delivery phases

Source of truth: `Docs/Reference/Decoded_Hiring_V2_Master_Blueprint_FINAL_v2.1.docx` (§20).

| Phase | Outcome | Status | Where |
|---|---|---|---|
| 0 Discovery & design | Foundation package (CONTEXT.md, PRODUCT-SPEC, UX-RULES, …) | **Partial.** Blueprint plus per-mission docs exist; most §18.6 foundation documents were never added to the repo (see §6). | `Docs/` |
| 1 Foundation | Repo, CI, Next.js/Cloudflare, Better Auth, D1/R2, observability, adapter seams | **Mostly done.** CI on `main` runs verify and Playwright E2E; provider adapters exist (Mission 08); deploy path prepared (not provisioned). | Missions 04, 08 |
| 2 Public website | Port public design + Website Analysis hierarchy | **Done** | Mission 04.5, `Docs/QA/` |
| 3 Content & admin | Studio, editor, Pages, Guides, Field Notes, Landing Pages, media, lifecycle | **Partial.** Guides, Field Notes, media and block editor done. Pages, Landing Pages and Trash/permanent-delete lifecycle not built. | Missions 04–05 |
| 4 Learning platform | Courses, sections/lessons/resources, player, progress, free enrollment | **Done** | Mission 06 |
| 5 Commerce & scheduling | Access modes, dormant checkout, booking types, holds, adapters, Studio control plane | **Done** (providers dormant). Not built: real provider adapters, Scheduling Agent, Workflows-based reminders, Command Center. | Mission 08 |
| 6 Website Editorial AI | Knowledge ingestion/retrieval, skills, memory, draft → review → publish | **Done** (FakeProvider in tests; OpenAI adapter needs credentials) | Mission 07 |
| 7 Hardening & growth | Security review, performance, crawler policy, analytics, Command Center, reliability automation | **In progress.** CI, security fixes and the first hardening batch are merged (#14, #15, #18–#22). The remaining backlog is in §5. | §5 below |
| 8 Launch | Acceptance, V1 content import, staging, DNS cutover, rollback | Not started | — |

---

## 4. What exists (by mission)

| Mission | Delivered | Doc |
|---|---|---|
| 04 | Production foundation, Guides vertical slice, Better Auth, D1/R2 bindings | `Docs/Engineering/MISSION-04-*.md` |
| 04.5 | Public responsive stabilization | `Docs/QA/PUBLIC-RESPONSIVE-STABILIZATION.md` |
| 05 | Field Notes publishing, revisions, shared publishing primitives | `Docs/Engineering/MISSION-05-FIELD-NOTES.md` |
| 06 | Learning platform: courses, curriculum studio, enrollment, progress, protected PDFs | `Docs/Engineering/MISSION-06-LEARNING-PLATFORM.md` |
| 07 | Website Editorial AI: knowledge upload/FTS5 retrieval, Aha Authority skill, memory, draft lifecycle, publish to Guides/Field Notes | `Docs/Engineering/MISSION-07-WEBSITE-EDITORIAL-AI.md` |
| 08 | Scheduling core, booking lifecycle and approval, Offers/access, provider-neutral adapters, orders/payment truth and durable orchestration, public coaching/workshop booking, **durable lead capture** (`lead_submissions`), Studio commerce control plane, business-event observability, D1-backed public rate limiting, Next 16.3.8 | `Docs/Engineering/MISSION-08-COMMERCE-SCHEDULING.md`, `Docs/Engineering/COMMERCE-SCHEDULING-SPEC.md` |

Lead forms now save to D1 (`lead_submissions`); the Studio inbox is `/admin/leads` (#60). No email or CRM
notification is sent while mailbox providers stay dormant.

---

## 5. Next steps (ordered queue)

Take the top unblocked item. Move items, don't delete them silently.

1. **[DECISION: Ahmed] First deploy.** The deploy path, `npm run admin:create` and Next 16.4 are on `main`. Follow the checklist in
   `Docs/Engineering/DEPLOYMENT.md`, which needs **Ahmed's decisions**:
   Cloudflare account and plan, D1/R2 names, domain, staging. **Ahmed wants to stay on Workers Free** (no revenue yet; 6–12 months before real traffic). Open technical items:
   - Workers Free: size is no longer a constraint (12.5 MiB of 64 MiB uncompressed, #67). **CPU (10 ms/request) is the risk.** Local warm p50 after the perf batch: public cached pages 4–10 ms, `/coaching` 8 ms (was 83), get-session 9 ms, learner/admin 15–30 ms, sign-in ~65 ms (scrypt; tolerated as occasional). Locally, emulated D1/R2 count as CPU; on the edge they are I/O.
   - **Edge measurement done (2026-11-08)** on the CPU test env, public routes, anonymous. Baseline CPU p50 5–11 ms, p95 10–26 ms; first render of an uncached article 54–71 ms; no 1102 errors. **With `enableCacheInterception: true`** (one line in `open-next.config.ts`): cached public pages p50 **3–5 ms**, p95 6–10 ms. Remaining spikes: first render of an article after deploy (135–331 ms, cold), `/sitemap.xml` (force-dynamic, p50 10 ms), `/admin/login` p50 10 ms. Full analysis: Codex report (scratchpad `cpu-analysis.md`), specs summarised below.
   - **Next (agent):** PR enabling cache interception, verified at Worker level (preview `?preview=true`, publish → edit → unpublish → rename invalidation, server actions, HEAD) since e2e runs against `next dev`, not the Worker. Then: prewarm published article URLs after deploy (or snapshot-based `generateStaticParams`); cache `/sitemap.xml`. Learner/admin pages not measured yet (needs test accounts on the test env).
   - Held lesson-content cache (`perf/lesson-content-cache`): re-measure on the edge before deciding.
   - `/guides` and `/field-notes` are prerendered from the *build machine's* D1. Choose
     `revalidate`, dynamic rendering or `populateCache`. On-demand revalidation now works on Workers (D1 tag cache, #73).
   - ~~Remote-safe admin seed script~~: done (#29).
   - ~~Upgrade to Next ≥ 16.4.1 and the current adapter~~: done (#31).
   - ~~Size headroom ~6% of 3 MiB gzip~~: the compressed limit is gone; CI gates 20 MiB uncompressed (#67).
2. **Phase 7 hardening backlog** (from the 2026-10-24 audit; check whether Mission 08 already covers an item before starting it):
   - ~~Tests share the local dev D1~~: done (#20).
   - ~~Duplicated progress maths, 0-required case~~: done (#21).
   - ~~Learner page renders write to D1~~: done (#30).
   - ~~Admin gate repeated per page; `getAuth()` per call~~: done (#22). A layout/`proxy.ts` gate was rejected because `/admin/login` lives under the admin layout.
   - ~~The migration runner re-executes every file~~: done (#27).
   - Enrollment cancellation: no flow sets `cancelled`, and `enrollFree` reactivates it. Decide the policy first.
   - Lifecycle gaps: ~~archived lessons can be republished~~ (done, #30). ~~slug changes break URLs~~ (done, #35). Still open: Trash/restore/permanent delete (blueprint §5).
   - Rate limiting/Turnstile: ~~Better Auth limits~~ (done, #28). Turnstile still isn't wired; it needs Cloudflare site keys. ~~`public_rate_limits` rows are never pruned~~ (done, #34).
   - ~~No Content-Security-Policy~~ (done, #38, with `'unsafe-inline'`; tighten later with hashes or Report-Only).
   - ~~CI runs 3 of 5 Playwright specs~~ (done, #37).
   - ~~22 npm audit advisories~~ (done, #36). 4 moderate dev-only remain; remove the 2 `overrides` when miniflare and `@node-minify/core` update (`Docs/Engineering/DEPENDENCY-AUDIT.md`).
   - **CI stability:**
     - ~~mission-07 e2e slow and flaky~~ (done, #44).
     - ~~`slots-equivalence` ECONNRESET flake under load~~ (done, #74).
     - `mission-06-learning-platform` "✓ Completed" timeout: the hydration fix (#56) didn't stop it; it failed again on `main` (run 40293257373). #64 (merged) waits up to 30 s for the first server-action compile and D1 write, and surfaces the button's error. Confirm across later CI runs.
     - `workerd … Failed to get handler to worker` noise: confirmed by a CI experiment, 3 lines per run on `main` and 0 with the local binding removed. Fixed by #63 (merged).
   - Check one lesson with a real YouTube video under the CSP in staging (the seed has none).
   - **From the threat model (#33), not yet scheduled:**
     - ~~Public intake limits aren't per-IP~~ (done, #42).
     - ~~Image uploads trust the client MIME type~~ (done, #41).
     - ~~The admin audit trail is partial~~ (done, #55). Left: audit writes are not atomic with mutations (`buildAdminAuditStatement` is ready), no retention, no tamper evidence.
     - ~~No 2FA for admin~~ (done, #57). Left: no passkeys; a single flat `admin` role; the plugin's disable needs only the password; preview routes and `course-resources` reads skip the 2FA gate.
     - ~~No Dependabot/CodeQL/`npm audit` in CI~~ (done, #40). Dependabot is active. Code scanning/GHAS is still needed for CodeQL on PRs.
     - Course PDFs stream with no signed URLs.
   - **From the Phase 0 docs (#54) ⚠ Divergences:**
     - Archive is terminal: nothing restores it, though the blueprint and CONTEXT expect it. No Trash. Lesson `archived` is unreachable.
     - ~~Leads never leave `NEW`~~ (done, #60).
     - `ActionResult` is used only by editorial AI and leads. Other actions still use their own `ActionState`. ~~`offers/service.ts` throws plain `Error`~~ (#61).
     - ~~`isSafeMediaUrl` accepts external covers~~ (#61).
     - ~~`business_events` model, pruning and write-on-read~~ (#62). Retention of 400 days is a policy default until the analytics decision.
     - ~~`DEFINITION-OF-DONE.md` and `ARCHITECTURE.md` are stale~~ (#59).
   - **CI minutes:** the Playwright job took about 19 min on #64, #63 and #60, against 8–9 min on #61 and 3 min locally. Find out why (runner variance, the 30 s waits, or the cold dev-server compile), and consider running e2e only on PRs that touch `src/` or `e2e/`, to cut billed minutes.
   - **Deferred toolchain majors:**
     - TypeScript 7 (#52): `typescript-eslint` doesn't support it.
     - ESLint 10 (#51): plugins under `eslint-config-next@16.4.2` (`import`, `jsx-a11y`, `react`) peer-depend on ESLint ≤ 9.

     Dependabot ignores both majors (and `eslint-config-next` majors). Revisit with the next Next.js upgrade.
   - **From the performance budget (#33):**
     - ~~Dynamic `searchParams` pages and unneeded `force-dynamic`~~ (done, #43). ~~`/coaching` and `/workshop` stay dynamic~~: cached shells with client-loaded slots (#68). Check ISR with the R2 cache in staging.
     - No Lighthouse/CWV/geo-TTFB measurement yet.
   - Performance budget: ~~hero PNGs → WebP~~ (done, #19). Still to do: a `next/image` loader for Cloudflare, and Lighthouse/bundle checks in CI.
   - Hygiene: ticket-reference comments ("review correction H"), 9.4k lines of global CSS, `prototypes/` and the `.docx` in git, ~10 GB of local `.worktrees/`. Subagent worktrees under `.claude/worktrees/` can be removed with `git worktree remove` once their PRs merge.
3. **Phase 7 growth (blueprint §16–17):** analytics provider activation (PostHog via
   Zaraz, consent first), Command Center, crawler policy, IndexNow, reliability
   automation. Each needs a spec before implementation.
4. **Phase 0 debt:** write the missing foundation documents (§6) as features touch them. `CONTEXT.md` and `DEFINITION-OF-DONE.md` are done (#25); `SECURITY-THREAT-MODEL.md`, `PERFORMANCE-BUDGET.md` and `ARCHITECTURE.md` are done (#33). Resolve CONTEXT.md's 12 ⚠ conflicts with Ahmed.
5. **Phase 8 launch:** acceptance run, selective V1 content import, staging review, DNS cutover, rollback plan.

---

## 6. Gaps against the blueprint

- **Foundation documents missing** (blueprint §18.6): `PRODUCT-SPEC.md`,
  `UX-RULES.md`, `PAGE-TYPE-SPECS.md`, `SYSTEM-DESIGN.md`,
  `ENGINEERING-STANDARDS.md`,
  `CONTENT-MODEL.md`, `ANALYTICS-EVENTS.md`, `COMMAND-CENTER-SPEC.md`, `AGENT-SKILLS.md`,
  `RELIABILITY-AUTOMATION.md`, `docs/adr/`. (`CONTEXT.md` and `DEFINITION-OF-DONE.md` exist since #25.)
  Only `COMMERCE-SCHEDULING-SPEC.md` exists (Mission 08).
- **Not built:** standard Pages, Landing Pages, course sales pages, Trash lifecycle,
  Command Center, Scheduling & Communications Agent, Cloudflare Workflows-based reminders,
  real provider adapters (payment/calendar/mail/meeting), analytics/tag layer.
- **Outside this repo by design:** Hermes + Postiz social loop (local Mac).

---

## 7. Decisions waiting on Ahmed

| Decision | Blocks |
|---|---|
| Cloudflare account / domain / staging approach (plan: **Free**, decided 2026-11) | Deploy path, workers.dev CPU measurement, launch |
| Payment provider (none chosen by design) | Paid checkout activation |
| Calendar/mailbox provider (Google Workspace likely) | Real scheduling, invites, reminders |
| LLM provider + credentials for Editorial AI | Real draft generation (tests use FakeProvider) |
| Analytics activation and consent policy (PostHog/Zaraz/GA4) | Measurability gate, Command Center |
| Enrollment cancellation policy | Cancel flow, `enrollFree` reactivation rule |
| Enable GitHub code scanning/GHAS (optional; Dependabot is already active) | CodeQL on PRs |
| Restore semantics for archived content and whether to build Trash (from #54) | Lifecycle work |
| `business_events` retention (400 days by default) and the D1 write-headroom budget (raised from 50k to 60k/day by #62) | Analytics/consent policy, Workers plan choice |

---

## 8. Working conventions

- **Gates** (all must pass before a PR is ready): `npm run lint`, `npm run typecheck`,
  `npm test`, `npm run db:migrate:local && npm run build` (with `BETTER_AUTH_SECRET` set),
  and the relevant Playwright spec (`npm run test:e2e`; needs `.env.local` admin vars, see `.env.example`).
- **Next.js 16 differs from older docs.** Read `node_modules/next/dist/docs/` before writing framework code (`AGENTS.md`).
- **Errors:** user-facing failures throw `AppError` (`src/lib/errors.ts`). Server actions
  return `ActionResult` via `toActionResult()` (`src/lib/action-result.ts`) and never leak
  raw messages. Mission 08 domains use their own `*DomainError` classes with safe fallbacks.
- **Branches/PRs:** one branch per task, PR to `main` (or to the mission integration
  branch). Parallel subagents work in isolated worktrees under `.claude/worktrees/`
  (git- and lint-ignored). They commit to `hardening/*`-style branches, and the
  coordinator reviews, pushes and opens PRs. Mission merges need Ahmed's explicit GO. Never deploy or touch production
  resources without approval.
- **Docs:** each mission keeps its own `Docs/Engineering/MISSION-XX-*.md`. This file is the cross-mission index and queue. Vocabulary: `Docs/CONTEXT.md`. Quality gates: `Docs/DEFINITION-OF-DONE.md`. Deploy: `Docs/Engineering/DEPLOYMENT.md`.

---

## 9. Session log

Newest first. One entry per task: date, what changed, branch/PR, what's next.

- **2026-11-08.** First Cloudflare resources (Ahmed's account, Free plan, R2 enabled): throwaway CPU test env `dh-cputest` on hdv2.workers.dev. Codex (gpt-6.1-sol, high) wrote `env.cputest` and a sanitized seed SQL (public content, no auth rows); the coordinator imported it, deployed with `opennextjs-cloudflare deploy --env cputest`, set `BETTER_AUTH_SECRET`, and measured with `perf:cpu:remote` + `wrangler tail`. Startup 14–15 ms. Codex analysed the tail and the OpenNext request path; its top fix, cache interception, cut cached public pages from p50 5–11 ms to 3–5 ms on the edge (A/B on the same env). Not on `main` yet; no production deploy.

- **2026-11-08.** Dependabot #70 (9 minor/patch: better-auth 1.7.15, next/eslint-config-next 16.4.3, motion 14.9, lucide-react 1.66, @opennextjs/cloudflare 1.20.15, wrangler 4.156.0, workers-types, @types/node) merged (`44b8820`).
  - Two Codex (gpt-6.1-sol, high) reviewers diffed old vs new installed package code against our usage; all SAFE, no code changes. Coordinator spot-checked the D1 tag-cache diff and auth hooks.
  - OpenNext 1.20.15 fixes on-demand ISR pages (`/guides/[slug]`, `/field-notes/[slug]`) falling back to 1 s revalidation on another instance.
  - Local CI green (Worker 12,577 KiB uncompressed). No open PRs.

- **2026-11-08.** Free-plan perf batch. Ahmed chose to stay on Workers Free, so the work went to CPU per request.
  - Profiled every route locally with the new `perf:cpu` tool (#72). Hot spots: slot generation on `/coaching` (`getTimezoneOffsetMs`), Drizzle `extractTablesRelationalConfig` on every `getDb()`, Better Auth scrypt on sign-in.
  - Codex (gpt-6.1-sol, high) did the bulk implementation in worktrees; the coordinator reviewed and committed (Codex's sandbox can't write `.git`).
  - Merged in order, each updated from `main` and verified with the local CI mirror: #68 (`ad88810`), #74 (`2c69f8d`), #67 (`0f935d1`), #71 (`c4a04df`), #73 (`1aeab68`), #72 (`96222e7`).
  - #74 was new: #67's CI exposed an `ECONNRESET` flake in #68's `slots-equivalence` test on a loaded machine (load average ~20). Cause and fix are in the PR.
  - #69 split: the D1 tag cache became #73; the per-lesson content cache is on hold (made lesson/course pages slower locally). Branch kept.
  - Before → after (local warm p50): `/coaching` 83 → 8 ms, `/workshop` 13 → 9, get-session 12 → 9. Cached public pages went 4–6 → 7–10 ms, probably the tag-cache D1 check running in-process locally; confirm on the edge.
  - Nothing deployed. Worktrees removed; `perf/lesson-content-cache` kept.
  - Next: Ahmed creates a Cloudflare account → workers.dev preview → `perf:cpu:remote`. Triage Dependabot #70.

- **2026-10-26.** Batch 7: five Sonnet subagents; the coordinator reviewed them and opened #59–#63.
  - The workerd experiment pushed a throwaway `experiment/worker-self-ref-a` branch, which is now deleted.
  - That agent also noticed mission-06 failing on `main` after #56, which disproved the hydration theory. The coordinator opened #64, which passed 4/4 locally on fresh state.
  - None of batch 7 is merged yet.
  - Corrections in this doc: the spec count is 7 (not 6), and only the admin unit suites set `ADMIN_REQUIRE_2FA`.
  - Merged in order: #64 (`8f8f272`), #63 (`ad03aa3`), #61 (`0a1a5ab`) and #60 (`d40ed37`), each green on GitHub after being updated from `main`.
  - GitHub Actions then refused to start jobs (billing or spending limit). On Ahmed's instruction, #62 (`35fd901`), #59 (`ebbd9d4`) and this doc were verified locally and merged.
    - The local run mirrors `ci.yml` and `audit.yml`: `npm ci`, `npm audit --omit=dev --audit-level=high`, lint, typecheck, `npm test`, `db:migrate:local`, build, `cf:build` + `cf:size` (2858–2860 KiB), and `test:e2e:ci` (7 specs, 21 tests). It uses a fresh `DH_LOCAL_STATE_DIR` for the build, size and e2e stages; the unit tests isolate themselves.
    - A PR comment on each records the result.
  - Conflict resolutions:
    - #59's `ENGINEERING-STANDARDS.md` against #61, keeping both sets of changes.
    - #59 was updated to describe migrations through 0023.
  - Worktrees removed. No open PRs.
  - Next: Ahmed fixes Actions billing. Agent backlog: the CI-minutes item in §5, ActionResult adoption, Trash/restore once decided.

- **2026-10-26.** Batch 6: four Sonnet subagents. The coordinator reviewed them and opened #54–#57; none is merged.
  - #55 and #57 both generated migration `0021`, so the second to merge must be regenerated as `0022` (as with #35).
  - #57's caveats are recorded in §5: the server-side disable needs only the password, and the read-only admin paths are not 2FA-gated.
  - Merged in order, each updated from `main` and green on GitHub first: #56 (`0766a8e`), #54 (`816c6f9`), #55 (`103456f`), #57 (`8a8c9cf`), then this doc (#58).
  - #57's migration was regenerated as `0022_admin_two_factor` (same SQL; `drizzle-kit check` clean).
  - Two fixes were needed after merging `main` into #57:
    - #55's audit-trail suite now sets `ADMIN_REQUIRE_2FA=false`, because its admins have no 2FA.
    - The admin login specs call `waitForHydration` before filling: hydration was clearing the typed email and password. That was the "Please enter both email and password" failure.
  - Subagent worktrees removed. No open PRs.
  - Next: Ahmed's deploy and lifecycle decisions. Agent backlog: the #54 divergences, ActionResult adoption, `business_events` pruning, and the `WORKER_SELF_REFERENCE` Linux experiment.

- **2026-10-26.** Dependabot triage. Dependabot was already active and opened #46–#52 straight after #40.
  - Merged #46 (`upload-artifact` v7, `3f5cfe0`), #47 (`checkout` v7, `65874ad`), #48 (`setup-node` v7, `d49e0ac`) and #49 (12 minor/patch updates incl. React 19.3.1, better-auth 1.7.10, Playwright 1.64.1, `3b63238`). `main` CI was green on `3b63238`.
  - #50 (motion 14) was rebased by Dependabot and was green when merged (`aeb8e33`). 14.0 only removes internal APIs, and we use only `motion.*`, `animate` and `useReducedMotion` on the home components.
  - Closed with reasons: #52 (TypeScript 7 fails CI: typescript-eslint doesn't support it) and #51 (ESLint 10: the Next lint plugins aren't ESLint 10-compatible). `dependabot.yml` now ignores those majors. Branch `chore/dependabot-triage`.
  - Next: unchanged (Ahmed's deploy decisions; agent backlog in §5).

- **2026-10-25.** Batch 5: five Sonnet subagents in `.claude/worktrees`, reviewed by the coordinator, with PRs #40–#44 opened, none merged yet.
  - Coordinator fixes:
    - CodeQL is limited to manual runs on #40, because the repo is private.
    - Threat-model rows G6 and G11 are updated on #42 and #41.
  - #42 passed the full Playwright suite, even though every local request shares the `unknown` IP bucket.
  - Merged in order, each updated from `main` and green on GitHub first: #44 (`6ca3b5f`), #40 (`08c774c`), #41 (`dedd6a4`), #42 (`4a7c933`), #43 (`8ba9c11`), then this doc (#45).
  - The whole Playwright CI job dropped from ~10 min to 5.5–8 min.
  - The `update-merge-wait.sh` helper now waits on the `ci.yml` run. The new `audit.yml` run finishes first and was being picked up instead.
  - Subagent worktrees removed. No open PRs.
  - Next: Ahmed's first-deploy decisions. Agent backlog: admin audit trail, admin 2FA, signed PDF URLs, the `WORKER_SELF_REFERENCE` Linux experiment, Trash lifecycle, and the remaining Phase 0 docs.

- **2026-10-25.** Merged batch 4 in order: #33 (`2efc86d`), #36 (`08d476b`), #34 (`448440d`),
  #35 (`96d9fc9`), #37 (`a1b8fe5`), #38 (`217784a`), then this doc (#39). Each was updated
  from `main` and green on GitHub first.
  - #35's migration was regenerated as `0020_slug_redirects` after #34's 0019 (same SQL, no drift).
  - #38's first Playwright run flaked on mission-07; it passed on re-run and locally, and is now on the backlog.
  - Subagent worktrees removed. No open PRs.

  Next: Ahmed's first-deploy decisions (§7); agents can take the §5 backlog.

- **2026-10-24.** Batch 4: 6 parallel subagents (5 Sonnet, 1 Haiku). Reviewed and opened PRs #33–#38.
  - **npm audit:** the critical better-auth and high drizzle-orm advisories were only in copies under the
    unused `@better-auth/cli`, not production. zod was real runtime exposure and is fixed.
  - **Coordinator changes during review:**
    - #34: windows longer than the pruning retention now throw.
    - #38: fixed the anonymous `/learn` null-session crash.
    - Merge tooling: the `package.json` resolver handles deletions and new sections, unions the `test` and
      `test:e2e:ci` lines, and the lockfile is regenerated after merges.

  Next: merge batch 4 in the §2 order.

- **2026-10-24.** Merged batch 3 in order: #25 (`5729969`), #27 (`390c7c9`), #30 (`28e4cb7`),
  #28 (`f79bc68`), #29 (`d70350d`), #26 (`18cc695`), #31 (`2d15662`), then this doc (#32).
  Each was updated from `main` and green on GitHub before merging; #31 also passed the new
  size-budget job. `package.json` conflicts were resolved by a key-wise three-way merge
  (the `test` line is the union, 28 suites), and #31's `DEPLOYMENT.md` conflict kept both
  the new size and the budget note. Subagent worktrees removed. No open PRs.
  Next: Ahmed's first-deploy decisions (§7); agents can take the remaining §5 backlog.

- **2026-10-24.** Batch 3: 7 parallel subagents (Sonnet). Reviewed and opened PRs #25–#31,
  all green on CI. Coordinator changes made during review:
  - #27: strict migrations are recorded atomically in one D1 batch.
  - #28: `/get-session` is exempt from the rate limiter, since it would cost a D1 write per read.
  - #31: adapter pinned to 1.20.12 (at least 7 days old) instead of 1.20.13.

  Next: merge in the §2 order, then Ahmed's first-deploy decisions.

- **2026-10-24.** Merged PR #24 (deploy-path prep) into `main` after green CI (verify +
  Playwright on `b58e34c`). No open PRs. Next: Ahmed's provisioning decisions for the first
  deploy (§7, `DEPLOYMENT.md`). Agent work that can proceed meanwhile: the remaining §5 hardening
  backlog, a remote-safe admin seed script, and the Next 16.4 + adapter upgrade.

- **2026-10-24.** Prepared the deploy path on `deploy/opennext-cloudflare`, without deploying:
  - Adapter pinned to 1.20.9, the newest release that supports Next 16.3.8.
  - Bindings use `getCloudflareContext()` and fall back to the local proxy; wrangler is never bundled.
  - Local and `env.production` wrangler config; R2 incremental cache; `cf:build`, `preview`,
    `deploy` and `db:migrate:remote` scripts; `.wrangler/**` lint-ignored.
  - Verified: OpenNext build; dry-run 2.78 MiB gzipped; built Worker in `wrangler dev` served
    pages, read and wrote D1 (sign-up and session), and returned images.
  - Gates: 420/420 tests, lint, typecheck, build.

  Next: merge, then Ahmed's provisioning decisions.

- **2026-10-24.** Merged the hardening batch in order: #18 (`f6c3da4`), #20 (`7aa9eed`),
  #21 (`98a8419`), #22 (`58fae72`), #19 (`b245c4e`). Each was brought up to date with
  `main` first and was green on GitHub (verify + Playwright E2E) before merging. #22's
  `package.json` test line was resolved to keep both new suites. Next: deploy path
  (needs Ahmed's Cloudflare/domain choices), then the rest of the §5 backlog.

- **2026-10-24.** Hardening batch run as 5 parallel subagents (Sonnet ×4, Haiku ×1),
  reviewed and opened as PRs #18 (Playwright CI), #19 (images −96%), #20 (isolated test
  DB), #21 (progress maths), #22 (auth cache + admin gate). `.claude/` is git- and
  lint-ignored. Next: merge the batch in the §5 order, then the deploy path.

- **2026-10-24.** Merged PR #14 (security fixes; CI green on `192f4df`) and PR #16 (this doc)
  into `main`. Next: hardening batch (Playwright in CI, progress maths, auth caching and admin
  gate, isolated test DB, image budget), run as parallel subagent branches.

- **2026-10-24.** **Merged PR #15 (CI) into `main`** (`f4ce20b`). Brought #14 up to date
  (`192f4df`: `package.json` scripts resolved to keep `next typegen` typecheck,
  `db:migrate:local`, all Mission 08 suites plus `security-quick-fixes`), and CI now runs on it.
  Next: merge #14 when CI is green, then #16, then add Playwright to CI.

- **2026-10-24.** **Merged PR #17 (Mission 08) into `main`** on Ahmed's GO (`b380609`, merge commit).
  Brought #15 up to date (`a8a8ee5`: kept Mission 08 suites and `test:e2e:ci` plus #15's
  `typecheck`/`db:migrate:local`). Brought #14 up to date (`a27c27b`: kept Mission 08's
  Offer-based access logic and made its throws `AppError`; local gates 411/411 plus build).
  #15 GitHub CI passed on `a8a8ee5`. Next: merge #15, then #14, then #16.

- **2026-10-24.** Opened PR #17 (`mission-08-commerce-scheduling → main`, not merged).
  Removed the leftover `mission-08-6`/`mission-08-7` temp validation workflows (`e0e2ae6`).
  Local gates on the PR head: lint, typecheck, 399/399 tests, build all pass. Next: Ahmed's GO on #17, then #15, then #14.

- **2026-10-24.** Full audit of `main`. Opened PR #14 (open-redirect, reconcile race,
  typed public errors including Mission 07 editorial AI) and PR #15 (CI; fixes
  fresh-checkout build/typecheck). Created this status document. Next: Ahmed's GO on
  Mission 08, then rebase #15 and #14 onto it.
