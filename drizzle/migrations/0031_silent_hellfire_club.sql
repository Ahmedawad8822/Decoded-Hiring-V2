CREATE TABLE `admin_person_notes` (
	`user_id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `learner_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tag` text NOT NULL,
	`source` text NOT NULL,
	`source_quiz_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learner_tags_user_tag_unique` ON `learner_tags` (`user_id`,`tag`);--> statement-breakpoint
CREATE INDEX `learner_tags_tag_user_idx` ON `learner_tags` (`tag`,`user_id`);