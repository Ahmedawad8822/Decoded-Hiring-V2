CREATE TABLE `lesson_quizzes` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`lesson_id` text NOT NULL,
	`questions` text NOT NULL,
	`pass_percent` integer DEFAULT 70 NOT NULL,
	`require_pass` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lesson_quizzes_lesson_unique` ON `lesson_quizzes` (`lesson_id`);--> statement-breakpoint
CREATE INDEX `lesson_quizzes_course_idx` ON `lesson_quizzes` (`course_id`);--> statement-breakpoint
CREATE TABLE `quiz_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`quiz_id` text NOT NULL,
	`user_id` text NOT NULL,
	`enrollment_id` text NOT NULL,
	`lesson_id` text NOT NULL,
	`answers` text NOT NULL,
	`score_percent` integer NOT NULL,
	`correct_count` integer NOT NULL,
	`total_count` integer NOT NULL,
	`passed` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`quiz_id`) REFERENCES `lesson_quizzes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `quiz_attempts_user_quiz_created_idx` ON `quiz_attempts` (`user_id`,`quiz_id`,`created_at`);