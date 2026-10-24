-- 0007: Editorial publications + checksum uniqueness + memory seed remediation
-- ----------------------------------------------------------------------------
-- Mission 07 §6 (finding 2, 5, 9): authoritative draft->target publication link.
-- Mission 07 §4 (finding 10): checksum duplicate-detection backstop.
-- Mission 07 (finding 1): correct contaminated editorial memory seed.
--
-- Append-only: 0006 (wrong seed) is left untouched; this migration fixes rows
-- already inserted by 0006 so both fresh and existing databases converge.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `editorial_publications` (
  `id` text PRIMARY KEY NOT NULL,
  `draft_id` text NOT NULL UNIQUE,
  `entity_type` text NOT NULL,
  `entity_id` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `editorial_publications_entity_unique` ON `editorial_publications` (`entity_id`);
--> statement-breakpoint
-- Finding 10: the plain checksum index could not stop a concurrent duplicate
-- upload race. Promote it to UNIQUE; first collapse any pre-existing duplicates
-- (keep the lowest rowid per checksum) so the constraint is safe to add.
DELETE FROM `knowledge_sources` WHERE `rowid` NOT IN (
  SELECT `min_rowid` FROM (
    SELECT MIN(`rowid`) AS `min_rowid` FROM `knowledge_sources` GROUP BY `checksum`
  )
);
DROP INDEX IF EXISTS `knowledge_sources_checksum_idx`;
CREATE UNIQUE INDEX IF NOT EXISTS `knowledge_sources_checksum_unique` ON `knowledge_sources` (`checksum`);
--> statement-breakpoint
-- Finding 1: fix the contaminated seed memory (GCC/compiler "builders" voice).
-- mem_001: clean Decoded positioning — remove the GCC "builders" framing and the
-- "production features" phrasing (was contaminated by compiler/toolchain voice).
UPDATE OR IGNORE `editorial_memory`
  SET `content` = 'Decoded teaches working engineers to ship better software, not consume tutorials. Every insight must lead to an action the reader can take in their codebase today.',
      `category` = 'POSITIONING'
  WHERE `id` = 'mem_001';
--> statement-breakpoint
-- mem_004: clean the audience line (was "building production systems").
UPDATE OR IGNORE `editorial_memory`
  SET `content` = 'Audience: working engineers building and operating real software. Assume deep technical knowledge but not familiarity with the specific problem space.'
  WHERE `id` = 'mem_004';
--> statement-breakpoint
-- mem_002: replace the GCC-audited compiler claim with a general evidence rule.
UPDATE OR IGNORE `editorial_memory`
  SET `content` = 'Decoded verifies every claim against the actual tools and systems in use before publication — never documentation alone.',
      `category` = 'POSITIONING'
  WHERE `id` = 'mem_002';
--> statement-breakpoint
-- mem_009: repurpose the GCC-specific compiler-internals note (was the
-- GCC_CONTEXT category) into a general editorial note.
UPDATE OR IGNORE `editorial_memory`
  SET `content` = 'When writing about a specific tool, language, or runtime, reference the real version and source files in use — not upstream documentation or memory.',
      `category` = 'EDITORIAL_NOTE'
  WHERE `id` = 'mem_009';
--> statement-breakpoint
-- Defensive: migrate any remaining GCC_CONTEXT rows (shouldn't exist after
-- the updates above) to EDITORIAL_NOTE so the enum is consistent.
UPDATE OR IGNORE `editorial_memory`
  SET `category` = 'EDITORIAL_NOTE',
      `content` = 'When writing about a specific tool, language, or runtime, reference the real version and source files in use — not upstream documentation or memory.'
  WHERE `category` = 'GCC_CONTEXT';
