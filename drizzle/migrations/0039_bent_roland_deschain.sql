CREATE TABLE `landing_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`campaign_name` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_offer_id` text,
	`target_course_id` text,
	`target_guide_id` text,
	`cta_label` text NOT NULL,
	`sections` text NOT NULL,
	`seo_title` text,
	`seo_description` text,
	`noindex` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`trashed_at` integer,
	`trashed_from_status` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer,
	FOREIGN KEY (`target_offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_guide_id`) REFERENCES `guides`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `landing_pages_slug_unique` ON `landing_pages` (`slug`);--> statement-breakpoint
CREATE INDEX `landing_pages_status_idx` ON `landing_pages` (`status`);--> statement-breakpoint
CREATE INDEX `landing_pages_trashed_at_idx` ON `landing_pages` (`trashed_at`);--> statement-breakpoint
CREATE INDEX `landing_pages_ends_at_idx` ON `landing_pages` (`ends_at`);--> statement-breakpoint
CREATE INDEX `landing_pages_target_offer_idx` ON `landing_pages` (`target_offer_id`);--> statement-breakpoint
CREATE INDEX `landing_pages_target_course_idx` ON `landing_pages` (`target_course_id`);--> statement-breakpoint
CREATE INDEX `landing_pages_target_guide_idx` ON `landing_pages` (`target_guide_id`);--> statement-breakpoint
ALTER TABLE `lead_submissions` ADD `landing_page_id` text;--> statement-breakpoint
ALTER TABLE `lead_submissions` ADD `utm_params` text;--> statement-breakpoint
CREATE INDEX `lead_submissions_landing_page_idx` ON `lead_submissions` (`landing_page_id`);