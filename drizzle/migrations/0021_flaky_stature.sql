CREATE TABLE `admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`details` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_audit_log_entity_idx` ON `admin_audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `admin_audit_log_created_idx` ON `admin_audit_log` (`created_at`);