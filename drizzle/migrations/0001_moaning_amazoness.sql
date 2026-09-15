CREATE TABLE `field_note_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`field_note_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`field_note_id`) REFERENCES `field_notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `field_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`excerpt` text,
	`body` text NOT NULL,
	`cover_image` text,
	`author` text DEFAULT 'Ahmed Awad' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_notes_slug_unique` ON `field_notes` (`slug`);