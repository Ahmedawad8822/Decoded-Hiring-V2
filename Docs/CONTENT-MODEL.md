# Content Model

Blueprint §4, §5 and §18.6. Status: **living document**, written against `main` at `b902784` (migrations through `0020_slug_redirects`). The code wins over this file; fix this file when they disagree. Vocabulary lives in `Docs/CONTEXT.md`; the runtime in `Docs/ARCHITECTURE.md`. Schema source: `src/lib/db/schema.ts` (Drizzle) plus raw SQL in `drizzle/migrations/` (see divergences).

## 1. Shared rules

| Rule | Where it lives |
|---|---|
| `ContentStatus` = `draft` / `published` / `archived` (lowercase). Courses and Lessons use the same three values under their own types | `features/publishing/types.ts` |
| Bodies are JSON-stringified `ContentBlock[]` (`heading` 2/3, `paragraph`, `blockquote`, `callout`, `list`, `resource`). No raw HTML or Markdown is stored. Field Notes' editor offers only the first five block types but stores the same union | `contentBlockSchema`, `FIELD_NOTE_BLOCK_TYPES` |
| Slug: `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 3 to 100 chars (`slugSchema`). Empty slug on create falls back to `slugifyTitle(title)` for courses and lessons | `features/publishing/types.ts` |
| Cover image: `/api/media/...` path or `https://` URL only (`isSafeMediaUrl`) | `coverImageSchema` |
| In-body links: `isSafeUrl` rejects `javascript:`, `data:`, `vbscript:`, `file:` | `features/publishing/types.ts` |
| Preview: a non-published Guide or Field Note is visible only with `?preview=true` **and** an admin session; the request is rewritten to dynamic `/preview/guides/[slug]` and `/preview/field-notes/[slug]`. Courses have no preview | `features/publishing/preview.ts` |
| Publishing sets `publishedAt` once (first publish wins). Unpublish keeps it. Edit touches only `updatedAt` | `features/publishing/lifecycle.ts` |
| Ids are prefixed random strings (`course_`, `lesson_`, `offer_`, `bev_`, ...), not autoincrement | services |

## 2. Lifecycle (shared transition table)

`draft` is the only editable-from-scratch state; `archived` is **terminal**.

| From | publish | unpublish | archive |
|---|---|---|---|
| `draft` | to `published` | rejected | to `archived` |
| `published` | rejected | to `draft` | to `archived` |
| `archived` | rejected | rejected | rejected |

Enforced by `assertGuideTransition` / `assertFieldNoteTransition` (`publishing/lifecycle.ts`). Courses and Lessons use the same shape hand-coded in `courses/service.ts`: publish is rejected from `published` and `archived`; unpublish only from `published`; Course archive is allowed from `draft` and `published`. Archiving a Course takes no new Enrollments but keeps access for entitled learners (`getLearnerCourseBySlug`). Publishing, unpublishing or changing a lesson's `required` flag calls `reconcileCourseEnrollments` (`progress/reconcile.ts`), which flips Enrollments `active` and `completed` as the required set changes.

Draft-only hard delete exists only as an internal compensation primitive (`discardGuideDraft`, `discardFieldNoteDraft`) for Editorial AI. It refuses anything that is not `draft`.

## 3. Entities

Public = reachable without a session. "Reval." = `revalidatePath` calls made by the admin action layer.

### Editorial content

