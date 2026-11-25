CREATE TABLE `email_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`course_nudges` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `course_sections` ADD `release_mode` text DEFAULT 'immediate' NOT NULL;--> statement-breakpoint
ALTER TABLE `course_sections` ADD `release_at` integer;--> statement-breakpoint
ALTER TABLE `course_sections` ADD `drip_days` integer;--> statement-breakpoint
ALTER TABLE `courses` ADD `notify_unlocks` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `courses` ADD `nudge_completed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `courses` ADD `nudge_inactive` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `courses` ADD `nudge_quiz_failed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `courses` ADD `coaching_path` text;--> statement-breakpoint
ALTER TABLE `lessons` ADD `release_mode` text DEFAULT 'immediate' NOT NULL;--> statement-breakpoint
ALTER TABLE `lessons` ADD `release_at` integer;--> statement-breakpoint
ALTER TABLE `lessons` ADD `drip_days` integer;