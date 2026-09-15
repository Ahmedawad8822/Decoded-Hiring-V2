# Mission 04 — Production Foundation + Real Guide Publishing Vertical Slice

## Executive Summary
Mission 04 establishes the production foundation for Decoded Hiring V2 and delivers the platform's first complete vertical slice: an end-to-end publishing pipeline for Guides. This architecture transitions the product from static prototypes to an active database-backed App Router application while strictly preserving the approved visual and interaction baseline established in commit `fabc665`.

All persistence and runtime environments remain **100% local**. No remote Cloudflare accounts, API tokens, production databases, R2 buckets, or external third-party subscriptions were required or created.

---

## 1. Architectural Seams & Runtime Boundary

### Cloudflare Runtime Boundary (`src/lib/cloudflare/bindings.ts`)
To prevent domain code from becoming tightly coupled to Node.js or Wrangler development tools, a clean runtime binding boundary was established:

- **Production / Cloudflare Worker Runtime**: Reads native bindings (`env.DB`, `env.MEDIA_BUCKET`) directly from execution context or global worker environment.
- **Local Development / Node.js Runtime**: Utilizes Wrangler's `getPlatformProxy` with local Miniflare emulation targeting persistent local state in `.wrangler/state/v3`.
- **Packaging Isolation**: `wrangler`, `miniflare`, and `esbuild` are declared under `serverExternalPackages` in `next.config.ts`, ensuring Next.js webpack builds succeed without bundling CLI tooling into the server runtime.

```
┌────────────────────────────────────────────────────────┐
│                   Domain Layer                         │
│  Guides Service  │  Media Service  │  Better Auth      │
└───────────────────────────┬────────────────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │ Runtime Binding Boundary  │
              │ (src/lib/cloudflare/...)  │
              └───────┬─────────────┬─────┘
                      │             │
        (Local Dev)   │             │   (Worker Runtime)
      ┌───────────────▼─┐         ┌─▼──────────────────┐
      │ Wrangler Proxy  │         │ Native Cloudflare  │
      │ Miniflare Local │         │ Worker Bindings    │
      │ D1 (.sqlite)    │         │ env.DB             │
      │ R2 (.wrangler)  │         │ env.MEDIA_BUCKET   │
      └─────────────────┘         └────────────────────┘
```

---

## 2. Persistence Layer (D1 & Drizzle ORM)

### Configuration
- **Dialect**: SQLite (`drizzle-orm/d1`)
- **Schema Location**: `src/lib/db/schema.ts`
- **Migrations**: `drizzle/migrations/`
- **Local State Location**: `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`

### Schema Architecture
1. **Authentication Tables**:
   - `users`: Includes `id`, `name`, `email`, `role` (strictly defaults to `"user"`), `banned`, timestamps.
   - `sessions`: Token-based session tracking with expiry, IP, and user-agent metadata.
   - `accounts`: Manages credentials (hashed passwords) and provider links.
   - `verifications`: Generic verification tokens for email/password actions.
2. **Guides Table**:
   - `guides`: Stores `title`, unique `slug`, `summary`, `category`, `reading_time`, `featured_image_url`, `status` (`DRAFT` | `PUBLISHED` | `ARCHIVED`), `content_blocks` (structured JSON string), `published_at`, `created_at`, `updated_at`.
3. **Media Table**:
   - `media`: Audit log for files uploaded to local R2 storage (`storage_key`, `original_filename`, `mime_type`, `byte_size`, `uploaded_by_user_id`).

---

## 3. Authentication & Authorization (Better Auth)

### Configuration & Adapter
- **Library**: `better-auth` (^1.7.5) with official Drizzle adapter (`better-auth/adapters/drizzle`).
- **Admin Plugin**: Configured via `admin({ defaultRole: "user", adminRole: "admin" })`.
- **Role Guarantee**: Newly registered accounts strictly default to `role = "user"`. The `role = "admin"` attribute is a privileged staff role and cannot be self-assigned.
- **Local Admin Seeding**: Seeded explicitly through Better Auth's standard registration and account linking mechanism via `scripts/seed.ts`. Development credentials are kept in `.env.local` (git-ignored) and never committed.

