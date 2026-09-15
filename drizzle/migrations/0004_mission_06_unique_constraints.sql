DROP INDEX `lessons_course_slug_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `lessons_course_slug_unique` ON `lessons` (`course_id`,`slug`);--> statement-breakpoint
DROP INDEX `enrollments_user_course_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `enrollments_user_course_unique` ON `enrollments` (`user_id`,`course_id`);--> statement-breakpoint
DROP INDEX `lesson_progress_enrollment_lesson_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `lesson_progress_enrollment_lesson_unique` ON `lesson_progress` (`enrollment_id`,`lesson_id`);