| Entity (table) | Key fields | Statuses | Slug | Relationships | Public? | Reval. on write |
|---|---|---|---|---|---|---|
| **Guide** (`guides`) | `title`, `slug`, `excerpt`, `body`, `coverImage`, `author` (default "Decoded Editorial"), `category`, `tags`, `metaTitle`, `metaDescription`, `ogImage`, `publishedAt` | shared `ContentStatus` | globally unique; rename of an ever-published guide records a redirect | published via an Editorial Publication | `published` at `/guides`, `/guides/[slug]` (ISR, `revalidate = 3600`), sitemap | `/guides`, `/guides/<slug>`, `/guides/<old slug>` on rename, `/admin/content` |
| **Field Note** (`field_notes`) | as Guide minus `category`, `tags`, `ogImage` | shared `ContentStatus` | globally unique; redirect on rename | 1:N `field_note_revisions` | `published` at `/field-notes`, `/field-notes/[slug]` (ISR 3600), sitemap | `/field-notes`, `/field-notes/<slug>`, `/field-notes/<old slug>`, `/admin/content` |
| **Field Note Revision** (`field_note_revisions`) | `title`, `body`, `status`, `trigger` (`publish`/`update`/`unpublish`/`archive`), `createdBy` | snapshot of the note's status | none | cascades from the Field Note | No (admin only) | none |
| **Media** (`media`) | `key` (unique, `guides/<id>.<ext>` or `field-notes/<id>.<ext>`), `filename`, `contentType`, `size`, `uploadedBy` | none | none | referenced by URL string from `coverImage`, not by FK | Yes: `/api/media/<key>` serves any key in the public namespaces, `Cache-Control: public, immutable` | none |
| **Slug Redirect** (`slug_redirects`) | `entityType` (`guide`/`field_note`/`course`/`lesson`), `scope` (course id for lessons, else `''`), `oldSlug`, `entityId` | none | unique on (`entityType`, `scope`, `oldSlug`) | stores the entity id, never the target slug, so A to B to C resolves A to C | Indirect: a stale URL answers 308 to the current published path, else 404 | n/a |

Slug-redirect rules (`features/slug-redirects/service.ts`): a row is written only if the entity was ever published (`publishedAt != null`); the write is in the same D1 batch as the rename; a live entity taking a slug deletes any redirect row for it; the redirect resolves only to a currently `published` Guide or Field Note.

### Learning

| Entity (table) | Key fields | Statuses | Slug | Relationships | Public? |
|---|---|---|---|---|---|
| **Course** (`courses`) | `title`, `slug`, `description`, `accessMode` (`FREE`/`PAID_ONE_TIME`/`MANUAL_INVOICE`/`PAYMENT_DISABLED`), `coverImage`, `publishedAt` | `draft`/`published`/`archived` | globally unique; redirect on rename | 1:N sections, lessons, enrollments; 0..1 Offer (`offers.courseId` unique) | Not a marketing page. Learner area `/learn/courses/[slug]` shows a published course to anyone; `/learn/courses` needs a session |
| **Course Section** (`course_sections`) | `courseId`, `title`, `position` | none | none | cascades from Course | with the course |
| **Lesson** (`lessons`) | `courseId`, `sectionId`, `title`, `slug`, `body`, `videoUrl` (YouTube only, normalised), `required`, `position`, `publishedAt` | `draft`/`published`/`archived` | unique per course (`lessons_course_slug_unique`); redirect scoped by course id | belongs to Section and Course; 1:N resources, progress | published lessons only, behind enrollment |
| **Lesson Resource** (`lesson_resources`) | `storageKey` (unique, R2 `course-resources/<courseId>/...`), `filename`, `contentType` (PDF only), `size` (max 10 MB), `position` | none | none | cascades from Lesson and Course | Never public: streamed through `/api/course-resources/[id]` to admins and learners with access (`resolveLessonResourceAccess`) |
| **Enrollment** (`enrollments`) | `userId`, `courseId`, `status` (`active`/`completed`/`cancelled`), `accessSource`, `enrolledAt`, `completedAt` | see below | none | unique per (user, course) | private |
| **Lesson Progress** (`lesson_progress`) | `enrollmentId`, `lessonId`, `completedAt` | none | none | unique per (enrollment, lesson) | private |

Enrollment states: `active` to `completed` and back is automatic (reconcile); `cancelled` is **never set by any code path** and `enrollFree` reactivates it (decision pending, `PROJECT-STATUS.md` §7). Only an effectively FREE, non-archived course auto-enrolls.

