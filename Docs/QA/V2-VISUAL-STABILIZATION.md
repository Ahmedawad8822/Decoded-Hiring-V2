# Decoded Hiring V2 — Visual QA & Stabilization Report

**Date:** September 15, 2026  
**Integration Baseline:** Commit `905f8e8`  
**Review Hub:** [http://localhost:3000/review](http://localhost:3000/review)  
**Target Environment:** Unified Next.js dev server on port 3000 with static prototype mounting under `/public/prototypes/`

---

## 1. Known Issues Reproduced

### Issue 1: Guide List Bullet Movement on Scroll
- **Reproduction Steps:**
  1. Navigated to `http://localhost:3000/prototypes/public/guide.html` at desktop viewport (1280px).
  2. Scrolled down toward the section *"Start with the hiring situation"* containing the 3-item unordered bullet list.
  3. Scrolled up and down continuously through the article.
- **Observed Defect:**
  - The sticky table-of-contents navigation list (`.toc-rail ol`) with numbered markers (`1.`, `2.`, `3.`, `4.`) was superimposed directly over the article body and bullet list text, floating vertically up and down through the content as the user scrolled.
  - Browser default `list-style: decimal` markers on the unclassed `<ol>` inside `.toc-rail` were visibly drifting across paragraphs and bullet items.

### Issue 2: Excessive Side Whitespace / Guide Page Artificially Narrow
- **Reproduction Steps:**
  1. Loaded `guide.html` at 1280px desktop width.
  2. Inspected container metrics and layout grid.
- **Observed Defect:**
  - Hero header was constrained within `.wrap-reading` (768px wide) and centered at `x = 256px`.
  - The main grid had inline style `grid-template-columns: minmax(0, 1fr)` on `.wrap` (1120px max-width), forcing `.toc-rail` and `.article-body` into a single stacked column at `x = 104px`.
  - Over 456px of dead, empty whitespace was left unused on the right side of the screen (`x = 824px` to `1280px`), creating severe horizontal misalignment between the centered hero and left-docked content.

---

## 2. Root Causes

### Root Cause 1: Guide Moving Bullets
1. **Trapped Single-Column Sticky Rail:** In `guide.html`, the grid container had an inline style `style="display:grid;grid-template-columns:minmax(0,1fr);gap:48px"`. Because only one column track was defined, `<aside class="toc-rail">` and `<article class="article-body">` occupied rows 1 and 2 of the *same* column.
2. **Sticky Scroll Detachment:** `.toc-rail` had `position: sticky; top: 32px;` with no background. When scrolling past row 1 into row 2, the sticky rail slid down directly over the article text, headings, and bullet points. Its list items and markers floated across the prose.
3. **Unclassed List Inheritance:** In `base.css`, `ul[class], ol[class] { list-style: none; }` only stripped markers on classed lists. The `<ol>` in `.toc-rail` had no class and lacked explicit `list-style: none`, causing browser default decimal numbers to render and drift.

### Root Cause 2: Excessive Side Space & Misalignment
1. **Container Fragmentation:** The breadcrumbs used `.wrap` (1120px), the hero used `.wrap-reading` (768px centered), and the body used `.wrap` with an internal 1-column 720px measure.
2. **Missing Multi-Column Grid System:** Desktop viewports (≥1024px) lacked a dedicated 2-column editorial grid rule pairing the 240px sticky rail with the 720px reading article measure.
3. **Punched Lower Sections:** TopicClusterStrip and Newsletter CTA sections were wrapped in `.wrap-reading` (768px), unnecessarily compressing full-width components into narrow boxes.

---

## 3. Fixes Made

### Fix 1: Sticky TOC & List Bullet Stabilization
1. **Grid Track Separation:** Replaced the single-column inline style with a dedicated `.article-layout` responsive grid system in `components.css`:
   - `@media (min-width: 1024px)`: `grid-template-columns: 240px minmax(0, 1fr); gap: clamp(40px, 5vw, 64px); align-items: start;`
   - `.toc-rail` is permanently anchored to column 1 (`width: 240px; position: sticky; top: 32px;`). It never overlaps column 2.
2. **TOC List Style Reset:** Explicitly added `list-style: none; padding: 0; margin: 0;` to `.toc-rail ol` and `.toc-collapsible ol` to eliminate unwanted decimal numbers next to editorial border rules.
3. **Hardened Article List Typography:** In `base.css`, explicitly set `list-style-type: disc; list-style-position: outside; margin-block: 1.2em;` on `.article-body ul:not([class])` and `decimal` on `ol:not([class])`. Added static positioning, `transform: none`, explicit `li::marker` color/size matching `--ink`, and proper padding/margins for nested `ul`/`ol` elements.

### Fix 2: Editorial Composition & Width Optimization
1. **Unified Column Alignment:** In `guide.html`, placed the `.article-hero` inside `.article-main` in column 2. The title, dek, metadata, and all body paragraphs align to the exact same left margin (`x = 408px` on 1280px viewport).
2. **Sacred Reading Measure Preserved:** Paragraph line length remains strictly governed by `--measure-reading: 720px` (65–75 characters per line), avoiding fatigue from excessively wide lines.
3. **Balanced Desktop Width:** Total content spread spans `240px (rail) + 64px (gap) + 720px (measure) = 1024px`, harmoniously centered inside the 1120px container with balanced margins.
4. **Uncramped Cluster & CTA Modules:** Converted `.cluster-strip` and `.newsletter` wrappers from `.wrap-reading` to `.wrap`, allowing them to span full container width on desktop.
5. **Synchronized Sources:** Applied identical fixes to both `public/prototypes/` (served live) and `prototypes/` (repository source).

---

## 4. Additional Real Defects Discovered

1. **Defect A1 (Navigation Link Missing from Review Hub):**
   - *Surface:* `/review` (Review Hub)
   - *Issue:* The Guide detail prototype (`PUB-04g`) was omitted from the Public section in `src/app/review/page.tsx`, requiring manual URL entry.
   - *Classification:* A — BUG.
2. **Defect A2 (Missing Anchor on Reschedule Cancellation Target):**
   - *Surface:* `/prototypes/scheduling/reschedule.html#cancel`
   - *Issue:* Review hub linked to `#cancel`, but `reschedule.html` had no element with `id="cancel"`, failing to scroll the reader to the cancellation protocol.
   - *Classification:* A — BUG.

---

## 5. Additional Defects Fixed

1. **Fixed Review Hub Guide Access:** Added `Guide: Talent Acquisition Strategy` (`PUB-04g`) to Group 1 (Public Website) in `src/app/review/page.tsx`, linking directly to `/prototypes/public/guide.html`.
2. **Fixed Reschedule Cancellation Anchor:** Added `id="cancel"` with `scroll-margin-top: 96px` to the cancellation consequence explanation paragraph in both `public/prototypes/scheduling/reschedule.html` and `prototypes/scheduling/reschedule.html`.

---

## 6. Subjective Items Deliberately NOT Changed

Per instructions to protect approved directions and avoid taste-driven changes:
1. **Public Marketing Restoration:** Kept exact typography, pill navigations, color tokens, and layout rhythm of the V1 restored pages (`/`, `/programmes`, `/workshop`, `/coaching`, `/about`, etc.).
2. **V1 Copy & Vendor Mentions in Legal Pages:** Preserved fallback copy mentioning legacy analytics/infrastructure verbatim as ported.
3. **Admin Studio Calm Theme:** Retained the muted, high-density operational aesthetic and typography across Command Center and Studio surfaces.
4. **Interactive Demos & Stubs:** Retained client-side simulation logic for checkout state transitions, booking holds, access mode switchers, and stub lead actions without adding speculative production backend integrations.

---

## 7. Routes Inspected

### Public Marketing Website (Next.js Application Routes)
- `/` (Home): PASS
- `/programmes` (Overview): PASS
- `/mission-01` (Mission 01 Free Course): PASS
- `/workshop` (Team Workshop): PASS
- `/coaching` (1:1 Coaching Diagnostic): PASS
- `/about` (Founder Story & Manifesto): PASS
- `/contact` (Consultation Enquiry Form): PASS
- `/ai-recruiter-os` (Waitlist & System Overview): PASS
- `/privacy` (Privacy Policy): PASS
- `/terms` (Terms of Service): PASS
- `/cookies` (Cookie Transparency): PASS
- `/review` (Review Hub): PASS

### Publishing & Editorial
- `/prototypes/public/guide.html` (Guide Detail): PASS
- `/prototypes/studio/editorial.html` (AI Content Studio): PASS
- `/prototypes/studio/content.html` (Content Management): PASS

### Admin / Product Prototypes
- `/prototypes/studio/command.html` (Command Center): PASS
- `/prototypes/studio/approvals.html` (Approvals Queue): PASS
- `/prototypes/studio/curriculum.html` (Curriculum / Course Editor): PASS
- `/prototypes/studio/products.html` (Products & Access Modes): PASS
- `/prototypes/studio/bookings.html` (Bookings Operations): PASS
- `/prototypes/studio/settings.html` (Settings & Auth): PASS
- `/prototypes/studio/enquiries.html` (Enquiries Pipeline): PASS
- `/prototypes/studio/students.html` (Students List): PASS
- `/prototypes/studio/courses.html` (Course Catalog): PASS
- `/prototypes/studio/intelligence.html` (Intelligence & Error States): PASS
- `/prototypes/studio/reliability.html` (Reliability Backlog): PASS
- `/prototypes/studio/login.html` (Studio Sign-in): PASS

### Learner Experience
- `/prototypes/learner/home.html` (Learner Dashboard): PASS
- `/prototypes/learner/courses.html` (My Courses): PASS
- `/prototypes/learner/lesson.html` (Classroom Lesson): PASS
- `/prototypes/learner/account.html` (Profile & Notifications): PASS
- `/prototypes/learner/bookings.html` (Learner Bookings): PASS

### Commerce State Machine
- `/prototypes/commerce/checkout.html` (Available State): PASS
- `/prototypes/commerce/checkout.html?state=pending` (Pending State): PASS
- `/prototypes/commerce/checkout.html?state=success` (Success State): PASS
- `/prototypes/commerce/checkout.html?state=failure` (Failure State): PASS
- `/prototypes/commerce/checkout.html?state=manual` (Manual / Invoice State): PASS

### Scheduling Surfaces
- `/prototypes/scheduling/booking.html` (Coaching Booking Wizard): PASS
- `/prototypes/scheduling/discovery.html` (Workshop Discovery): PASS
- `/prototypes/scheduling/confirmed.html` (Booking Confirmation): PASS
- `/prototypes/scheduling/reschedule.html` (Reschedule Flow): PASS
- `/prototypes/scheduling/reschedule.html#cancel` (Cancellation Protocol): PASS

---

## 8. Desktop / Tablet / Mobile Verification

Automated Playwright verification executed across 3 canonical viewports:
- **Desktop (1280 × 800):** PASS
  - Zero unexpected horizontal overflow across all routes (`scrollWidth <= innerWidth`).
  - Guide layout displays balanced 2-column composition: 240px sticky rail + 64px gap + 720px reading column.
  - Bullets remain anchored with zero movement or jitter during high-speed and incremental scrolling.
  - Command Center, Checkout, and Booking Wizard render without clipping.
- **Tablet (768 × 1024):** PASS
  - Guide seamlessly collapses `.toc-rail` and activates clean `.toc-collapsible` accordion summary.
  - Header controls wrap predictably; no broken grid wraps.
  - Zero horizontal overflow.
- **Mobile (375 × 667):** PASS
  - Public mobile navigation and prototype mobile drawer open/close correctly with focus management.
  - Single-column reading flow with legible typography.
  - Form fields and buttons remain fully accessible with comfortable tap targets.
  - Zero horizontal overflow.

---

## 9. Deferred Items & Remaining Ahmed Decisions

### Field Notes
- **Status:** DEFERRED — FUTURE IMPLEMENTATION
- Per explicit prompt instructions: Field Notes public page is not yet implemented in V2 and was not fabricated or QA'd against nonexistent production routes.

### Remaining Ahmed Decisions
1. **Production Infrastructure / Vendors:** Hosting, database, email gateway, and analytics selections needed to unblock live lead submissions and finalize legal text vendor references.
2. **Forward Footer Links:** Confirm whether `/guides` and `/field-notes` in public footer should continue serving 404 until V2 Next.js dynamic publishing lands, or temporarily point to static prototypes.
3. **Learner / Staff Auth Wiring:** Determine backend authentication provider for `/login` and `/admin/login`.
