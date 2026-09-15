# Mission 04.5 — Public Responsive Stabilization QA Report

**Project:** Decoded Hiring V2  
**Baseline Commit:** `87cc898ae58c9d395616de4033f19410b5b69c7f`  
**Branch:** `mission-04.5-responsive-stabilization`  
**Date:** September 15, 2026  
**QA Status:** PASS (All 13 routes × 8 viewports verified with zero horizontal overflow, 100% automated test, typecheck, lint, and build pass)

---

## 1. Scope

The mission objective is a responsive QA and stabilization pass across the entire **public** Decoded Hiring V2 website. The restored V1 visual identity and approved Mission 04 Guide architecture were preserved without alteration. Field Notes and Mission 05 features were kept strictly out of scope.

### Routes in Scope (13 routes):
- `/` (Homepage)
- `/programmes` (Programmes Overview)
- `/mission-01` (Mission 01 Classroom)
- `/workshop` (Team Workshop)
- `/coaching` (Recruitment Coaching)
- `/about` (About Ahmed Awad)
- `/contact` (Context Intake)
- `/ai-recruiter-os` (Research Waitlist)
- `/guides` (Guide Index)
- `/guides/[slug]` (Guide Detail — `talent-acquisition-strategy`)
- `/privacy` (Privacy Notice)
- `/terms` (Terms of Use)
- `/cookies` (Cookies & Analytics Notice)

---

## 2. Viewports Tested (8 target widths)

1. **320px** — Small mobile (iPhone SE / compact Android)
2. **375px** — Standard mobile (iPhone 12/13/14/15 mini & standard)
3. **430px** — Large mobile (iPhone Pro Max / Plus)
4. **768px** — Tablet portrait (iPad mini / standard portrait)
5. **1024px** — Tablet landscape / small laptop
6. **1280px** — Standard desktop / MacBook Air
7. **1440px** — Standard widescreen laptop / monitor
8. **1728px** — Large desktop display / Studio Display

Total permutations tested: **104 route-viewport combinations**.

---

## 3. Findings Classified (A–E)

### Category A: Responsive Bugs
- **A1 — Guide Index Grid Column Track Overflow on Narrow Viewports (≤ 360px):**
  - *Location:* `src/app/(site)/guides/page.tsx`
  - *Defect:* Grid template used `repeat(auto-fit, minmax(320px, 1fr))`. On screens with 320px viewport, container gutters (40px total) leave 280px of available space. Enforcing a 320px minimum track caused potential card clipping or container distortion.
  - *Resolution:* Updated to `repeat(auto-fit, minmax(min(100%, 300px), 1fr))`. Cards now fluidly adapt to 280px on 320px viewports while retaining 300px+ column tracks on larger viewports.
- **A2 — Hero Aside Decorative Orbit Containment:**
  - *Location:* `src/app/master-design.css`
  - *Defect:* Decorative `.hg-orbits` element had negative inset offsets (`-6%`) and `.hg-orbit` children with `left: -9%`, extending past the right boundary on small viewports.
  - *Resolution:* Added `overflow: hidden;` directly to `#hg-master-draft .hg-orbits` and set `inset: 4% 0 7% 0` at `@media (max-width: 520px)`. This strictly bounds the animated orbits without clipping `.hg-hero-aside`, `.hg-portrait-wrap`, shadows, stamps, or focus indicators.
- **A3 — Test Runner Process Lifecycle & Handle Teardown:**
  - *Location:* `tests/mission-04-publishing.test.ts` & `src/lib/cloudflare/bindings.ts`
  - *Defect:* `npm test` passed all 7 security tests but hung indefinitely because Wrangler's `getPlatformProxy` left Miniflare/workerd IPC socket handles open in Node.js.
  - *Resolution:* Updated `src/lib/cloudflare/bindings.ts` to export `disposeCloudflareBindings()` and registered it in `test.after()`. Node.js drains all handles and terminates naturally with exit code 0 in ~2 seconds without using `process.exit(0)`.