### Commerce and scheduling catalogue

| Entity (table) | Key fields | Statuses | Slug | Relationships | Public? | Reval. on write |
|---|---|---|---|---|---|---|
| **Offer** (`offers`) | `kind` (`COURSE`/`COACHING`/`WORKSHOP`/`PRODUCT`), `accessMode` (adds `PAID_SESSION`, `COMING_SOON`), `currency`, `amountMinor`, `alternativeCtaLabel/Url`, `active` | `active` boolean only | globally unique (`slugSchema`) | optional `courseId` (unique) or `bookingTypeId` (unique); COURSE needs a course and no booking type; COACHING/WORKSHOP cannot link a course; PRODUCT links neither | `active` offers drive `/coaching`, `/workshop`, `/mission-01`, `/ai-recruiter-os` | `/admin/commerce`, `/coaching`, `/workshop`, `/mission-01`, `/ai-recruiter-os`, `/admin/courses` |
| **Booking Type** (`booking_types`) | `slug` (unique; regex `^[a-z0-9-]+$`, up to 120), `title`, `durationMinutes`, buffers, `minimumNoticeMinutes`, `bookingHorizonDays`, `timezone`, `confirmationPolicy` (`AUTO_CONFIRM`/`AHMED_APPROVAL`/`REQUEST_ONLY`), `accessMode`, `meetingMethod`, `attendeeLimit`, `active` | `active` boolean | unique | 1:N availability windows; 0..1 Offer | via its Offer's pages (live slots, so those pages are `force-dynamic`) | `refreshCommerce` set |
| **Availability Window** (`booking_availability_windows`) | `weekday`, `startMinute`, `endMinute` | none | none | unique per (type, weekday, start, end); overlap trigger in migration 0012 | with the booking type | |
| **Slot Hold** (`slot_holds`) | `slotKey` (unique), `ownerToken`, `acquisitionKey`, `expiresAt` | `HELD`/`CONSUMED`/`RELEASED` | none | one live lease per canonical slot; public TTL 5 min | private | |
| **Booking** (`bookings`) | `requesterName/Email/Phone`, `notes`, `slotKey`, `startAt/endAt`, `timezone`, `status`, `version`, `requestKey` (unique) | `REQUESTED`, `PENDING_APPROVAL`, `CONFIRMED`, `COMPLETED`, `CANCELLED`, `DECLINED` | none | holds, history | private | |
| **Order** (`orders`) | `offerId`, `requestKey` (unique), `customerEmail`, `amountMinor`, `currency`, `status`, `version` | `PENDING`, `REQUIRES_ACTION`, `PAID`, `FULFILLED`, `CANCELLED`, `FAILED`, `REFUNDED` | none | history, payment events | private | |

Booking transitions (`scheduling/bookings.ts`): create gives `PENDING_APPROVAL` under `AHMED_APPROVAL`, else `REQUESTED`; confirm from `REQUESTED` or `PENDING_APPROVAL` (approval policy needs an explicit admin approve); decline from `REQUESTED`/`PENDING_APPROVAL`; cancel from `REQUESTED`/`PENDING_APPROVAL`/`CONFIRMED`; complete from `CONFIRMED`; reschedule only from `CONFIRMED`. Every change is version-checked and appends `booking_history`.

Order payment transitions (`commerce/orders.ts`, `resolvePaymentTarget`): `PENDING` to `REQUIRES_ACTION`/`PAID`/`CANCELLED`/`FAILED`; `REQUIRES_ACTION` to `PAID`/`CANCELLED`/`FAILED`; `PAID` and `FULFILLED` to `REFUNDED`; `CANCELLED`, `FAILED`, `REFUNDED` are terminal. `FULFILLED` is set by the orchestration effect `ORDER_FULFILL`.

