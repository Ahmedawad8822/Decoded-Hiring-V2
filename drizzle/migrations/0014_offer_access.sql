CREATE TABLE `offers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`course_id` text,
	`booking_type_id` text,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`access_mode` text NOT NULL,
	`currency` text,
	`amount_minor` integer,
	`alternative_cta_label` text,
	`alternative_cta_url` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`booking_type_id`) REFERENCES `booking_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offers_slug_unique` ON `offers` (`slug`);--> statement-breakpoint
CREATE INDEX `offers_kind_idx` ON `offers` (`kind`);--> statement-breakpoint
CREATE INDEX `offers_active_idx` ON `offers` (`active`);--> statement-breakpoint
CREATE UNIQUE INDEX `offers_course_unique` ON `offers` (`course_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `offers_booking_type_unique` ON `offers` (`booking_type_id`);