- **A4 — ESLint Git Worktree Inclusion Failure:**
  - *Location:* `eslint.config.mjs` & `.gitignore`
  - *Defect:* `npm run lint` scanned untracked `.worktrees/**` directories, triggering 24,630 errors from foreign node_modules.
  - *Resolution:* Added `".worktrees/**"` to `globalIgnores` in `eslint.config.mjs` and added `.worktrees/` to `.gitignore`. `npm run lint` now passes with 0 errors and 0 warnings.

### Category B: Port Regressions
- None identified. High visual fidelity from the restored V1 port was verified across all 13 routes.

### Category C: Mobile Usability Issues
- **C1 — Navigation Dropdown Dismissal & Mutual Exclusivity:**
  - *Location:* `src/components/site/site-header-client.tsx`
  - *Defect:* Native `<details className="hg-nav-menu">` elements did not close on `Escape` keypress, click-outside, or route navigation. Both Learn and Explore could remain open simultaneously.
  - *Resolution:* Attached `Escape` key listener, `pointerdown` click-outside dismissal, mutual exclusivity accordion handler (`onToggle`), and route-change cleanup (`usePathname`) to close open menus automatically.
- **C2 — Mobile Header Controls Touch Target Heights:**
  - *Location:* `src/app/master-design.css`
  - *Defect:* Header control buttons and summaries had an interactive height of ~34px on mobile viewports (< 520px).
  - *Resolution:* Enforced `min-height: 44px; display: inline-flex; align-items: center;` on `.hg-page-control` and `.hg-login-entry` under `@media (max-width: 520px)`.
- **C3 — Mobile Footer Link Touch Targets (Correction 4):**
  - *Location:* `src/app/master-design.css`
  - *Defect:* Mobile footer links had a vertical height of ~19px, creating tight touch target clusters prone to accidental mis-taps.
  - *Resolution:* Set `min-height: 44px; padding-block: 8px; display: inline-flex; align-items: center; gap: 4px;` for `#hg-master-draft .hg-site-footer nav a` under `@media (max-width: 768px)`.

### Category D: Cross-Page Consistency Defects
- **D1 — Navigation Trigger Accessibility Association:**
  - *Location:* `src/components/site/site-header-client.tsx`
  - *Defect:* Nav menu `<summary>` elements lacked semantic connection to their dropdown panels.
  - *Resolution:* Added `id="nav-learn-popover"`, `id="nav-explore-popover"`, `id="nav-account-popover"` to popovers and `aria-controls` attributes to summary triggers.
- **D2 — Guide Index Caching Diagnostics (Correction 2):**
  - *Investigation:* Verified that `publishGuideAction`, `unpublishGuideAction`, and `updateGuideAction` in `src/features/guides/actions.ts` explicitly call `revalidatePath("/guides")`, `revalidatePath("/guides/[slug]")`, and `revalidatePath("/admin/content")`.
  - *Decision:* Retained static cacheability (`○ /guides`) without adding `force-dynamic`. The route renders statically and revalidates on publishing mutations.

### Category E: Subjective Design Preferences (Deliberately NOT Changed)
- Preserved editorial typography (Georgia headings, IBM Plex Mono kickers, Inter prose).
- Preserved asymmetrical layout compositions (Ahmed hero portrait, scenario lab, diagnostic cards).
- Preserved brand color palette (`--paper`, `--ink`, `--blue`, `--mint`, `--coral`).
- Preserved existing copy across all public routes.

---

## 4. Browser Verification Results

All 104 route-viewport permutations were verified with automated headless Chromium testing:

