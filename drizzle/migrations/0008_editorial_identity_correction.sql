-- Migration 0008: Editorial identity correction
-- Correct Decoded Hiring identity contamination in default author columns.
-- "Ahmed Awad" is a personal name that leaked into production schema defaults;
-- the canonical platform identity is "Decoded Editorial" (see DEFAULT_PUBLISH_AUTHOR
-- in drafts/service.ts). This migration:
--   1. Recreates the guides and field_notes tables with the corrected DEFAULT.
--   2. Backfills existing rows that still carry the old personal-name default.
--
-- See: schema.ts guides.author / field_notes.author defaults.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_field_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`excerpt` text,
	`body` text NOT NULL,
	`cover_image` text,
	`author` text DEFAULT 'Decoded Editorial' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer
);--> statement-breakpoint
INSERT INTO `__new_field_notes`("id", "title", "slug", "excerpt", "body", "cover_image", "author", "status", "meta_title", "meta_description", "created_at", "updated_at", "published_at") SELECT "id", "title", "slug", "excerpt", "body", "cover_image", "author", "status", "meta_title", "meta_description", "created_at", "updated_at", "published_at" FROM `field_notes`;--> statement-breakpoint
UPDATE `__new_field_notes` SET `author` = 'Decoded Editorial' WHERE `author` = 'Ahmed Awad';--> statement-breakpoint
DROP TABLE `field_notes`;--> statement-breakpoint
ALTER TABLE `__new_field_notes` RENAME TO `field_notes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `field_notes_slug_unique` ON `field_notes` (`slug`);--> statement-breakpoint
CREATE TABLE `__new_guides` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`excerpt` text,
	`body` text NOT NULL,
	`cover_image` text,
	`author` text DEFAULT 'Decoded Editorial' NOT NULL,
	`category` text,
	`tags` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`og_image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer
);--> statement-breakpoint
INSERT INTO `__new_guides`("id", "title", "slug", "excerpt", "body", "cover_image", "author", "category", "tags", "status", "meta_title", "meta_description", "og_image", "created_at", "updated_at", "published_at") SELECT "id", "title", "slug", "excerpt", "body", "cover_image", "author", "category", "tags", "status", "meta_title", "meta_description", "og_image", "created_at", "updated_at", "published_at" FROM `guides`;--> statement-breakpoint
UPDATE `__new_guides` SET `author` = 'Decoded Editorial' WHERE `author` = 'Ahmed Awad';--> statement-breakpoint
DROP TABLE `guides`;--> statement-breakpoint
ALTER TABLE `__new_guides` RENAME TO `guides`;--> statement-breakpoint
CREATE UNIQUE INDEX `guides_slug_unique` ON `guides` (`slug`);
