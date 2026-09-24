# Changelog

## [Unreleased] — Mission 07 Final Release-Review Remediation

### Fixed
- **Publication lease ownership.** `editorial_publications.id` is now the
  publication lease token. A bounded polling timeout never steals a fresh
  NULL reservation; only a sufficiently stale, still-unbound exact lease can
  be reclaimed. Target binding and cleanup are conditional on the exact
  reservation identity.
- **Partial-publication recovery.** Once an exact target `entityId` is bound,
  transient publish/verification failures keep the ownership record so retry
  resumes the same Guide / Field Note. Stale-draft failure compensates by
  unpublishing and discarding only the exact owned target.
- **Editorial state truthfulness.** Draft content is editable only in `DRAFT`.
  `IN_REVIEW`, `APPROVED`, `REJECTED`, and `PUBLISHED` are read-only at both
  service and admin-UI layers.
- **Knowledge-ingestion serialization.** Ingestion owns an atomic CAS lease on
  `(id, status, updatedAt)`. Fresh INGESTING work cannot be stolen; stale
  crash recovery, READY finalization, failure cleanup, archive and restore are
  all conditional on exact lifecycle ownership.
- **Runtime validation.** Server actions now parse generation, update, and
  review inputs. Source filters accept the real `ks_...` ID format and draft
  body edits use the strict `llmBlockSchema` whitelist.
- **Editorial identity UX.** New-draft examples are hiring / Talent
  Acquisition-native, with a regression test covering visible admin copy.

### Tests
- Added regression coverage for fresh publication lease protection, stale
  lease recovery, exact-target retry after post-bind failure, APPROVED and
  PUBLISHED immutability, concurrent ingestion, stale ingestion recovery,
  real knowledge-source IDs, structured-block validation, and admin identity.

### Release status
- Previous green local gate results predate these remediation commits and do
  not certify the current head. Full unit, E2E, typecheck, lint, build and
  Drizzle schema-drift gates must be rerun before independent re-review and
  Ahmed's explicit merge approval.
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
- **Draft edit invalidates approval (superseded).** Remediation 02 originally
  reverted edited `APPROVED` drafts to `DRAFT`. Final release-review remediation
  replaced this with stricter DRAFT-only editing so approved/published records
  cannot diverge from their reviewed/public content.

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
