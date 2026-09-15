import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
  author: text("author").notNull().default("Ahmed Awad"),
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
  author: text("author").notNull().default("Ahmed Awad"),
  status: text("status").$type<FieldNoteStatus>().notNull().default("draft"),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  publishedAt: integer("published_at", { mode: "timestamp" }),
});

export type FieldNoteRevisionTrigger = "publish" | "update" | "unpublish" | "archive";

export const fieldNoteRevisions = sqliteTable("field_note_revisions", {
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
}, (table) => [
  index("field_note_revisions_note_idx").on(table.fieldNoteId),
]);

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
