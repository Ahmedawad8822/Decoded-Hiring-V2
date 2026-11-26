CREATE TABLE `lesson_video_positions` (
	`user_id` text NOT NULL,
	`lesson_id` text NOT NULL,
	`position_seconds` real NOT NULL,
	`duration_seconds` real,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `lesson_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lesson_video_positions_user_idx` ON `lesson_video_positions` (`user_id`);--> statement-breakpoint
ALTER TABLE `courses` ADD `sequential` integer DEFAULT false NOT NULL;