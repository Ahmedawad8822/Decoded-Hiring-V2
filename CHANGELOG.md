# Changelog

## [Unreleased] — Remediation 02 (Release Review)

### Fixed
- **Publishing ownership by entityId (Mission 07 §2).** `publishDraft` now
  anchors the draft→target relationship on the target's `entityId` (written to
  the `editorial_publications` reservation immediately after target creation)
  instead of the draft's slug. `verifyTargetPublic` and crash recovery now look
  up the target by exact ID. This means a crash resumes the *exact* target by ID,
  so an unrelated guide/field-note that happens to share the draft's slug can
  never be silently relinked. Added a regression test covering the slug-collision
  case.
- **`SQLITE_BUSY_RECOVERY` during `next build` (Mission 07 §3).** Auth-gated
  Studio admin pages are no longer prerendered at build time. `dynamic =
  "force-dynamic"` on `src/app/admin/layout.tsx` (plus the editorial/knowledge
  index pages) means the 9 prerender workers never spin up concurrent Miniflare
  instances against the shared local D1 SQLite file. All `/admin/*` routes now
  render as `Dynamic` (server-rendered on demand).
- **Stale concurrent state transitions (Mission 07 §6).** `approve`,
  `rejectDraft`, and `transitionDraft` now use compare-and-set
  (`WHERE status = expectedStatus`) with a post-update verification, so a
  concurrent state change can no longer silently overwrite another.
- **Draft edit invalidates approval (Mission 07 §6).** Editing an `APPROVED`
  draft's content reverts it to `DRAFT` and clears the approval/published fields
  so the change re-enters review.

### Security
- **Editorial identity contamination (Mission 07 §1).** Removed the prototype
  "builders" / GCC-compiler voice / "production features" & "production systems"
  phrasing from `AHA_AUTHORITY_V1`, `SEEDED_MEMORY` (mem_001, mem_004), the fake
  provider output, and the 0006/0007 migration seeds. Added the pure
  `identity-regression.test.ts` guard to prevent regression.

### Changed
- **Checksum duplicate detection now reflects the global UNIQUE index
  (Mission 07 §9, Option A).** `uploadKnowledgeSource` enforces checksum
  uniqueness across *all* statuses (archived sources keep their checksum busy;
  only deletion frees it). The 0007 migration's global `UNIQUE(checksum)` index
  is retained as the authoritative backstop. Added lifecycle tests:
  archive-blocks-reupload, deletion-frees-checksum, and concurrent lost-race.

### Migration
- `0007_editorial_publications.sql` seed text normalized to the clean editorial
  identity (mem_001, mem_004). The `knowledge_sources_checksum_unique` index
  remains global; `drizzle-kit generate` reports no schema drift (§13 baseline).
