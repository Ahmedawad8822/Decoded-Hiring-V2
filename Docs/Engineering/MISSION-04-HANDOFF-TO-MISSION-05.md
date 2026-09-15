# MISSION 04 HANDOFF TO MISSION 05

**Date:** September 15, 2026  
**Status:** Frozen & Approved Baseline  
**Project:** Decoded Hiring V2

---

## 1. MISSION 04 FINAL BASELINE

- **Branch:** `mission-04-production-foundation`
- **Baseline Git Tag:** `mission-04-guide-foundation` (local)
- **Local Working Tree:** Clean (verified with automated test suite, typecheck, lint, and build)
- **Local Admin Access:** Password rotated into `.env.local` only; dev quick-fill updated securely; normal user role strictly defaults to `"user"`.

---

## 2. FOUNDATION NOW AVAILABLE

The production architectural foundation is fully established and proven through the Guide vertical slice:

1. **Better Auth (v1.7.5):** Drizzle SQLite adapter, admin plugin enabled, session persistence via secure HTTP-only cookies, role-based route guards (`admin` vs `user`).
2. **Cloudflare D1 Local:** Local SQLite storage backing D1 with automated migration runner (`src/lib/db/migrate.ts`) and seed runner (`src/lib/db/seed.ts`).
3. **Drizzle ORM (v0.45.2):** Full type-safe schema definitions for Auth (`user`, `session`, `account`, `verification`), Content (`guide`, `guideRevision`), and Media (`mediaAsset`).
4. **R2 / Media Boundary:** Local filesystem/Miniflare simulated R2 storage (`src/lib/media/storage.ts`) with MIME type whitelist, 5MB file size limit, content-hash key generation, and public media serving route (`/api/media/[...key]`).
5. **Admin Studio Shell:** Modern responsive admin studio layout (`/admin/layout.tsx`), login experience (`/admin/login`), session status indicator, and content workspace (`/admin/content`).
6. **Real Guide Management:** Full CRUD operations for guides with automated slug generation, uniqueness checks, and revision tracking.
7. **Typed `GuideBlock[]` Content:** Structured block content model supporting 7 block types: `heading`, `paragraph`, `quote`, `callout`, `image`, `key_takeaways`, and `divider`.
8. **Interactive Block Editor:** Visual block editor (`src/components/admin/BlockEditor.tsx`) in Admin Studio with drag-free reordering, inline editing, and image insertion.
9. **Preview Security:** Server-side draft preview authorization (`?preview=true`) strictly requiring an authenticated admin session; non-admins and unauthenticated requests are safely served 404.
10. **Publishing Lifecycle:** Formal state machine governing `draft` -> `published` -> `archived`, with full unpublish and re-publish capabilities and audit timestamps (`publishedAt`, `updatedAt`).
11. **Public Guide Routes:** Public index (`/guides`) with search, filter pills, and cards; public detail (`/guides/[slug]`) with full block rendering, sticky TOC rail, reading progress indicator, author bio, social sharing, and breadcrumbs.
12. **SEO & Structured Data:** OpenGraph, Twitter cards, canonical tags, and schema.org `Article` JSON-LD injection (`src/features/guides/seo.ts`).
13. **Cache & Revalidation Behavior:** Tag-based ISR cache invalidation (`revalidateTag("guides")`, `revalidatePath`) triggered on publish, unpublish, and update mutations.
14. **Review Hub (`/review`):** Interactive verification dashboard with live system health check and direct deep-links to all public, admin, and preview routes.

---

## 3. REUSABLE MODULES (FOR MISSION 05)

Mission 05 should directly import and build upon the following existing modules:

| Domain | File / Module Path | Capabilities / Exports |
| :--- | :--- | :--- |
| **Auth Core** | `src/lib/auth/index.ts` | Better Auth server instance, admin plugin, D1 adapter |
| **Auth Client** | `src/lib/auth/client.ts` | React client hooks (`useSession`, `signIn`, `signOut`) |
| **Auth Guards** | `src/lib/auth/guards.ts` | `requireAdmin`, `getOptionalAdminSession`, `isAdminUser` |
| **Database Schema** | `src/lib/db/schema.ts` | Drizzle tables (`user`, `session`, `guide`, `guideRevision`, `mediaAsset`) |
| **Database Client** | `src/lib/db/index.ts` | D1 SQLite client resolver (`getDb()`) |
| **Database Migrations** | `src/lib/db/migrate.ts` | Automated migration runner |
| **Media Storage** | `src/lib/media/storage.ts` | `putMedia`, `getMedia`, `validateMediaUpload`, MIME checks |
| **Media Endpoints** | `src/app/api/media/upload/route.ts`<br/>`src/app/api/media/[...key]/route.ts` | Authenticated upload handler & cached public media delivery |
| **Guide Types & Validation** | `src/features/guides/types.ts`<br/>`src/features/guides/validation.ts` | Zod schemas, block definitions, `isSafeUrl`, slug validation |
| **Guide Service** | `src/features/guides/service.ts` | Data access, slug resolution, lifecycle transitions, revisions |
| **Block Renderer** | `src/components/guides/GuideBlockRenderer.tsx` | Production renderer for structured content blocks |
| **Block Editor** | `src/components/admin/BlockEditor.tsx` | Admin Studio interactive block editor |
| **Admin Shell** | `src/app/admin/layout.tsx`<br/>`src/app/admin/content/page.tsx` | Admin studio sidebar, topbar, content table, filters, modals |
| **SEO Helpers** | `src/features/guides/seo.ts` | `buildGuideMetadata`, `buildGuideJsonLd` |
| **Public Presentation** | `src/app/(site)/guides/[slug]/page.tsx` | Article layout, sticky TOC rail, reading progress, author bio |

