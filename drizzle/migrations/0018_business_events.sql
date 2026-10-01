-- Mission 08.8 — provider-neutral business-event observability ledger.
-- This table is analytics/observability projection only. Business truth remains
-- in bookings/order/payment/orchestration tables and can reconstruct these rows.
CREATE TABLE `business_events` (
  `id` text PRIMARY KEY NOT NULL,
  `dedupe_key` text NOT NULL,
  `event_name` text NOT NULL,
  `subject_type` text,
  `subject_id` text,
  `offer_id` text,
  `booking_type_id` text,
  `booking_id` text,
  `order_id` text,
  `route` text,
  `surface` text,
  `metadata` text NOT NULL DEFAULT '{}',
  `occurred_at` integer NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_events_dedupe_unique`
ON `business_events` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `business_events_name_occurred_idx`
ON `business_events` (`event_name`, `occurred_at`);
--> statement-breakpoint
CREATE INDEX `business_events_booking_idx`
ON `business_events` (`booking_id`);
--> statement-breakpoint
CREATE INDEX `business_events_order_idx`
ON `business_events` (`order_id`);
--> statement-breakpoint
CREATE INDEX `business_events_offer_idx`
ON `business_events` (`offer_id`);

--> statement-breakpoint
CREATE INDEX `booking_history_action_created_idx`
ON `booking_history` (`action`, `created_at`);
--> statement-breakpoint
CREATE INDEX `order_history_status_created_idx`
ON `order_history` (`to_status`, `created_at`);
