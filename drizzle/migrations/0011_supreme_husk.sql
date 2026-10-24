-- ============================================================================
-- Add acquisition_key column to slot_holds (Mission 08.1 remediation §1)
-- ----------------------------------------------------------------------------
-- acquisition_key is the server-issued idempotency identity for a logical
-- booking attempt. It is SEPARATE from ownerToken (which is the authoritative
-- lease identity and is always server-generated).
--
-- INVARIANTS:
--   - Same acquisition_key + same slot_key + HELD + unexpired → returns the
--     existing lease idempotently (same ownerToken, NO TTL extension).
--   - Different acquisition_key → TAKEN (no token leak).
--   - CONSUMED remains terminal even for the same acquisition_key.
--   - Legacy holds created before this migration have NULL acquisition_key;
--     they are treated as unique logical attempts (different key on every
--     future acquire), preserving backward compatibility.
--
-- Column is nullable so existing rows are not broken by the migration.
-- ============================================================================

--> statement-breakpoint
ALTER TABLE `slot_holds` ADD COLUMN `acquisition_key` text;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_slot_holds_acquisition_key` ON `slot_holds` (`acquisition_key`);
