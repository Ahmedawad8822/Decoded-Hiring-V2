CREATE TABLE `lesson_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`lesson_id` text NOT NULL,
	`course_id` text NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`answer_body` text,
	`answered_at` integer,
	`answered_by` text,
	`is_public` integer DEFAULT false NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lesson_questions_idempotency_key_unique` ON `lesson_questions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `lesson_questions_user_lesson_idx` ON `lesson_questions` (`user_id`,`lesson_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `lesson_questions_user_created_idx` ON `lesson_questions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `lesson_questions_status_created_idx` ON `lesson_questions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `lesson_questions_public_lesson_idx` ON `lesson_questions` (`lesson_id`,`status`,`is_public`);