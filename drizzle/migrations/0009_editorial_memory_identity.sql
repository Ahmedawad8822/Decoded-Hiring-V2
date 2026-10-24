-- 0009: Correct Editorial Memory Identity Contamination (Mission 07 §3 FINAL)
-- ----------------------------------------------------------------------------
-- Migration 0007 removed the OBVIOUS contamination (GCC/compiler/builders/
-- production-features language) but replaced it with subtle software-engineering
-- framing that still describes Decoded Hiring as a "learning platform that
-- helps engineers ship better software" rather than as a talent-acquisition
-- platform for recruiters and hiring leaders.
--
-- This migration corrects all editorial_memory rows to the clean Decoded
-- Hiring identity that matches the actual website (about page, homepage,
-- guides) and the SEEDED_MEMORY constant in memory/types.ts.
--
-- Append-only: uses UPDATE (idempotent). Safe to re-run.
-- ----------------------------------------------------------------------------

--> statement-breakpoint
-- mem_001: Positioning — correct "engineers / ship software / codebase"
--          to hiring-leader / hiring-process framing.
UPDATE OR IGNORE `editorial_memory`
  SET `content` = 'Decoded teaches hiring leaders to build signal, not noise. Every insight must lead to an action the reader can take in their hiring process today.',
      `category` = 'POSITIONING'
  WHERE `id` = 'mem_001';

--> statement-breakpoint
-- mem_002: Positioning — correct "tools and systems" to hiring-situation framing.
UPDATE OR IGNORE `editorial_memory`
  SET `content` = 'Decoded verifies every claim against real hiring situations and recruitment practice before publication — never documentation alone.',
      `category` = 'POSITIONING'
  WHERE `id` = 'mem_002';

--> statement-breakpoint
-- mem_003: Voice — correct "senior engineer who has shipped" to "senior
--          recruiter who has run the process".
UPDATE OR IGNORE `editorial_memory`
  SET `content` = 'Write like a senior recruiter who has run the process they are describing — confident, precise, never salesy. Assume deep domain knowledge; cite evidence by name.',
      `category` = 'VOICE'
  WHERE `id` = 'mem_003';

--> statement-breakpoint
-- mem_004: Audience — correct "working engineers building and operating real
--          software" to "working recruiters and talent leaders operating real
--          hiring processes".
UPDATE OR IGNORE `editorial_memory`
  SET `content` = 'Audience: working recruiters and talent leaders operating real hiring processes. Assume deep domain knowledge but not familiarity with the specific problem space.',
      `category` = 'AUDIENCE'
  WHERE `id` = 'mem_004';

--> statement-breakpoint
-- mem_009: Editorial note — correct "tool, language, or runtime / source
--          files" to hiring-tool / assessment-method / market-signal / data.
UPDATE OR IGNORE `editorial_memory`
  SET `content` = 'When writing about a specific hiring tool, assessment method, or market signal, reference the real version and data in use — not upstream documentation or memory.',
      `category` = 'EDITORIAL_NOTE'
  WHERE `id` = 'mem_009';