| Route | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | Status |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `/` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/programmes` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/mission-01` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/workshop` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/coaching` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/about` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/contact` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/ai-recruiter-os` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/guides` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/guides/[slug]` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/privacy` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/terms` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |
| `/cookies` | 320px | 375px | 430px | 768px | 1024px | 1280px | 1440px | 1728px | PASS |

**Horizontal Overflow:** Exactly **0** instances of horizontal overflow across all 104 combinations (`document.documentElement.scrollWidth === viewport.width`).

---

## 5. Accessibility Checks

1. **Keyboard Navigation & Visible Focus:** Focus indicator ring (`2px solid rgb(30, 33, 31)`) appears on all focused links, summaries, and inputs.
2. **Escape Dismissal:** Pressing `Escape` while any nav menu is open immediately dismisses all open details popovers and returns focus cleanly.
3. **Semantic Association:** Navigation summary buttons include `aria-controls` pointing directly to popover container IDs.
4. **Touch Targets:** All mobile header buttons and mobile footer navigation links meet or exceed 44px interactive height.
5. **Form Semantics:** All form inputs retain explicit `<label>` tags with matching `htmlFor` attributes; checkboxes are fully wrapped inside accessible `<label>` targets.

---

## 6. Guide Regression Checks

1. **Sticky TOC Rail:** Appears strictly on desktop viewports (≥ 1024px) with fixed `240px` width and `position: sticky; top: 32px`.
2. **Mobile Collapsible TOC:** On viewports < 1024px (320px, 375px, 768px), desktop TOC rail is hidden (`display: none`), and `<details className="toc-collapsible">` renders seamlessly above the article body.
3. **List Bullet Markers:** Unordered list items inside `.article-body` retain strict `list-style-position: outside` and static positioning. No horizontal drift, no floating markers over paragraphs.
4. **Article Reading Measure:** Governed strictly by `--measure-reading: 720px`, centered with 64px gap next to the 240px TOC rail.

---

## 7. Remaining Non-Blocking Observations

1. **`/login` CTA Prefetch 404:** The header includes `<Link href="/login">`. Next.js automatically prefetches this route, generating a non-blocking 404 in console because the learner/auth login route is not yet ported (pending Mission 06/07).
2. **Leads Action Stub:** Public lead capture forms (`/contact`, `/workshop`, `/coaching`, `/ai-recruiter-os`) validate inputs correctly on client and server, then return an honest informative stub response (`ok: false`) stating the V2 Leads backend is not yet connected.

---

## 8. Automated Test & Build Results

- **`npm run typecheck`:** PASS (`tsc --noEmit` exits 0)
- **`npm run lint`:** PASS (`eslint . --max-warnings=0` exits 0, 0 errors, 0 warnings)
- **`npm test`:** PASS (7/7 security tests pass, natural process termination in ~2s)
- **`npm run build`:** PASS (21/21 routes compiled and prerendered cleanly)

---

## 9. Screenshot References

Automated screenshots captured during browser verification:
- `scratch/screenshots/home-375px.png`, `home-768px.png`, `home-1280px.png`
- `scratch/screenshots/programmes-375px.png`, `programmes-768px.png`, `programmes-1280px.png`
- `scratch/screenshots/mission-01-375px.png`, `mission-01-768px.png`, `mission-01-1280px.png`
- `scratch/screenshots/workshop-375px.png`, `workshop-768px.png`, `workshop-1280px.png`
- `scratch/screenshots/coaching-375px.png`, `coaching-768px.png`, `coaching-1280px.png`
- `scratch/screenshots/about-375px.png`, `about-768px.png`, `about-1280px.png`
- `scratch/screenshots/contact-375px.png`, `contact-768px.png`, `contact-1280px.png`
- `scratch/screenshots/ai-recruiter-os-375px.png`, `ai-recruiter-os-768px.png`, `ai-recruiter-os-1280px.png`
- `scratch/screenshots/guides-375px.png`, `guides-768px.png`, `guides-1280px.png`
- `scratch/screenshots/guides-talent-acquisition-strategy-375px.png`, `guides-talent-acquisition-strategy-768px.png`, `guides-talent-acquisition-strategy-1280px.png`
- `scratch/screenshots/privacy-375px.png`, `privacy-768px.png`, `privacy-1280px.png`
- `scratch/screenshots/terms-375px.png`, `terms-768px.png`, `terms-1280px.png`
- `scratch/screenshots/cookies-375px.png`, `cookies-768px.png`, `cookies-1280px.png`