Supporting append-only tables (not content): `booking_history`, `order_history`, `payment_events` (unique `callbackKey` and `provider`+`providerEventId`), `orchestration_effects` and `orchestration_history` (effect statuses `PENDING`, `PROCESSING`, `SUCCEEDED`, `RETRYABLE_FAILURE`, `BLOCKED`, `TERMINAL_FAILURE`).

### Leads and operations

| Entity (table) | Key fields | Statuses | Notes |
|---|---|---|---|
| **Lead Submission** (`lead_submissions`) | `idempotencyKey` (unique), `kind` (`workshop`/`coaching`/`ai_os`/`contact`), contact fields, `countryCode`, consent booleans (`privacyAcknowledged`, `researchAccepted`, `emailMarketing`, `whatsapp`, `calls`), `sourceRoute` | `NEW` (default), `REVIEWED`, `CLOSED` | Created by public forms. Same key with different content is an `IDEMPOTENCY_CONFLICT`. Studio inbox at `/admin/leads` (+ `/admin/leads/[id]`, `features/leads/admin.ts`): `NEW` to `REVIEWED`/`CLOSED`, `REVIEWED` to `CLOSED`/`NEW`, `CLOSED` to `NEW`, enforced by a conditional UPDATE (`WHERE id AND status = expected`; stale expectation is `conflict`, other pairs `invalid`). Actions audit as `lead.review`/`lead.close`/`lead.reopen` with from/to status only. PII: never copy into analytics metadata |
| **Public Rate Limit** (`public_rate_limits`) | `scopeKey`, `windowStart`, `count` | none | Operational. Scope keys hold hashes only. Pruned after 24 h, 500 rows per pass, about 1% of consumes |
| **Business Event** (`business_events`) | see `Docs/ANALYTICS-EVENTS.md` | none | Projection, rebuildable from history tables |

### Editorial AI (admin only, never public)

| Entity (table) | Statuses and rules |
|---|---|
| **Knowledge Source** (`knowledge_sources`) | `UPLOADED`, `INGESTING`, `READY`, `FAILED`, `ARCHIVED`. `.txt`/`.md` only; SHA-256 `checksum` unique (duplicate upload rejected); private R2 object. Archived sources cannot be ingested and are excluded from retrieval |
| **Knowledge Chunk** (`knowledge_chunks`) | ordered per source (unique `sourceId`+`ordinal`); mirrored into the FTS5 table `knowledge_chunks_fts` (migration 0006, custom SQL) |
| **Editorial Memory** (`editorial_memory`) | `active` flag plus `archivedAt`; categories `POSITIONING`, `VOICE`, `AUDIENCE`, `METHODOLOGY`, `EDITORIAL_RULE`, `AVOID`, `EDITORIAL_NOTE` |
| **Editorial Draft** (`editorial_drafts`) | `contentType` `GUIDE`/`FIELD_NOTE`. Transitions (`drafts/types.ts`): `DRAFT` to `IN_REVIEW`; `IN_REVIEW` to `DRAFT`, `APPROVED` or `REJECTED`; `REJECTED` to `DRAFT`; `APPROVED` to `PUBLISHED`. Only `PUBLISHED` is terminal |
| **Draft Source** (`editorial_draft_sources`) | provenance: draft to chunk and rank |
| **Editorial Publication** (`editorial_publications`) | one per draft (unique `draftId`), one per target (unique `entityId`, NULL while a reservation is in flight). The draft is marked `PUBLISHED` only after the target Guide or Field Note is verified public. Publishing creates the Guide or Field Note and publishes it; the compensation path unpublishes and discards it |
| **Editorial Audit Log** (`editorial_audit_log`) | `knowledge_ingested`, `knowledge_failed`, `draft_generated`, `draft_edited`, `draft_submitted`, `draft_approved`, `draft_rejected`, `draft_published`. The only audit table; Guide/Field Note/Course/Lesson/media/offer mutations have no equivalent (`PROJECT-STATUS.md` §5) |

