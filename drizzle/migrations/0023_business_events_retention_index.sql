-- Serves bounded retention pruning of business_events (ordered range scan on
-- occurred_at; the existing (event_name, occurred_at) index cannot be used
-- without an event_name predicate).
--
-- drizzle-kit also emitted CREATE TABLE business_events and the other indexes
-- created by hand-written migration 0018, because 0018 had no snapshot. Those
-- statements are intentionally removed: the table and indexes already exist.
-- The 0023 snapshot records the full, matching state so the next generate is
-- a no-op.
CREATE INDEX `business_events_occurred_idx` ON `business_events` (`occurred_at`);
