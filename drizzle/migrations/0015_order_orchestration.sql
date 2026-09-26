CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`offer_id` text NOT NULL,
	`booking_id` text,
	`user_id` text,
	`request_key` text NOT NULL,
	`customer_email` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`amount_minor` integer,
	`currency` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`transition_key` text,
	`provider_checkout_id` text,
	`provider_payment_id` text,
	`paid_at` integer,
	`fulfilled_at` integer,
	`cancelled_at` integer,
	`failed_at` integer,
	`refunded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_request_key_unique` ON `orders` (`request_key`);--> statement-breakpoint
CREATE INDEX `orders_offer_idx` ON `orders` (`offer_id`);--> statement-breakpoint
CREATE INDEX `orders_booking_idx` ON `orders` (`booking_id`);--> statement-breakpoint
CREATE INDEX `orders_user_idx` ON `orders` (`user_id`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_customer_email_idx` ON `orders` (`customer_email`);--> statement-breakpoint
CREATE TABLE `order_history` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`source` text NOT NULL,
	`actor_id` text,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_history_order_idx` ON `order_history` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_history_created_idx` ON `order_history` (`created_at`);--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`callback_key` text NOT NULL,
	`source` text NOT NULL,
	`provider` text,
	`provider_event_id` text,
	`provider_checkout_id` text,
	`provider_payment_id` text,
	`state` text NOT NULL,
	`amount_minor` integer,
	`currency` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_events_callback_key_unique` ON `payment_events` (`callback_key`);--> statement-breakpoint
CREATE INDEX `payment_events_order_idx` ON `payment_events` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_events_provider_event_unique` ON `payment_events` (`provider`,`provider_event_id`);--> statement-breakpoint
CREATE TABLE `orchestration_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`effect_type` text NOT NULL,
	`provider_kind` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`depends_on_effect_id` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`claim_token` text,
	`transition_key` text,
	`lease_expires_at` integer,
	`next_attempt_at` integer,
	`provider_ref` text,
	`last_error_code` text,
	`last_error_message` text,
	`last_attempt_at` integer,
	`succeeded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orchestration_effects_idempotency_key_unique` ON `orchestration_effects` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `orchestration_effects_subject_idx` ON `orchestration_effects` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `orchestration_effects_status_idx` ON `orchestration_effects` (`status`);--> statement-breakpoint
CREATE INDEX `orchestration_effects_dependency_idx` ON `orchestration_effects` (`depends_on_effect_id`);--> statement-breakpoint
CREATE INDEX `orchestration_effects_next_attempt_idx` ON `orchestration_effects` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `orchestration_history` (
	`id` text PRIMARY KEY NOT NULL,
	`effect_id` text NOT NULL,
	`action` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`effect_id`) REFERENCES `orchestration_effects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orchestration_history_effect_idx` ON `orchestration_history` (`effect_id`);--> statement-breakpoint
CREATE INDEX `orchestration_history_created_idx` ON `orchestration_history` (`created_at`);
