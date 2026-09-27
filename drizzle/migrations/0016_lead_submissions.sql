CREATE TABLE `lead_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'NEW' NOT NULL,
	`full_name` text NOT NULL,
	`email` text NOT NULL,
	`position_title` text,
	`company_name` text,
	`country_code` text NOT NULL,
	`phone_e164` text,
	`problem_summary` text,
	`desired_outcome` text,
	`timing` text,
	`team_size` integer,
	`delivery_preference` text,
	`ai_use_level` text,
	`workflow_to_improve` text,
	`source_route` text NOT NULL,
	`audience_path` text,
	`privacy_acknowledged` integer NOT NULL,
	`research_accepted` integer DEFAULT false NOT NULL,
	`email_marketing` integer DEFAULT false NOT NULL,
	`whatsapp` integer DEFAULT false NOT NULL,
	`calls` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_submissions_idempotency_key_unique` ON `lead_submissions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `lead_submissions_kind_created_idx` ON `lead_submissions` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `lead_submissions_email_created_idx` ON `lead_submissions` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `lead_submissions_status_idx` ON `lead_submissions` (`status`);