### Route Protection
- **Studio Shell (`/admin/*`)**: Wrapped with server-side session checks. Unauthenticated requests are immediately redirected via HTTP 307 to `/admin/login`.
- **Server Actions (`src/features/guides/actions.ts`)**: Every mutation (`createGuideAction`, `updateGuideAction`, `publishGuideAction`, `unpublishGuideAction`, `archiveGuideAction`) invokes `requireAdmin()`. Non-admin sessions throw unauthorized errors.

---

## 4. Guide Publishing Domain & Content Security

### Content Block Model (`src/features/guides/types.ts`)
Guide body content is stored as typed structured JSON (`GuideBlock[]`), supporting:
- `heading`: Level 2 or 3 heading text.
- `paragraph`: Body copy.
- `blockquote`: Quotation with optional attribution citation.
- `callout`: Highlight box with tone (`info` | `caution` | `tip`) and content.
- `list`: Semantic items with ordered boolean flag.
- `resource`: Download or reference link card with title, description, and URL.

### Security Defenses
1. **Zero `dangerouslySetInnerHTML`**: All blocks are rendered through controlled React components (`src/app/guides/guide-renderer.tsx`).
2. **Safe URL Protocol Validator (`isSafeUrl`)**: Strictly enforces whitelist protocols (`http:`, `https:`, `mailto:`). Malicious protocols (`javascript:`, `data:`, `vbscript:`) are rejected both at Zod schema validation and at the React rendering boundary.
3. **Semantic List Preservation**: Lists are rendered using native `<ul>`, `<ol>`, and `<li>` elements, maintaining the bullet stability fix established in `fabc665`.
4. **Preview Access Control**: `?preview=true` alone never grants access. The server validates that the requesting session possesses an authorized `admin` role. Anonymous or standard user requests to draft or archived guides always return HTTP 404.

---

## 5. Media Domain (Local R2 Storage)

### Implementation (`src/lib/media/service.ts`)
- **Storage Target**: Local R2 Bucket (`MEDIA_BUCKET` / `decoded-hiring-local-media`).
- **Validation**: Strict MIME type whitelisting (`image/jpeg`, `image/png`, `image/webp`, `image/svg+xml`, `image/avif`) and 5MB size limit.
- **Key Generation**: Cryptographically generated non-guessable storage keys (`guides/${crypto.randomUUID()}.${ext}`). Untrusted client filenames are never used as storage keys, preventing path traversal attacks.
- **Serving Route**: `/api/media/[...key]` serves files with `Cache-Control: public, max-age=31536000, immutable`.

---

## 6. Layout Architecture & Surface Isolation

### Structural Next.js App Router Layout Composition
To avoid client-side pathname hacks and hydration flickers:
- **Public Surface (`src/app/(site)/`)**:
  - Encapsulated within `src/app/(site)/layout.tsx`.
  - Automatically wraps all public pages (`/`, `/about`, `/coaching`, `/programmes`, `/workshop`, `/contact`, `/privacy`, `/terms`, `/cookies`, `/guides`, `/guides/[slug]`, `/review`) with the approved public `SiteHeader` and `SiteFooter`.
- **Admin Studio Surface (`src/app/admin/`)**:
  - Independent App Router hierarchy.
  - `src/app/admin/layout.tsx` renders the clean, focused Studio Shell (sidebar navigation, user profile badge, sign out) with zero public headers, footers, or consumer navigation.
  - `/admin/login` renders a dedicated standalone card view without the studio sidebar.

---

## 7. Cloudflare / Vinext Preflight Assessment

As mandated by Mission 04 instructions, a non-destructive assessment of Cloudflare's experimental `vinext` adapter was conducted:

