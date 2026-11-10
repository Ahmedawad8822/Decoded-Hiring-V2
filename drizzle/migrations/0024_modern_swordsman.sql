ALTER TABLE `courses` ADD `outcomes` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `audience` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `faq` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `instructor_name` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `instructor_bio` text;--> statement-breakpoint
ALTER TABLE `lessons` ADD `is_preview` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `lessons` ADD `duration_minutes` integer;