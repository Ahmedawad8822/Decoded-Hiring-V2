ALTER TABLE `courses` ADD `trashed_at` integer;--> statement-breakpoint
ALTER TABLE `courses` ADD `trashed_from_status` text;--> statement-breakpoint
CREATE INDEX `courses_trashed_at_idx` ON `courses` (`trashed_at`);--> statement-breakpoint
ALTER TABLE `field_notes` ADD `trashed_at` integer;--> statement-breakpoint
ALTER TABLE `field_notes` ADD `trashed_from_status` text;--> statement-breakpoint
CREATE INDEX `field_notes_trashed_at_idx` ON `field_notes` (`trashed_at`);--> statement-breakpoint
ALTER TABLE `guides` ADD `trashed_at` integer;--> statement-breakpoint
ALTER TABLE `guides` ADD `trashed_from_status` text;--> statement-breakpoint
CREATE INDEX `guides_trashed_at_idx` ON `guides` (`trashed_at`);--> statement-breakpoint
ALTER TABLE `lessons` ADD `trashed_at` integer;--> statement-breakpoint
ALTER TABLE `lessons` ADD `trashed_from_status` text;--> statement-breakpoint
CREATE INDEX `lessons_trashed_at_idx` ON `lessons` (`trashed_at`);