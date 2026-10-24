# Decoded Hiring V2 — Project Status & Roadmap

**This is the living hand-off document for every agent and contributor.**

- **Read it first**, before starting any task.
- **Update it last**, at the end of every task that changes code, branches, PRs or plans:
  edit the snapshot, the branch/PR map, the next-steps queue and the session log
  at the bottom. Keep it short and factual. Link to mission docs for detail.
- If this file disagrees with the code or GitHub, the code/GitHub wins. Fix this file.

Last updated: **2026-10-24**

---

## 1. Where we stand (snapshot)

| | |
|---|---|
| `main` | `b245c4e`: **Missions 01–08 + CI (verify + Playwright E2E) + security fixes + hardening batch** (#18–#22, merged 2026-10-24). Unit tests: 24 suites, each on its own throwaway D1/R2. |
| Open PRs to `main` | Deploy-path prep (`deploy/opennext-cloudflare`, see §2) |
| Production | **Not deployed.** The OpenNext adapter and config are prepared and verified locally (`Docs/Engineering/DEPLOYMENT.md`). No real Cloudflare resources exist yet; `wrangler.jsonc → env.production` holds placeholders. |
| Providers | All dormant by design: no payment, calendar, mailbox, meeting or analytics provider is active. |
| Blueprint phase | Phases 1–6 built and on `main`. **Phase 7 (Hardening & Growth) is in progress** (CI merged; #14 open), then Phase 8 (Launch). |

---

## 2. Branch & PR map

| Branch | Base | State | What it is |
|---|---|---|---|
| `main` | — | current | Missions 01–08 + CI + security fixes + hardening batch |
| `hardening/*` (5) | — | merged (#18–#22) | Playwright CI, images, isolated test DB, progress maths, auth cache/admin gate |
| `chore/status-hardening-batch` | — | merged (#23) | Status doc; git/eslint ignore `.claude/` |
| `deploy/opennext-cloudflare` | `main` | PR open | `@opennextjs/cloudflare@1.20.9`, `getCloudflareContext()` bindings with local fallback, `wrangler.jsonc` local + `env.production` placeholders, R2 incremental cache, deploy scripts, `DEPLOYMENT.md` |
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

Lead forms now save to D1 (`lead_submissions`) for Studio review. No email or CRM
notification is sent while mailbox providers stay dormant.

---

## 5. Next steps (ordered queue)

Take the top unblocked item. Move items, don't delete them silently.

1. **Merge the deploy-path PR** once CI is green. Then the first deploy follows the
   checklist in `Docs/Engineering/DEPLOYMENT.md`, which needs **Ahmed's decisions**:
   Cloudflare account and plan, D1/R2 names, domain, staging. Open technical items:
   - Workers Free limits: 2.78 MiB of 3 MiB gzipped; 10 ms CPU, which SSR likely exceeds.
   - `/guides` and `/field-notes` are prerendered from the *build machine's* D1. Choose
     `revalidate`, dynamic rendering or `populateCache`.
   - A remote-safe admin seed script.
   - Upgrade to Next ≥ 16.4.1 with adapter 1.20.13+ and wrangler ≥ 4.148.
2. **Phase 7 hardening backlog** (from the 2026-10-24 audit; check whether Mission 08 already covers an item before starting it):
   - ~~Tests share the local dev D1~~: done (#20).
   - ~~Duplicated progress maths, 0-required case~~: done (#21).
   - Learner page renders write to D1 (completion reconcile on read). Move reconcile to write paths.
   - ~~Admin gate repeated per page; `getAuth()` per call~~: done (#22). A layout/`proxy.ts` gate was rejected because `/admin/login` lives under the admin layout.
   - The migration runner re-executes every file. Rely on wrangler's tracked migrations.
   - Enrollment cancellation: no flow sets `cancelled`, and `enrollFree` reactivates it. Decide the policy first.
   - Lifecycle gaps: archived lessons can be republished; slug changes break URLs with no redirects; Trash/restore/permanent delete (blueprint §5) is missing.
   - Rate limiting/Turnstile: Mission 08 added a D1 fixed-window limiter for public booking, leads and telemetry. Better Auth sign-in/sign-up still need limits, and Turnstile is not wired anywhere.
   - Performance budget: ~~hero PNGs → WebP~~ (done, #19). Still to do: a `next/image` loader for Cloudflare, and Lighthouse/bundle checks in CI.
   - Hygiene: ticket-reference comments ("review correction H"), 9.4k lines of global CSS, `prototypes/` and the `.docx` in git, ~10 GB of local `.worktrees/`. Subagent worktrees under `.claude/worktrees/` can be removed with `git worktree remove` once their PRs merge.
3. **Phase 7 growth (blueprint §16–17):** analytics provider activation (PostHog via
   Zaraz, consent first), Command Center, crawler policy, IndexNow, reliability
   automation. Each needs a spec before implementation.
4. **Phase 0 debt:** write the missing foundation documents (§6) as features touch them. Start with `CONTEXT.md` (glossary) and `DEFINITION-OF-DONE.md`.
5. **Phase 8 launch:** acceptance run, selective V1 content import, staging review, DNS cutover, rollback plan.

---

## 6. Gaps against the blueprint

- **Foundation documents missing** (blueprint §18.6): `CONTEXT.md`, `PRODUCT-SPEC.md`,
  `UX-RULES.md`, `PAGE-TYPE-SPECS.md`, `SYSTEM-DESIGN.md`, `ARCHITECTURE.md`,
  `ENGINEERING-STANDARDS.md`, `SECURITY-THREAT-MODEL.md`, `PERFORMANCE-BUDGET.md`,
  `CONTENT-MODEL.md`, `ANALYTICS-EVENTS.md`, `COMMAND-CENTER-SPEC.md`, `AGENT-SKILLS.md`,
  `RELIABILITY-AUTOMATION.md`, `DEFINITION-OF-DONE.md`, `docs/adr/`.
  Only `COMMERCE-SCHEDULING-SPEC.md` exists (Mission 08).
- **Not built:** standard Pages, Landing Pages, course sales pages, Trash lifecycle,
  Command Center, Scheduling & Communications Agent, Cloudflare Workflows-based reminders,
  real provider adapters (payment/calendar/mail/meeting), analytics/tag layer.
- **Outside this repo by design:** Hermes + Postiz social loop (local Mac).

---

## 7. Decisions waiting on Ahmed

| Decision | Blocks |
|---|---|
| Cloudflare account / domain / staging approach | Deploy path, launch |
| Payment provider (none chosen by design) | Paid checkout activation |
| Calendar/mailbox provider (Google Workspace likely) | Real scheduling, invites, reminders |
| LLM provider + credentials for Editorial AI | Real draft generation (tests use FakeProvider) |
| Analytics activation and consent policy (PostHog/Zaraz/GA4) | Measurability gate, Command Center |
| Enrollment cancellation policy | Cancel flow, `enrollFree` reactivation rule |

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
- **Docs:** each mission keeps its own `Docs/Engineering/MISSION-XX-*.md`. This file is the cross-mission index and queue.

---

## 9. Session log

Newest first. One entry per task: date, what changed, branch/PR, what's next.

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