Revalidation for drafts is admin-side only (`/admin/editorial`, `/admin/content`); publishing a draft revalidates `/guides` or `/field-notes` and the new detail page (`drafts/actions.ts`).

## 4. Lifecycle gaps

| Gap | State |
|---|---|
| **Trash / restore / permanent delete** (blueprint §5) | Not built. No `trashed` status and no `deletedAt` column anywhere. No Studio delete exists for Guides, Field Notes, Courses or Lessons |
| **Restore from archive** | Not possible. `archived` is terminal for Guides, Field Notes, Courses and Lessons. Only Editorial Memory has a restore (`unarchiveMemory`). Knowledge Sources have no unarchive function, though the ingest error text says "Unarchive first" |
| **Course permanent delete** | Guard exists (`assertCourseDeletable`) but is called by nothing. Blueprint: block delete when enrollments exist |
| **Lesson archive** | `archived` is a valid `LessonStatus`, but no service function sets it, so it is unreachable from the Studio |
| **Lesson Resource delete / replace** | No delete path. Orphaned R2 objects are not tracked |
| **Media delete / usage tracking** | No delete, no "where used"; `media` rows are never referenced by FK |
| **Enrollment cancellation** | No flow sets `cancelled`; reactivation rule undecided |
| **Revisions** | Field Notes only. Guides, Lessons and Courses keep none (CONTEXT.md conflict) |
| **Lead inbox extras** | Inbox and status workflow exist; no search, notes, assignee, export or deletion/retention policy for lead PII |
| **Offer / Booking Type retirement** | Only an `active` toggle; no archive state or history |
| **Page types not built** | Standard Pages, Landing Pages, course sales pages, Product pages as managed content. About, legal, contact, programmes and offer pages are hand-built routes |
| **Scheduled publishing, autosave, categories/tags taxonomy** (blueprint §4.1) | Not built. Guides have free-text `category` and `tags`; Field Notes have none |

## ⚠ Divergences (blueprint or docs vs code)

1. **Archive is terminal in code; the blueprint and `CONTEXT.md` say Archive is reversible and list Restore.** `CONTEXT.md` (Archive entry) also says "Reversible".
2. **Trash does not exist**, though the blueprint diagram is draft, published, archived, trash, permanently deleted. `PROJECT-STATUS.md` §3 and §6 already record this.
3. **`business_events` has no Drizzle table.** It exists only in raw SQL (`drizzle/migrations/0018_business_events.sql`) and is accessed with raw D1 statements. `drizzle-kit generate` therefore does not know it; the unrelated indexes `booking_history_action_created_idx` and `order_history_status_created_idx` are in the same file and also absent from `schema.ts`.
4. **Lesson `archived` status is declared but unreachable** (no `archiveLesson`); `publishLesson` still guards against it.
5. **Unused guard:** `assertCourseDeletable` implements the blueprint's course-protection rule but nothing deletes courses.
6. **Lead inbox (resolved):** the Studio now reads leads and moves them through `NEW`/`REVIEWED`/`CLOSED`. `PROJECT-STATUS.md` §4 wording may still describe the older state. Reopening is allowed from `REVIEWED` and `CLOSED` only; `CLOSED` cannot go straight to `REVIEWED`.
7. **Offer validation throws plain `Error`**, not `AppError` (`offers/service.ts`), so messages are not guaranteed user-safe under `publicErrorMessage`. See `Docs/ENGINEERING-STANDARDS.md`.
8. **Slug rules differ by entity:** content and course slugs use `slugSchema` (min 3, max 100, no uppercase); Booking Type slugs allow uppercase (`/i`), min 1, max 120. `ARCHITECTURE.md` still says migrations run 0000-0018; the repo has 0000-0020.
9. **Blueprint "Product / Workshop page", "Course sales page":** the Offer model carries the commercial data, but no content-managed page type exists for either.