---

## 4. DO NOT DUPLICATE (CRITICAL BOUNDARIES)

To maintain architectural integrity and prevent codebase bloat, **Mission 05 must NOT create**:

1. **NO second auth system:** Do not implement custom cookie checkers, NextAuth, or alternative auth libraries. Use Better Auth via `src/lib/auth`.
2. **NO second database layer:** Do not introduce Prisma, raw sqlite3 calls, or independent database clients. Use Drizzle ORM via `src/lib/db`.
3. **NO second media service:** Do not create separate upload folders or endpoints for Field Notes. Reuse `src/lib/media/storage.ts` and `/api/media/upload`.
4. **NO second publishing lifecycle:** Do not implement separate or conflicting status enums. Align Field Notes with the established `draft | published | archived` lifecycle.
5. **NO second block editor:** Do not bring in external rich text packages (TipTap, Slate, Quill). Extend the existing structured `BlockEditor` component.
6. **NO second preview system:** Do not invent token-based or parallel preview routes. Use the established `?preview=true` pattern authorized via admin session.
7. **NO second SEO implementation:** Do not hand-code duplicate JSON-LD scripts or metadata builders. Extend the established SEO builder pattern.
8. **NO second admin shell:** Do not create separate `/admin/field-notes` layouts. Add Field Notes as a tab or view within `/admin/content`.

---

## 5. FIELD NOTES STATUS (FOR MISSION 05)

- **Current Status:** Not implemented yet (intentionally scoped for Mission 05).
- **Mission 05 Mandate:** Field Notes will extend and reuse the shared publishing foundation established here. Field Notes represent shorter, punchy, tactical insights, but will share the same underlying persistence, block structure, status lifecycle, media storage, and admin management paradigms.

---

## 6. KNOWN DEFERRED ITEMS

The following tasks remain intentionally deferred beyond Mission 04:

1. **Cloudflare Remote Provisioning:** Remote D1 database creation, remote R2 bucket binding, and `wrangler deploy` to production edge workers.
2. **Final Worker Adapter Decision:** Selection between OpenNext Cloudflare adapter and Vinext Vite-based adapter once Cloudflare Node.js compatibility tooling settles.
3. **Third-Party External Integrations:** Brevo (transactional email), PostHog / GA4 (analytics), and Lemon Squeezy / Stripe (payment providers).
4. **Courses & Learner Productionization:** Transitioning interactive courses, syllabi, and learner profiles from prototype state to D1 persistence.
5. **Field Notes Implementation:** Scheduled as the primary vertical deliverable for Mission 05.

---

## 7. ARCHITECTURAL PREP FOR MISSION 05 (CANDIDATE SHARED PRIMITIVES)

*Note: No speculative refactoring has been performed in Mission 04. Mission 05 will execute actual extractions based on concrete shared requirements between Guides and Field Notes.*

The following primitives have been identified as high-value extraction candidates:

1. **Shared `ContentStatus`:**
   - *Current:* `GuideStatus = "draft" | "published" | "archived"` in `src/features/guides/types.ts`.
   - *Future Candidate:* `ContentStatus` in `src/features/publishing/types.ts`.
2. **Shared `BlockContent`:**
   - *Current:* `GuideBlock` union and `GuideBlockRenderer` in `src/components/guides/GuideBlockRenderer.tsx`.
   - *Future Candidate:* `ContentBlock` union and `ContentBlockRenderer` in `src/components/publishing/BlockRenderer.tsx`.
3. **Shared Publishing Actions & Lifecycle Service:**
   - *Current:* `publishGuide`, `unpublishGuide`, `archiveGuide` in `src/features/guides/service.ts`.
   - *Future Candidate:* Common entity publishing helpers with automated `publishedAt` / `updatedAt` timestamps and cache revalidation.
4. **Shared Preview Authorization:**
   - *Current:* Admin session check in `src/features/guides/service.ts` (`getGuidePreview`).
   - *Future Candidate:* Generic `resolvePreviewAccess(session)` helper in `src/features/publishing/preview.ts`.
5. **Shared SEO Metadata & JSON-LD Helpers:**
   - *Current:* `buildGuideMetadata` and `buildGuideJsonLd` in `src/features/guides/seo.ts`.
   - *Future Candidate:* Generalized `buildArticleMetadata` and `buildArticleJsonLd` supporting both `Article` and `BlogPosting` schemas.
6. **Shared Admin Content Workspace:**
   - *Current:* `/admin/content` managing Guides.
   - *Future Candidate:* Tabbed `/admin/content` managing both "Guides" and "Field Notes" using shared table components, search bars, and drawer mechanics.
