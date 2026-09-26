CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_type_id` text NOT NULL,
	`hold_id` text NOT NULL,
	`hold_acquisition_key` text NOT NULL,
	`request_key` text NOT NULL,
	`requester_name` text NOT NULL,
	`requester_email` text NOT NULL,
	`requester_phone` text,
	`notes` text,
	`slot_key` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`timezone` text NOT NULL,
	`status` text DEFAULT 'REQUESTED' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`transition_key` text,
	`approved_by` text,
	`approved_at` integer,
	`confirmed_at` integer,
	`completed_at` integer,
	`cancelled_by` text,
	`cancelled_at` integer,
	`declined_by` text,
	`declined_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`booking_type_id`) REFERENCES `booking_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hold_id`) REFERENCES `slot_holds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_request_key_unique` ON `bookings` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_hold_generation_unique` ON `bookings` (`hold_id`,`hold_acquisition_key`);--> statement-breakpoint
CREATE INDEX `bookings_booking_type_idx` ON `bookings` (`booking_type_id`);--> statement-breakpoint
CREATE INDEX `bookings_status_idx` ON `bookings` (`status`);--> statement-breakpoint
CREATE INDEX `bookings_start_at_idx` ON `bookings` (`start_at`);--> statement-breakpoint
CREATE INDEX `bookings_requester_email_idx` ON `bookings` (`requester_email`);--> statement-breakpoint
CREATE TABLE `booking_history` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`action` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor_id` text,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `booking_history_booking_idx` ON `booking_history` (`booking_id`);--> statement-breakpoint
CREATE INDEX `booking_history_created_at_idx` ON `booking_history` (`created_at`);
