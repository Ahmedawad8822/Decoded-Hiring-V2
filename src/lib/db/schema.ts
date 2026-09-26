import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ContentStatus } from "@/features/publishing/types";

// ============================================================================
// IDENTITY DOMAIN (Better Auth + Admin Plugin)
// Generated & verified from Better Auth 1.7.5 configuration
// ============================================================================

export const users = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  // Correction 1: Normal users default to "user". Admin role is granted explicitly.
  role: text("role").notNull().default("user"),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" }),
});

export const sessions = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"),
});

export const accounts = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const verifications = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

// ============================================================================
// CONTENT / PUBLISHING DOMAIN (Guides)
// ============================================================================

export type GuideStatus = ContentStatus;

export const guides = sqliteTable("guides", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  excerpt: text("excerpt"),
  body: text("body").notNull(), // JSON-stringified GuideBlock[]
  coverImage: text("cover_image"),
  author: text("author").notNull().default("Decoded Editorial"),
  category: text("category"),
  tags: text("tags"),
  status: text("status").$type<GuideStatus>().notNull().default("draft"),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  ogImage: text("og_image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  publishedAt: integer("published_at", { mode: "timestamp" }),
});

// ============================================================================
// CONTENT / PUBLISHING DOMAIN (Field Notes — Mission 05)
// ----------------------------------------------------------------------------
// Dedicated table (not polymorphic with guides): Field Notes are shorter,
// timely, observation-led notes with no category taxonomy. They share the
// ContentStatus lifecycle, ContentBlock storage model, media boundary,
// preview rule, and cache strategy with Guides — but persist separately.
// Revision history preserves meaningful edit snapshots, especially for
// published content (publish + every update while published).
// ============================================================================

export type FieldNoteStatus = ContentStatus;

export const fieldNotes = sqliteTable("field_notes", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  excerpt: text("excerpt"),
  body: text("body").notNull(), // JSON-stringified ContentBlock[]
  coverImage: text("cover_image"),
  author: text("author").notNull().default("Decoded Editorial"),
  status: text("status").$type<FieldNoteStatus>().notNull().default("draft"),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  publishedAt: integer("published_at", { mode: "timestamp" }),
});

export type FieldNoteRevisionTrigger = "publish" | "update" | "unpublish" | "archive";

