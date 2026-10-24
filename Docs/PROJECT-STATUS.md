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
| `main` | `b380609`: **Missions 01–08 merged** (foundation, public site, Guides, Field Notes, Learning Platform, Website Editorial AI, Commerce & Scheduling). Mission 08 merged via PR #17 on Ahmed's GO, 2026-10-24. |
| Open PRs to `main` | #15 CI workflow, #14 security fixes, #16 this status doc. All are up to date with `main` and mergeable. |
| Production | **Not deployed.** Local-only (Miniflare D1/R2). No deploy adapter, no real Cloudflare resources. |
| Providers | All dormant by design: no payment, calendar, mailbox, meeting or analytics provider is active. |
| Blueprint phase | Phases 1–6 built and on `main`. **Phase 7 (Hardening & Growth) is in progress** (PRs #14, #15), then Phase 8 (Launch). |

---

## 2. Branch & PR map

| Branch | Base | State | What it is |
|---|---|---|---|
| `main` | — | current | Missions 01–08 (`b380609`) |
| `ci/github-actions` | `main@b380609` | PR [#15](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/15) open, mergeable | `.github/workflows/ci.yml` (lint, typecheck, unit tests, local migrations, build), `npm run db:migrate:local`, `typecheck` runs `next typegen`. Merged with `main` at `a8a8ee5`; GitHub CI green on all 21 suites including Mission 08. |
| `fix/security-quick-fixes` | `main@b380609` | PR [#14](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/14) open, mergeable | Open-redirect fix, race-safe enrollment reconcile, typed public errors (`AppError`, `ActionResult`) incl. Mission 07. Merged with `main` at `a27c27b`; local gates 411/411. |
| `docs/project-status` | `main@b380609` | PR [#16](https://github.com/Ahmedawad8822/Decoded-Hiring-V2/pull/16) open | This file + `AGENTS.md` pointer |
| `mission-08-commerce-scheduling` | — | merged (#17) | Mission 08 integration branch; sub-PRs #7–#13 |
| `decoded-hiring-v2/t_*-mission-08.1-*` (2) | — | stale | Early Mission 08.1 worktree branches, superseded. Safe to delete. |
| `mission-04*` … `mission-08*` | — | merged | Historical mission branches |

**Merge conflict to expect:** #14 and #15 both edit the `package.json` scripts
block. Whichever merges second needs a one-line resolution: keep #15's `typecheck`
and `db:migrate:local`, and keep the `test` list with `security-quick-fixes` appended.

---

## 3. Blueprint delivery phases

Source of truth: `Docs/Reference/Decoded_Hiring_V2_Master_Blueprint_FINAL_v2.1.docx` (§20).

| Phase | Outcome | Status | Where |
|---|---|---|---|
| 0 Discovery & design | Foundation package (CONTEXT.md, PRODUCT-SPEC, UX-RULES, …) | **Partial.** Blueprint plus per-mission docs exist; most §18.6 foundation documents were never added to the repo (see §6). | `Docs/` |
| 1 Foundation | Repo, CI, Next.js/Cloudflare, Better Auth, D1/R2, observability, adapter seams | **Mostly done.** CI arrives with PR #15. Provider adapters exist (Mission 08). Deploy path missing. | Missions 04, 08 |
| 2 Public website | Port public design + Website Analysis hierarchy | **Done** | Mission 04.5, `Docs/QA/` |
| 3 Content & admin | Studio, editor, Pages, Guides, Field Notes, Landing Pages, media, lifecycle | **Partial.** Guides, Field Notes, media and block editor done. Pages, Landing Pages and Trash/permanent-delete lifecycle not built. | Missions 04–05 |
| 4 Learning platform | Courses, sections/lessons/resources, player, progress, free enrollment | **Done** | Mission 06 |
| 5 Commerce & scheduling | Access modes, dormant checkout, booking types, holds, adapters, Studio control plane | **Done** (providers dormant). Not built: real provider adapters, Scheduling Agent, Workflows-based reminders, Command Center. | Mission 08 |
| 6 Website Editorial AI | Knowledge ingestion/retrieval, skills, memory, draft → review → publish | **Done** (FakeProvider in tests; OpenAI adapter needs credentials) | Mission 07 |
| 7 Hardening & growth | Security review, performance, crawler policy, analytics, Command Center, reliability automation | **Next.** Started: PRs #14 and #15. | §5 below |
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

1. **Merge PR #15 (CI).** It's up to date with `main`, and its GitHub run on `a8a8ee5`
   **passed** (all 21 suites, including Mission 08). Ready to merge. After that, every PR gets checks.
   Follow-up: add Mission 08's `test:e2e:ci` (Playwright) as a second CI job; it needs
   the admin seed env vars from `.env.example` as CI secrets or fake values.
2. **Merge PR #14 (security fixes)** after #15. Merge `main` in first: resolve the
   `package.json` scripts conflict described in §2, then let CI run. Mission 08's actions
   already return safe results through their own domain errors; their
   `"Unauthorized:"`/`"Forbidden:"` prefix checks stay compatible because `AppError` keeps
   the same messages. Optional later step: unify Mission 08's `CommerceDomainError` /
   `SchedulingDomainError` / `LeadDomainError` with `AppError`.
3. **Merge PR #16 (this doc)** so `AGENTS.md` points every agent here.
4. **Phase 8 prerequisite: production deploy path.** Add `@opennextjs/cloudflare`.
   Switch `src/lib/cloudflare/bindings.ts` to `getCloudflareContext()`; the current
   `globalThis.__env__` path does not exist on OpenNext. Configure real D1/R2 IDs in
   `wrangler.jsonc`, set secrets, apply migrations with `wrangler d1 migrations apply`,
   and configure the OpenNext incremental cache so `revalidatePath` works.
   Needs Ahmed's choices: Cloudflare account, domain, preview/staging setup.
5. **Phase 7 hardening backlog** (from the 2026-10-24 audit; check whether Mission 08 already covers an item before starting it):
   - Tests share the local dev D1 (`.wrangler/state/v3`). Give each test run an isolated, throwaway database.
   - Progress maths is duplicated in `getEnrollmentProgress` and `getBatchedEnrollmentProgress`. Extract one pure function, and fix the 0-required-lessons case (100% but not completed).
   - Learner page renders write to D1 (completion reconcile on read). Move reconcile to write paths.
   - Admin authorization is repeated per page. Centralize it in the admin layout or `proxy.ts`.
   - `getAuth()` builds a Better Auth instance per call. Use React `cache()` per request.
   - The migration runner re-executes every file. Rely on wrangler's tracked migrations.
   - Enrollment cancellation: no flow sets `cancelled`, and `enrollFree` reactivates it. Decide the policy first.
   - Lifecycle gaps: archived lessons can be republished; slug changes break URLs with no redirects; Trash/restore/permanent delete (blueprint §5) is missing.
   - Rate limiting/Turnstile: Mission 08 added a D1 fixed-window limiter for public booking, leads and telemetry. Better Auth sign-in/sign-up still need limits, and Turnstile is not wired anywhere.
   - Performance budget: 2 MB hero PNGs to AVIF/WebP; set up a `next/image` loader for Cloudflare; Lighthouse/bundle checks in CI.
   - Hygiene: ticket-reference comments ("review correction H"), 9.4k lines of global CSS, `prototypes/` and the `.docx` in git, ~10 GB of local `.worktrees/`.
6. **Phase 7 growth (blueprint §16–17):** analytics provider activation (PostHog via
   Zaraz, consent first), Command Center, crawler policy, IndexNow, reliability
   automation. Each needs a spec before implementation.
7. **Phase 0 debt:** write the missing foundation documents (§6) as features touch them. Start with `CONTEXT.md` (glossary) and `DEFINITION-OF-DONE.md`.
8. **Phase 8 launch:** acceptance run, selective V1 content import, staging review, DNS cutover, rollback plan.

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
  raw messages. *(Lands with PR #14.)*
- **Branches/PRs:** one branch per task, PR to `main` (or to the mission integration
  branch). Mission merges need Ahmed's explicit GO. Never deploy or touch production
  resources without approval.
- **Docs:** each mission keeps its own `Docs/Engineering/MISSION-XX-*.md`. This file is the cross-mission index and queue.

---

## 9. Session log

Newest first. One entry per task: date, what changed, branch/PR, what's next.

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