| Assessment Dimension | Status | Technical Finding |
| :--- | :--- | :--- |
| **Next.js Version** | 16.3.2 | Current Next.js App Router with React 19. |
| **Server Actions** | Active | Extensively used for guide mutations and revalidation. |
| **Auth Dependencies** | Better Auth | Native Node cryptographic routines supported in Workers via Web Crypto API. |
| **Wrangler / D1 / R2** | Local Emulation | Fully compatible via standard worker bindings. |
| **Vinext Maturity** | Experimental | `vinext` currently targets specific Vite-based Next.js subsets and is in early developer preview. Migrating now would introduce unnecessary build instability. |
| **Recommendation** | **DEFER** | Maintain standard Worker runtime bindings boundary (`src/lib/cloudflare/bindings.ts`). When deploying to Cloudflare Workers in future production missions, use the official Cloudflare Next.js adapter (`@opennextjs/cloudflare`) or evaluate vinext once stabilized. |

---

## 8. Verification & Test Evidence

### Automated Test Suite (`tests/mission-04-publishing.test.ts`)
The test suite validates all 9 mission security scenarios:
1. **Security 1 & 2**: Unauthorized and non-admin users cannot access admin mutations (`PASS`).
2. **Security 3**: `preview=true` exposes drafts only when the session has `admin` role (`PASS`).
3. **Security 4**: Unsafe URL protocols (`javascript:`, `data:`) are strictly rejected (`PASS`).
4. **Security 5**: Duplicate slug creation fails safely with an informative error (`PASS`).
5. **Security 6 & 7**: Guide lifecycle transitions (`PUBLISH` → `UNPUBLISH` → `ARCHIVE`) strictly govern public visibility (`PASS`).
6. **Security 8**: Media upload enforces MIME types, 5MB limit, and non-guessable storage keys (`PASS`).
7. **Security 9**: Newly registered normal users default strictly to `role = "user"` (`PASS`).

### Full Browser Walkthrough Verification (Google Chrome via Playwright)
All 15 lifecycle steps and visual layout constraints were verified in Google Chrome:
- **Admin Sign-in & Content Access**: `PASS` (Login via `/admin/login`, redirect to `/admin/content`).
- **Guide Draft Creation & Storage**: `PASS` (Created draft, added blocks, persisted in D1).
- **Anonymous Access Guard**: `PASS` (Draft returns HTTP 404 for anonymous users; `?preview=true` without admin auth returns 404).
- **Authenticated Preview**: `PASS` (Admin sees draft with yellow `PREVIEW MODE` banner).
- **Publish Pipeline**: `PASS` (Lifecycle status updates to `PUBLISHED`, appears immediately on `/guides`).
- **Public Guide Rendering**: `PASS` (Rendered at `/guides/[slug]` without preview banner, article metadata and JSON-LD schema verified).
- **Edit Published Guide**: `PASS` (Editing published guide updates content and revalidates public page).
- **Unpublish**: `PASS` (Unpublishing guide removes it from `/guides` and returns HTTP 404 on anonymous request).
- **Archive**: `PASS` (Archived guide remains unavailable on public routes with HTTP 404).
- **Desktop Layout & Sticky TOC**: `PASS` (240px TOC rail sticks at `top: 32px` on scroll; `#hg-master-draft:has(.article-layout)` overflow unclipped).
- **Mobile Viewport (375x812)**: `PASS` (Desktop rail hidden, collapsible `<details class="toc-collapsible">` rendered, responsive admin card list).
- **Semantic Bullets**: `PASS` (Static semantic bullets verified).
- **Review Hub**: `PASS` (All links verified on `/review`).

### Development Admin Safety
- **Zero Committed Credentials**: No passwords or auth secrets committed in repository.
- **Dynamic Quick-Fill**: Guarded strictly by `NODE_ENV === "development"` via `/api/dev/quick-fill`, returning 404 in production builds.
- **Default Role**: Newly registered accounts strictly default to `role = "user"`. Admin role is granted explicitly only.

### Build & Compilation
- **TypeScript**: `npx tsc --noEmit` → **0 errors**.
- **ESLint**: `npx eslint . --max-warnings=0` → **0 warnings**.
- **Production Build**: `npm run build` → **Compiled successfully in 6.1s**, static and dynamic App Router routes generated.