export const fieldNoteRevisions = sqliteTable(
  "field_note_revisions",
  {
    id: text("id").primaryKey(),
    fieldNoteId: text("field_note_id")
      .notNull()
      .references(() => fieldNotes.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(), // JSON-stringified ContentBlock[] snapshot
    status: text("status").$type<FieldNoteStatus>().notNull(),
    trigger: text("trigger").$type<FieldNoteRevisionTrigger>().notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("field_note_revisions_note_idx").on(table.fieldNoteId),
  ]
);

// ============================================================================
// MEDIA DOMAIN (Cloudflare R2 Metadata)
// ============================================================================

export const media = sqliteTable("media", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  uploadedBy: text("uploaded_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Guide = typeof guides.$inferSelect;
export type FieldNote = typeof fieldNotes.$inferSelect;
export type FieldNoteRevision = typeof fieldNoteRevisions.$inferSelect;
export type Media = typeof media.$inferSelect;

// ============================================================================
// LEARNING PLATFORM DOMAIN (Mission 06 — vertical slice)
// ----------------------------------------------------------------------------
// Dedicated course tables. Archived courses: no NEW enrollments, but existing
// enrolled learners retain access (explicit decision, documented in
// Docs/Engineering/MISSION-06-LEARNING-PLATFORM.md).
// Access modes are provider-neutral from day one; only FREE auto-enrolls.
// No permanent delete exposed in Mission 06.
// ============================================================================

export type CourseStatus = "draft" | "published" | "archived";
export type CourseAccessMode = "FREE" | "PAID_ONE_TIME" | "MANUAL_INVOICE" | "PAYMENT_DISABLED";
export type LessonStatus = "draft" | "published" | "archived";
export type EnrollmentStatus = "active" | "completed" | "cancelled";

export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  status: text("status").$type<CourseStatus>().notNull().default("draft"),
  accessMode: text("access_mode").$type<CourseAccessMode>().notNull().default("FREE"),
  coverImage: text("cover_image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  publishedAt: integer("published_at", { mode: "timestamp" }),
});

export const courseSections = sqliteTable(
  "course_sections",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("course_sections_course_idx").on(table.courseId)]
);

export const lessons = sqliteTable(
  "lessons",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    sectionId: text("section_id")
      .notNull()
      .references(() => courseSections.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    body: text("body").notNull().default("[]"), // JSON-stringified ContentBlock[]
    videoUrl: text("video_url"),
    required: integer("required", { mode: "boolean" }).notNull().default(true),
    position: integer("position").notNull().default(0),
    status: text("status").$type<LessonStatus>().notNull().default("draft"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    publishedAt: integer("published_at", { mode: "timestamp" }),
  },
  (table) => [
    index("lessons_course_idx").on(table.courseId),
    index("lessons_section_idx").on(table.sectionId),
    uniqueIndex("lessons_course_slug_unique").on(table.courseId, table.slug),
  ]
);

export const lessonResources = sqliteTable(
  "lesson_resources",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("lesson_resources_lesson_idx").on(table.lessonId)]
);

export const enrollments = sqliteTable(
  "enrollments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    status: text("status").$type<EnrollmentStatus>().notNull().default("active"),
    accessSource: text("access_source").notNull().default("free"),
    enrolledAt: integer("enrolled_at", { mode: "timestamp" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("enrollments_user_course_unique").on(table.userId, table.courseId),
    index("enrollments_course_idx").on(table.courseId),
  ]
);

export const lessonProgress = sqliteTable(
  "lesson_progress",
  {
    id: text("id").primaryKey(),
    enrollmentId: text("enrollment_id")
      .notNull()
      .references(() => enrollments.id, { onDelete: "cascade" }),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    completedAt: integer("completed_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [uniqueIndex("lesson_progress_enrollment_lesson_unique").on(table.enrollmentId, table.lessonId)]
);

export type Course = typeof courses.$inferSelect;
export type CourseSection = typeof courseSections.$inferSelect;
export type Lesson = typeof lessons.$inferSelect;
export type LessonResource = typeof lessonResources.$inferSelect;
export type Enrollment = typeof enrollments.$inferSelect;
export type LessonProgress = typeof lessonProgress.$inferSelect;

// ============================================================================
// EDITORIAL AI DOMAIN (Mission 07 — website editorial AI foundation)
// ----------------------------------------------------------------------------
// Knowledge library (private, admin-only), editorial memory, structured draft
// lifecycle, source provenance, and a narrow audit trail. FTS5 virtual table
// (knowledge_chunks_fts) is created via custom SQL migration — see migration
// 0006 — because Drizzle does not manage SQLite virtual-table semantics.
// ============================================================================

export type KnowledgeSourceStatus = "UPLOADED" | "INGESTING" | "READY" | "FAILED" | "ARCHIVED";
export type KnowledgeSourceType = "text" | "markdown";

export const knowledge_sources = sqliteTable(
  "knowledge_sources",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    sourceType: text("source_type").notNull(), // text | markdown
    mimeType: text("mime_type").notNull(),
    originalFilename: text("original_filename").notNull(),
    // Server-generated R2 key. Never client-supplied.
    r2Key: text("r2_key").notNull().unique(),
    author: text("author"),
    sourceLabel: text("source_label"),
    notes: text("notes"),
    status: text("status").notNull().default("UPLOADED"),
    checksum: text("checksum").notNull(), // SHA-256 of original bytes
    byteSize: integer("byte_size").notNull(),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    ingestedAt: integer("ingested_at", { mode: "timestamp" }),
    error: text("error"),
    archivedAt: integer("archived_at", { mode: "timestamp" }),
  },
  (table) => [
    index("knowledge_sources_status_idx").on(table.status),
    // UNIQUE (was a plain index) — concurrent identical uploads collide here;
    // see storage.ts which converts this into the friendly duplicate error.
    uniqueIndex("knowledge_sources_checksum_unique").on(table.checksum),
  ]
);

export const knowledge_chunks = sqliteTable(
  "knowledge_chunks",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => knowledge_sources.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    heading: text("heading"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    characterCount: integer("character_count").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("knowledge_chunks_source_idx").on(table.sourceId),
    // Deterministic per-source ordering backstop at the DB level.
    uniqueIndex("knowledge_chunks_source_ordinal_unique").on(table.sourceId, table.ordinal),
  ]
);

// NOTE: GCC_CONTEXT was removed from EditorialMemoryCategory during Mission 07
// remediation — the compiler/toolchain vertical leaked into the editorial
// memory seed and does not belong to the general website editorial AI. See
// migration 0007.
export type EditorialMemoryCategory =
  | "POSITIONING"
  | "VOICE"
  | "AUDIENCE"
  | "METHODOLOGY"
  | "EDITORIAL_RULE"
  | "AVOID"
  | "EDITORIAL_NOTE";

export const editorial_memory = sqliteTable(
  "editorial_memory",
  {
    id: text("id").primaryKey(),
    category: text("category").notNull(), // EditorialMemoryCategory
    content: text("content").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp" }),
  },
  (table) => [
    index("editorial_memory_category_idx").on(table.category),
    index("editorial_memory_active_idx").on(table.active),
  ]
);

export type DraftContentType = "GUIDE" | "FIELD_NOTE";
export type DraftStatus = "DRAFT" | "IN_REVIEW" | "APPROVED" | "REJECTED" | "PUBLISHED";

export const editorial_drafts = sqliteTable(
  "editorial_drafts",
  {
    id: text("id").primaryKey(),
    contentType: text("content_type").notNull(), // GUIDE | FIELD_NOTE
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    excerpt: text("excerpt"),
    body: text("body").notNull(), // JSON-stringified ContentBlock[]
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    status: text("status").notNull().default("DRAFT"),
    skillId: text("skill_id").notNull(),
    skillVersion: text("skill_version").notNull(),
    provider: text("provider"),
    model: text("model"),
    createdBy: text("created_by").notNull(),
    reviewedBy: text("reviewed_by"),
    approvedBy: text("approved_by"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    submittedAt: integer("submitted_at", { mode: "timestamp" }),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    rejectedAt: integer("rejected_at", { mode: "timestamp" }),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    publishedEntityId: text("published_entity_id"),
    publishedEntityType: text("published_entity_type"),
  },
  (table) => [
    // Idempotency backstop: one published entity per draft (UNIQUE on
    // published_entity_id when NOT NULL). A second publish attempt against the
    // same target raises a real DB error.
    uniqueIndex("editorial_drafts_published_entity_unique").on(table.publishedEntityId),
    index("editorial_drafts_status_idx").on(table.status),
    index("editorial_drafts_content_type_idx").on(table.contentType),
  ]
);

export const editorial_draft_sources = sqliteTable(
  "editorial_draft_sources",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => editorial_drafts.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => knowledge_sources.id),
    chunkId: text("chunk_id")
      .notNull()
      .references(() => knowledge_chunks.id),
    rank: integer("rank").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("editorial_draft_sources_draft_idx").on(table.draftId),
    index("editorial_draft_sources_chunk_idx").on(table.chunkId),
  ]
);

// ============================================================================
// EDITORIAL AI — PUBLICATION RECORD (Mission 07 §6)
// ----------------------------------------------------------------------------
// Authoritative, draft-owned link between an APPROVED editorial draft and the
// Guide/Field Note it produced. This is the single source of truth for
// "has this draft been published and to which target?", replacing the old
// slug-based relinking heuristic (which could not distinguish a draft's OWN
// retry from an unrelated guide sharing a slug).
//
// Invariants:
//  - One draft -> at most one publication record (UNIQUE draftId).
//  - One finalized target -> at most one publication record (UNIQUE entityId;
//    SQLite permits multiple NULL entityId rows, which is what lets a draft
//    hold an in-flight CREATING reservation without colliding with other
//    drafts' reservations).
//  - An editorial draft is only marked PUBLISHED once its target is verified
//    publicly visible.
// ============================================================================

export const editorial_publications = sqliteTable(
  "editorial_publications",
  {
    id: text("id").primaryKey(),
    // UNIQUE: one publication record per draft (prevents double-publish).
    draftId: text("draft_id").notNull().unique(),
    entityType: text("entity_type").notNull(), // 'guide' | 'field_note'
    // NULL while a publish reservation is in flight (CREATING state);
    // set to the target entity id once finalized (PUBLISHED).
    entityId: text("entity_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    // One finalized target per publication record (backstop against two
    // drafts both claiming the same guide/field-note).
    uniqueIndex("editorial_publications_entity_unique").on(table.entityId),
  ]
);

export type EditorialAuditAction =
  | "knowledge_ingested"
  | "knowledge_failed"
  | "draft_generated"
  | "draft_edited"
  | "draft_submitted"
  | "draft_approved"
  | "draft_rejected"
  | "draft_published";

export const editorial_audit_log = sqliteTable(
  "editorial_audit_log",
  {
    id: text("id").primaryKey(),
    actor: text("actor").notNull(), // user id of the admin performing the action
    entityType: text("entity_type").notNull(), // 'knowledge_source' | 'knowledge_chunk' | 'editorial_draft' | 'guide' | 'field_note'
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(), // EditorialAuditAction
    detail: text("detail"), // optional JSON with extra context
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("editorial_audit_log_entity_idx").on(table.entityType, table.entityId),
    index("editorial_audit_log_actor_idx").on(table.actor),
  ]
);

export type KnowledgeSource = typeof knowledge_sources.$inferSelect;
export type KnowledgeChunk = typeof knowledge_chunks.$inferSelect;
export type EditorialMemory = typeof editorial_memory.$inferSelect;
export type EditorialDraft = typeof editorial_drafts.$inferSelect;
export type EditorialDraftSource = typeof editorial_draft_sources.$inferSelect;
export type EditorialPublication = typeof editorial_publications.$inferSelect;
export type EditorialAuditLog = typeof editorial_audit_log.$inferSelect;

// ============================================================================
// SCHEDULING DOMAIN (Mission 08.1 — Booking Types, Availability, Slot Holds)
// ----------------------------------------------------------------------------
// Booking types define a service's availability policy: duration, buffers,
// notice/horizon windows, a presentation timezone, confirmation/access/meeting
// policies, and weekly availability windows.
//
// Slots are canonical (deterministic identity). A short-lived "hold" lease
// reserves one canonical slot for a single owning token at a time.
// ============================================================================

export type ConfirmationPolicy = "AUTO_CONFIRM" | "AHMED_APPROVAL" | "REQUEST_ONLY";
export type BookingAccessMode = "FREE" | "PAID_SESSION" | "MANUAL_INVOICE" | "PAYMENT_DISABLED";
export type MeetingMethod = "GOOGLE_MEET" | "EXTERNAL_LINK" | "PHONE" | "IN_PERSON" | "TO_BE_CONFIRMED";
export type SlotHoldStatus = "HELD" | "CONSUMED" | "RELEASED";

export const bookingTypes = sqliteTable(
  "booking_types",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull(),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    minimumNoticeMinutes: integer("minimum_notice_minutes").notNull().default(0),
    bookingHorizonDays: integer("booking_horizon_days").notNull(),
    timezone: text("timezone").notNull(),
    confirmationPolicy: text("confirmation_policy")
      .$type<ConfirmationPolicy>()
      .notNull()
      .default("AUTO_CONFIRM"),
    accessMode: text("access_mode")
      .$type<BookingAccessMode>()
      .notNull()
      .default("FREE"),
    meetingMethod: text("meeting_method")
      .$type<MeetingMethod>()
      .notNull()
      .default("TO_BE_CONFIRMED"),
    attendeeLimit: integer("attendee_limit").notNull().default(1),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("idx_booking_types_active").on(table.active)]
);

export const bookingAvailabilityWindows = sqliteTable(
  "booking_availability_windows",
  {
    id: text("id").primaryKey(),
    bookingTypeId: text("booking_type_id")
      .notNull()
      .references(() => bookingTypes.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("idx_booking_windows_type").on(table.bookingTypeId),
    uniqueIndex("idx_booking_windows_unique").on(
      table.bookingTypeId,
      table.weekday,
      table.startMinute,
      table.endMinute,
    ),
  ]
);

export const slotHolds = sqliteTable(
  "slot_holds",
  {
    id: text("id").primaryKey(),
    bookingTypeId: text("booking_type_id")
      .notNull()
      .references(() => bookingTypes.id, { onDelete: "cascade" }),
    slotKey: text("slot_key").notNull().unique(),
    startAt: integer("start_at", { mode: "timestamp" }).notNull(),
    endAt: integer("end_at", { mode: "timestamp" }).notNull(),
    ownerToken: text("owner_token").notNull(),
    /**
     * Server-issued idempotency identity for the logical booking attempt that
     * owns the lease. Nullable for backward compatibility with holds created
     * before this column existed — those are treated as unique attempts.
     */
    acquisitionKey: text("acquisition_key"),
    status: text("status").$type<SlotHoldStatus>().notNull().default("HELD"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
    releasedAt: integer("released_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("idx_slot_holds_booking_type").on(table.bookingTypeId),
    index("idx_slot_holds_expires_at").on(table.expiresAt),
    index("idx_slot_holds_owner").on(table.ownerToken),
  ]
);

export type BookingType = typeof bookingTypes.$inferSelect;
export type BookingAvailabilityWindow = typeof bookingAvailabilityWindows.$inferSelect;
export type SlotHold = typeof slotHolds.$inferSelect;

// ============================================================================
// BOOKING LIFECYCLE DOMAIN (Mission 08.2)
// ----------------------------------------------------------------------------
// A booking is bound to one generation of a slot-hold lease via the pair
// (holdId, holdAcquisitionKey). slot_holds rows are reclaimed in place, so
// holdId alone is not a durable ownership identity.
//
// version is a CAS token for server-authoritative transitions. booking_history
// is append-only business audit; reschedules preserve the previous slot in
// history rather than silently erasing it.
// ============================================================================

export type BookingStatus =
  | "REQUESTED"
  | "PENDING_APPROVAL"
  | "CONFIRMED"
  | "COMPLETED"
  | "CANCELLED"
  | "DECLINED";

export type BookingHistoryAction =
  | "REQUESTED"
  | "AUTO_CONFIRMED"
  | "APPROVED"
  | "CONFIRMED"
  | "DECLINED"
  | "CANCELLED"
  | "COMPLETED"
  | "RESCHEDULED";

export const bookings = sqliteTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    bookingTypeId: text("booking_type_id")
      .notNull()
      .references(() => bookingTypes.id),
    holdId: text("hold_id")
      .notNull()
      .references(() => slotHolds.id),
    holdAcquisitionKey: text("hold_acquisition_key").notNull(),
    requestKey: text("request_key").notNull().unique(),
    requesterName: text("requester_name").notNull(),
    requesterEmail: text("requester_email").notNull(),
    requesterPhone: text("requester_phone"),
    notes: text("notes"),
    slotKey: text("slot_key").notNull(),
    startAt: integer("start_at", { mode: "timestamp" }).notNull(),
    endAt: integer("end_at", { mode: "timestamp" }).notNull(),
    timezone: text("timezone").notNull(),
    status: text("status").$type<BookingStatus>().notNull().default("REQUESTED"),
    version: integer("version").notNull().default(1),
    transitionKey: text("transition_key"),
    approvedBy: text("approved_by"),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    confirmedAt: integer("confirmed_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    cancelledBy: text("cancelled_by"),
    cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
    declinedBy: text("declined_by"),
    declinedAt: integer("declined_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("bookings_hold_generation_unique").on(
      table.holdId,
      table.holdAcquisitionKey,
    ),
    index("bookings_booking_type_idx").on(table.bookingTypeId),
    index("bookings_status_idx").on(table.status),
    index("bookings_start_at_idx").on(table.startAt),
    index("bookings_requester_email_idx").on(table.requesterEmail),
  ]
);

export const bookingHistory = sqliteTable(
  "booking_history",
  {
    id: text("id").primaryKey(),
    bookingId: text("booking_id")
      .notNull()
      .references(() => bookings.id),
    action: text("action").$type<BookingHistoryAction>().notNull(),
    fromStatus: text("from_status").$type<BookingStatus>(),
    toStatus: text("to_status").$type<BookingStatus>().notNull(),
    actorId: text("actor_id"),
    detail: text("detail"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("booking_history_booking_idx").on(table.bookingId),
    index("booking_history_created_at_idx").on(table.createdAt),
  ]
);

export type Booking = typeof bookings.$inferSelect;
export type BookingHistory = typeof bookingHistory.$inferSelect;

// ============================================================================
// OFFER / ACCESS DOMAIN (Mission 08.3)
// ----------------------------------------------------------------------------
// Offer is the commercial/public presentation layer. It may point to a course
// or booking type, while learner entitlement and booking state remain owned by
// their respective domains. Existing Mission 06 course.accessMode remains a
// compatibility fallback until a course receives its first linked Offer.
//
// One course or booking type has at most one primary Offer in this slice.
// SQLite allows multiple NULL values in these unique indexes, so standalone
// PRODUCT offers remain unrestricted.
// ============================================================================

export type OfferKind = "COURSE" | "COACHING" | "WORKSHOP" | "PRODUCT";
export type OfferAccessMode =
  | "FREE"
  | "PAID_ONE_TIME"
  | "PAID_SESSION"
  | "MANUAL_INVOICE"
  | "PAYMENT_DISABLED"
  | "COMING_SOON";

export const offers = sqliteTable(
  "offers",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<OfferKind>().notNull(),
    courseId: text("course_id").references(() => courses.id),
    bookingTypeId: text("booking_type_id").references(() => bookingTypes.id),
    title: text("title").notNull(),
    slug: text("slug").notNull().unique(),
    accessMode: text("access_mode").$type<OfferAccessMode>().notNull(),
    currency: text("currency"),
    amountMinor: integer("amount_minor"),
    alternativeCtaLabel: text("alternative_cta_label"),
    alternativeCtaUrl: text("alternative_cta_url"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("offers_kind_idx").on(table.kind),
    index("offers_active_idx").on(table.active),
    uniqueIndex("offers_course_unique").on(table.courseId),
    uniqueIndex("offers_booking_type_unique").on(table.bookingTypeId),
  ],
);

export type Offer = typeof offers.$inferSelect;

// ============================================================================
// ORDER / PAYMENT + DURABLE ORCHESTRATION DOMAIN (Mission 08.5)
// ----------------------------------------------------------------------------
// Orders are Decoded Hiring business truth. Provider ids are metadata only.
// Payment providers may prove PAID/FAILED/etc., but FULFILLED is an internal
// transition owned by Decoded Hiring after durable business effects succeed.
//
// orchestration_effects is a D1-backed outbox/lease queue. Every effect has one
// stable idempotency key reused across retries. orchestration_history is
// append-only audit of enqueue/claim/success/failure/recovery.
// ============================================================================

export type OrderStatus =
  | "PENDING"
  | "REQUIRES_ACTION"
  | "PAID"
  | "FULFILLED"
  | "CANCELLED"
  | "FAILED"
  | "REFUNDED";

export type PaymentState =
  | "PENDING"
  | "REQUIRES_ACTION"
  | "PAID"
  | "CANCELLED"
  | "FAILED"
  | "REFUNDED";

export type OrderHistorySource = "SYSTEM" | "ADMIN" | "PAYMENT_CALLBACK" | "PAYMENT_WEBHOOK";

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    offerId: text("offer_id")
      .notNull()
      .references(() => offers.id),
    offerKind: text("offer_kind").$type<OfferKind>().notNull(),
    accessMode: text("access_mode").$type<OfferAccessMode>().notNull(),
    courseId: text("course_id").references(() => courses.id),
    bookingTypeId: text("booking_type_id").references(() => bookingTypes.id),
    bookingId: text("booking_id").references(() => bookings.id),
    userId: text("user_id").references(() => users.id),
    requestKey: text("request_key").notNull().unique(),
    customerEmail: text("customer_email").notNull(),
    quantity: integer("quantity").notNull().default(1),
    amountMinor: integer("amount_minor"),
    currency: text("currency"),
    status: text("status").$type<OrderStatus>().notNull().default("PENDING"),
    version: integer("version").notNull().default(1),
    transitionKey: text("transition_key"),
    providerCheckoutId: text("provider_checkout_id"),
    providerPaymentId: text("provider_payment_id"),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    fulfilledAt: integer("fulfilled_at", { mode: "timestamp" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
    failedAt: integer("failed_at", { mode: "timestamp" }),
    refundedAt: integer("refunded_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("orders_offer_idx").on(table.offerId),
    index("orders_course_idx").on(table.courseId),
    index("orders_booking_type_idx").on(table.bookingTypeId),
    index("orders_booking_idx").on(table.bookingId),
    index("orders_user_idx").on(table.userId),
    index("orders_status_idx").on(table.status),
    index("orders_customer_email_idx").on(table.customerEmail),
  ],
);

export const orderHistory = sqliteTable(
  "order_history",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    fromStatus: text("from_status").$type<OrderStatus>(),
    toStatus: text("to_status").$type<OrderStatus>().notNull(),
    source: text("source").$type<OrderHistorySource>().notNull(),
    actorId: text("actor_id"),
    detail: text("detail"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("order_history_order_idx").on(table.orderId),
    index("order_history_created_idx").on(table.createdAt),
  ],
);

export const paymentEvents = sqliteTable(
  "payment_events",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    callbackKey: text("callback_key").notNull().unique(),
    source: text("source").$type<"CALLBACK" | "WEBHOOK">().notNull(),
    provider: text("provider"),
    providerEventId: text("provider_event_id"),
    providerCheckoutId: text("provider_checkout_id"),
    providerPaymentId: text("provider_payment_id"),
    state: text("state").$type<PaymentState>().notNull(),
    amountMinor: integer("amount_minor"),
    currency: text("currency"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("payment_events_order_idx").on(table.orderId),
    uniqueIndex("payment_events_provider_event_unique").on(
      table.provider,
      table.providerEventId,
    ),
  ],
);

export type OrchestrationSubjectType = "ORDER" | "BOOKING";
export type OrchestrationProviderKind =
  | "internal"
  | "payment"
  | "calendar"
  | "mailbox"
  | "meeting";
export type OrchestrationEffectType =
  | "PAYMENT_CHECKOUT_CREATE"
  | "ORDER_FULFILL"
  | "ORDER_REFUND_RECONCILE"
  | "CALENDAR_CREATE"
  | "CALENDAR_UPDATE"
  | "CALENDAR_CANCEL"
  | "MAIL_CONFIRMATION"
  | "MAIL_RESCHEDULE"
  | "MAIL_CANCELLATION"
  | "MAIL_REMINDER";
export type OrchestrationEffectStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "RETRYABLE_FAILURE"
  | "BLOCKED"
  | "TERMINAL_FAILURE";
export type OrchestrationHistoryAction =
  | "ENQUEUED"
  | "CLAIMED"
  | "SUCCEEDED"
  | "RETRYABLE_FAILURE"
  | "BLOCKED"
  | "TERMINAL_FAILURE"
  | "LEASE_RECOVERED"
  | "RESET";

export const orchestrationEffects = sqliteTable(
  "orchestration_effects",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type").$type<OrchestrationSubjectType>().notNull(),
    subjectId: text("subject_id").notNull(),
    effectType: text("effect_type").$type<OrchestrationEffectType>().notNull(),
    providerKind: text("provider_kind").$type<OrchestrationProviderKind>().notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    dependsOnEffectId: text("depends_on_effect_id"),
    payload: text("payload").notNull(),
    status: text("status").$type<OrchestrationEffectStatus>().notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimToken: text("claim_token"),
    transitionKey: text("transition_key"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp" }),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }),
    providerRef: text("provider_ref"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastAttemptAt: integer("last_attempt_at", { mode: "timestamp" }),
    succeededAt: integer("succeeded_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("orchestration_effects_subject_idx").on(table.subjectType, table.subjectId),
    index("orchestration_effects_status_idx").on(table.status),
    index("orchestration_effects_dependency_idx").on(table.dependsOnEffectId),
    index("orchestration_effects_next_attempt_idx").on(table.nextAttemptAt),
  ],
);

export const orchestrationHistory = sqliteTable(
  "orchestration_history",
  {
    id: text("id").primaryKey(),
    effectId: text("effect_id")
      .notNull()
      .references(() => orchestrationEffects.id),
    action: text("action").$type<OrchestrationHistoryAction>().notNull(),
    fromStatus: text("from_status").$type<OrchestrationEffectStatus>(),
    toStatus: text("to_status").$type<OrchestrationEffectStatus>().notNull(),
    detail: text("detail"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("orchestration_history_effect_idx").on(table.effectId),
    index("orchestration_history_created_idx").on(table.createdAt),
  ],
);

export type Order = typeof orders.$inferSelect;
export type OrderHistory = typeof orderHistory.$inferSelect;
export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type OrchestrationEffect = typeof orchestrationEffects.$inferSelect;
export type OrchestrationHistory = typeof orchestrationHistory.$inferSelect;
