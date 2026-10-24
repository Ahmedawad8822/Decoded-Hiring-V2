CREATE TABLE `slug_redirects` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`old_slug` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slug_redirects_lookup_unique` ON `slug_redirects` (`entity_type`,`scope`,`old_slug`);--> statement-breakpoint
CREATE INDEX `slug_redirects_entity_idx` ON `slug_redirects` (`entity_type`,`entity_id`);