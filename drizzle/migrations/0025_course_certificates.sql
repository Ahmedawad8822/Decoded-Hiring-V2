CREATE TABLE `certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text NOT NULL,
	`enrollment_id` text NOT NULL,
	`recipient_name` text NOT NULL,
	`course_title` text NOT NULL,
	`issued_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `certificates_user_course_unique` ON `certificates` (`user_id`,`course_id`);--> statement-breakpoint
CREATE INDEX `certificates_course_idx` ON `certificates` (`course_id`);--> statement-breakpoint
ALTER TABLE `courses` ADD `certificate_enabled` integer DEFAULT false NOT NULL;