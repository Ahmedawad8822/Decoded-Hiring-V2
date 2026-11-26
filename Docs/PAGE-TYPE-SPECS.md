# Page type and lifecycle specs

Mini-specs for the content types added in the website-and-content batch. Code wins when it drifts; update this file with the code.

## 1. Content lifecycle (all admin-managed content)

States: `draft` → `published` → `archived`, plus a separate **Trash** flag (`trashed_at`, nullable timestamp; `trashed_from_status` remembers the state it left).

| Action | Allowed from | Result |
|---|---|---|
| Publish / unpublish | existing rules per type | unchanged |
| Archive | published (and draft where the type already allows) | hidden from public/learner navigation; data, history and relationships kept |
| Restore (from archive) | archived | back to `draft` (an editable state); never straight to published |
| Move to Trash | draft or archived (published items must be unpublished/archived first) | hidden from every normal Studio list and every public/learner view; recoverable |
| Restore from Trash | trashed | `trashed_at` cleared, status = `trashed_from_status` |
| Delete permanently | trashed only | irreversible; typed confirmation (enter the title); dependency checks below; writes an audit row with a snapshot of title/slug/id |
| Auto-purge | trashed for more than 30 days | the 5-minute cron permanently deletes in small bounded batches, with the same dependency checks; items that fail a check stay in Trash and are flagged |

Dependency rules:
- **Courses:** a course with any enrollment (any status), certificate or order can never be permanently deleted (manually or by purge). Studio says why and offers Archive. A course with no learners deletes with its sections, lessons, resources (R2 objects too), quizzes and offer.
- **Lessons:** a lesson with any learner progress, quiz attempt, note or question can't be permanently deleted; archive instead.
- **Guides / Field Notes / Pages / Landing Pages:** permanent delete removes revisions, slug redirects pointing at them, and their R2 media only if no other content references the same object.
- Slugs of trashed items stay reserved until permanent delete.
- Every lifecycle action is admin-only, server-checked, audited, and revalidates affected public paths and the sitemap.

Studio: one **Trash** page listing all trashed items (type, title, trashed date, days left before purge), with Restore and Delete permanently. Each type's own list hides trashed items.

## 2. Course sales page (public)

- Purpose: convert visitors into learners without signing in first. Audience: prospective learners from search, social and email.
- Route: `/courses/[slug]` (public, cached, revalidated on course/offer change). `/courses` lists published courses. Only `published`, non-trashed courses; others 404 (with slug redirects honoured).
- Anatomy: hero (title, subtitle/description, cover, primary CTA), who it's for, outcomes, curriculum preview (sections and lesson titles with durations, preview lessons marked; no lesson bodies), instructor, proof (certificate note), FAQ, access/pricing from the offer (free, paid when checkout is live, seat-limit/close-date states), repeated CTA, mobile sticky CTA.
- CTA: signed-out → sign up with redirect back to the classroom course page; signed-in → the existing enroll flow. Sold-out/closed offers show the existing states.
- SEO: canonical, Open Graph, `Course` JSON-LD, included in the sitemap. The signed-in classroom page `/learn/courses/[slug]` stays as is and links to/from the sales page.
- Analytics: reuse existing tracked-offer-link / business-event patterns for CTA clicks.

## 3. Standard page

- Purpose: governed pages for information content (e.g. future policy, FAQ, press pages) without code changes. Existing hand-built pages (About, legal, contact) stay as they are.
- Route: `/[slug]` at the site root for published pages. Reserved slugs: every existing top-level route and segment (enforced in validation, kept in one list next to `public-routes.ts`).
- Fields: title, slug, summary (meta description), body (the existing structured block editor and block types), optional hero image (existing media rules), SEO title/description, noindex flag, show in footer flag.
- Anatomy: simple hero (title, summary), body blocks, optional CTA block; site header/footer. Desktop/mobile use existing site typography.
- Lifecycle: §1. Revisions like Field Notes if cheap; otherwise none (state it).
- SEO: canonical, Open Graph, sitemap unless noindex. Empty/error: 404 for unknown/unpublished.

## 4. Marketing landing page

- Purpose: campaign-specific conversion pages for launches and targeted distribution. Audience: campaign traffic (ads, email, social).
- Route: `/go/[slug]`. Not linked from site navigation.
- Fields: title, slug, campaign name, connected target (one of: offer, course, guide) that drives the primary CTA, CTA label, sections built from approved reusable blocks only (hero, problem, outcomes/benefits list, proof quote, programme/curriculum summary from the target, FAQ, CTA band, lead-capture form using the existing lead intake), SEO title/description, noindex (default on), schedule (`starts_at`, `ends_at` optional).
- CTA/UTM: CTA links carry through incoming `utm_*` query parameters to the target; lead submissions record the landing page slug and UTMs (existing lead fields or a small extension).
- Scheduling: before `starts_at` → 404; after `ends_at` → a polite "this campaign has ended" page with a link to the target, and the cron moves it to `archived`.
- Lifecycle: §1. SEO: canonical; sitemap only when not noindex and live.
- Analytics: view and CTA click business events tagged with the landing page id.
