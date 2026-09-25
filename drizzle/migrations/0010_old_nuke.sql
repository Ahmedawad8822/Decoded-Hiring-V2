CREATE TABLE `booking_availability_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_type_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`start_minute` integer NOT NULL,
	`end_minute` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`booking_type_id`) REFERENCES `booking_types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_booking_windows_type` ON `booking_availability_windows` (`booking_type_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_booking_windows_unique` ON `booking_availability_windows` (`booking_type_id`,`weekday`,`start_minute`,`end_minute`);--> statement-breakpoint
CREATE TABLE `booking_types` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`duration_minutes` integer NOT NULL,
	`buffer_before_minutes` integer DEFAULT 0 NOT NULL,
	`buffer_after_minutes` integer DEFAULT 0 NOT NULL,
	`minimum_notice_minutes` integer DEFAULT 0 NOT NULL,
	`booking_horizon_days` integer NOT NULL,
	`timezone` text NOT NULL,
	`confirmation_policy` text DEFAULT 'AUTO_CONFIRM' NOT NULL,
	`access_mode` text DEFAULT 'FREE' NOT NULL,
	`meeting_method` text DEFAULT 'TO_BE_CONFIRMED' NOT NULL,
	`attendee_limit` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_types_slug_unique` ON `booking_types` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_booking_types_active` ON `booking_types` (`active`);--> statement-breakpoint
CREATE TABLE `slot_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_type_id` text NOT NULL,
	`slot_key` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`owner_token` text NOT NULL,
	`status` text DEFAULT 'HELD' NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`released_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`booking_type_id`) REFERENCES `booking_types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slot_holds_slot_key_unique` ON `slot_holds` (`slot_key`);--> statement-breakpoint
CREATE INDEX `idx_slot_holds_booking_type` ON `slot_holds` (`booking_type_id`);--> statement-breakpoint
CREATE INDEX `idx_slot_holds_expires_at` ON `slot_holds` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_slot_holds_owner` ON `slot_holds` (`owner_token`);