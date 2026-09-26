--> statement-breakpoint

-- Manual custom migration: enforce non-overlapping availability windows.
--
-- WHY THIS IS A CUSTOM (hand-written) MIGRATION:
--   Drizzle's SQLite dialect has no syntax for row-level BEFORE INSERT/UPDATE
--   triggers, so this invariant cannot be expressed in `src/lib/db/schema.ts`
--   (and therefore `drizzle-kit generate` will report no schema drift from it).
--   The invariant — no two windows for the same booking_type_id + weekday may
--   overlap on the local-minute timeline — is enforced by a SQLite trigger
--   rather than the declarative schema.
--
-- WHY IT IS NEEDED:
--   `checkWindowOverlap` in policy.ts is an application-level read-then-write
--   pre-check. Under concurrent writers two callers can both observe "no
--   overlap" and then both attempt to INSERT. Only the trigger closes that
--   race: writes are serialized by the DB, the first INSERT commits, and the
--   second INSERT's trigger detects the overlap and ABORTs.
--
-- ADJACENT windows remain valid: the overlap predicate uses strict inequalities
--   existing.start_minute < NEW.end_minute  AND  existing.end_minute > NEW.start_minute
--   so [09:00,10:00] and [10:00,11:00] do NOT overlap (half-open semantics).
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `booking_windows_no_overlap_insert`
BEFORE INSERT ON `booking_availability_windows`
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM `booking_availability_windows` AS `existing`
  WHERE `existing`.`booking_type_id` = NEW.`booking_type_id`
    AND `existing`.`weekday` = NEW.`weekday`
    AND `existing`.`id` IS NOT NEW.`id`
    AND `existing`.`start_minute` < NEW.`end_minute`
    AND `existing`.`end_minute` > NEW.`start_minute`
)
BEGIN
  SELECT RAISE(ABORT, 'Overlapping availability window rejected by booking_windows_no_overlap_insert');
END;

--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS `booking_windows_no_overlap_update`
BEFORE UPDATE ON `booking_availability_windows`
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM `booking_availability_windows` AS `existing`
  WHERE `existing`.`booking_type_id` = NEW.`booking_type_id`
    AND `existing`.`weekday` = NEW.`weekday`
    AND `existing`.`id` IS NOT NEW.`id`
    AND `existing`.`start_minute` < NEW.`end_minute`
    AND `existing`.`end_minute` > NEW.`start_minute`
)
BEGIN
  SELECT RAISE(ABORT, 'Overlapping availability window rejected by booking_windows_no_overlap_update');
END;

--> statement-breakpoint
