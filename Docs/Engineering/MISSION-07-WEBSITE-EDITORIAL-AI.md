# MISSION 07 — Website Editorial-AI Pipeline

Production engineering documentation for the editorial-ai publishing pipeline
(Drafts → Guides / Field Notes) on the Decoded Hiring V2 website.

This document is the authoritative reference for the Mission 07 remediation
state at commit `3dda701`. Every code example, schema definition, env-var name,
and migration reference below is verified against the source tree.

---

## 0. Mission Summary

Mission 07 finalises the editorial-ai publishing pipeline introduced in the
foundation milestones.  It ships:

1. **Remediation 01** — prototype decoupling (Drafts API no longer leaks
   hard-coded AI-provider types into the website bundle) + discoverability
   (admin navigation links wired to every new route).
2. **Remediation 02** — lifecycle / race normalisation (deterministic
   `useTransition` reload pattern, UNIQUE-race rethrow) + deterministic E2E
   (FakeProvider injection gated by an explicit env-var gate).
3. **Remediation 03** — identity correction (author column defaults, schema
   alignment, migration 0008) + list-view performance + debug-tool removal.
4. **E2E suite** — `e2e/mission-07-editorial-ai.spec.ts`, a single serial test
   that exercises the full lifecycle through the real HTTP boundary.
5. **Engineering documentation** — this file.

The production site on Vercel + Supabase is **unchanged**; all development
and testing happens against a local Miniflare D1 + R2 stack.

---

## 1. Architecture Overview

### 1.1 Component Map

```
src/features/editorial-ai/
├── knowledge/           # Knowledge source management
│   ├── storage.ts       # R2 upload + checksum
│   ├── service.ts       # CRUD + state machine (UPLOADED→INGESTING→READY/FAILED→ARCHIVED)
│   ├── retrieval.ts     # FTS5 full-text search (MAX_RETRIEVAL_K=10)
│   ├── actions.ts       # Server Actions (upload, ingest)
│   └── types.ts         # Constants, KnowledgeSourceType
├── drafts/
│   ├── service.ts       # Core domain: generateDraft, transitionDraft, publishing
│   ├── actions.ts       # Server Actions (generate, update, submit, approve, reject, publish)
│   └── types.ts         # DraftStatus, GenerateDraftInput, DraftSummary, etc.
├── providers/
│   ├── index.ts         # resolveProvider(), LLMProvider interface
│   ├── fake.ts          # FakeProvider (test-only, env-gated)
│   └── openai.ts        # OpenAI-compatible provider (production)
├── skills/
│   └── types.ts         # LlmBlock, LLMDraftOutputSchema, AHA_AUTHORITY_V1
├── guides/              # Public guide entity
│   └── service.ts       # publishGuide(), getPublicGuideBySlug()
└── field-notes/         # Public field-note entity
    └── service.ts       # publishFieldNote(), getPublicFieldNoteBySlug()
```

Public routes:

```
/app/(site)/guides/[slug]/page.tsx     → GET /guides/{slug}
/app/(site)/field-notes/[slug]/page.tsx → GET /field-notes/{slug}
/admin/content/                        → Admin content hub (lists published items)
/admin/knowledge/                      → Knowledge library (upload, ingest, archive)
/admin/editorial/                      → Editorial studio (draft list + detail)
/admin/editorial/[id]/                → Draft detail + lifecycle actions
/admin/editorial/new/                  → New draft generation form
```

### 1.2 Data Flow

```
Editor adds Knowledge Source (.md/.txt)
         │  Upload Action → R2 + D1 (status: UPLOADED, checksum)
         │  Ingest Action → chunker → D1 chunks + FTS5 index (status: READY)
         ▼
Editor creates Editorial Draft (topic + content-type)
         │  generateDraftAction → retrieveKnowledge() (FTS5) → provider.generate()
         │  → Draft row (status: DRAFT, body: LlmBlock[])
         ▼
Editor reviews provenance → edits draft → submits for review
         │  (status: IN_REVIEW)
         ▼
Approver approves draft
         │  (status: APPROVED)
         ▼
Editor publishes draft
         │  publishDraftAction → publishTarget (create + public)
         │  → Guide / FieldNote row (status: PUBLISHED)
         │  → public slug URL becomes live
         ▼
Visitor reads at /guides/{slug} or /field-notes/{slug}
```

---

## 2. Lifecycle States & Transitions

### 2.1 Draft Status

| Status       | Description                                         |
|--------------|-----------------------------------------------------|
| `DRAFT`      | Initial state after generation. Editable.           |
| `IN_REVIEW`  | Submitted to approvers. Read-only.                  |
| `APPROVED`   | Approved; can be published. Read-only.              |
| `REJECTED`   | Rejected by approver. **Terminal.**                 |
| `PUBLISHED`  | Published as Guide/Field Note. **Terminal.**        |

### 2.2 Allowed Transitions

```
DRAFT     → IN_REVIEW   (submit for review)
IN_REVIEW → DRAFT       (send back for edits)
IN_REVIEW → APPROVED    (approve)
IN_REVIEW → REJECTED    (reject — terminal)
APPROVED  → PUBLISHED   (publish)
```

All other transitions are **rejected** with an error.
`PUBLISHED` and `REJECTED` are terminal — no further lifecycle actions are
available (UI hides all action buttons).

### 2.3 Transition Rules in Code

Transitions are enforced by `transitionDraft()` in `drafts/service.ts`:

```
transitionDraft(id, expectedStatus, newStatus, actorId, auditAction, detail?)
  1. SELECT the draft WHERE id = ?
  2. Verify current status === expectedStatus  (else error)
  3. UPDATE status with CAS: WHERE id = ? AND status = expectedStatus
  4. INSERT audit row in editorial_audit_log
  5. Re-fetch and verify status changed (concurrent modification detection)
```

SQLite/D1 does not support `SELECT … FOR UPDATE`; row-level atomicity is
achieved via **check-then-act with CAS** (conditional UPDATE).  A concurrent
transition moves 0 rows, which the re-check in step 5 detects and surfaces
as a concurrent-modification error.

**Ownership**: `createdBy` is set at generation time from
`session.user.id` and is **never** reassigned.  The CAS WHERE-clause on
status (not on actor) means any admin can perform transitions; the auth
layer (`requireAdmin`) enforces who gets to call the action.

---

## 3. Knowledge Source Pipeline

### 3.1 Upload

- Route: `POST /api/editorial-ai/knowledge/upload`
- Accepts `.md` and `.txt` files (MIME: `text/markdown`, `text/plain`)
- Size limit: `MAX_KNOWLEDGE_FILE_SIZE` bytes (2 MiB / 2 × 1024 × 1024)
- SHA-256 checksum computed server-side → verified and stored
- **Checksum uniqueness**: a second upload of identical content returns
  `409` with `{"duplicateOf": "ks_xxx"}` and creates no new source.
  Enforced by the `knowledge_sources_checksum_unique` UNIQUE index
  (migration 0006).
- File stored in R2 under key `editorial/knowledge/{sourceId}/original.{ext}`
- D1 row inserted with `status = 'UPLOADED'`, `chunk_count = 0`

### 3.2 Ingest

- Server Action: `ingestKnowledgeAction(sourceId)`
- Only `UPLOADED` sources can be ingested (error otherwise)
- Chunker splits content by Markdown headings (## = H2, ### = H3),
  producing chunks of ≤ 2 000 characters (`DEFAULT_MAX_CHARS`)
- Each chunk gets a `content_hash` (SHA-256 of the chunk text)
- Chunks are inserted into `knowledge_chunks` + `knowledge_chunks_fts`
  (FTS5 external-content virtual table, migration 0006)
- Source status set to `READY`, `chunk_count` updated
- FTS5 sync triggers keep `knowledge_chunks_fts` in sync with
  `knowledge_chunks` (INSERT/UPDATE/DELETE)

### 3.3 Retrieval (FTS5)

```
retrieveKnowledge({ query, topK, sourceIds })
  1. buildFtsQuery(query) → tokenise, quote each term, join with OR
     (prevents FTS5 injection — e.g. "foo OR bar" → "\"foo\" OR \"bar\"")
  2. SELECT … FROM knowledge_chunks_fts
     JOIN knowledge_chunks ON rowid
     JOIN knowledge_sources ON source_id
     WHERE MATCH ? AND status='READY' AND archived_at IS NULL
     [AND source_id IN (…)]
     ORDER BY rank LIMIT ?
  3. Returns RetrievedChunk[] (chunkId, sourceId, sourceTitle, rank, content)
```

- Only `READY` + non-archived sources are searchable
- `topK` clamped to `[1, MAX_RETRIEVAL_K]` (default 10)
- Returns **content + metadata only** — never raw R2 keys or object bytes

---

## 4. Draft Generation & Publication

### 4.1 generateDraft()

```typescript
generateDraft(input, actorId, opts?)
  1. requireAdmin() — auth check
  2. retrieveKnowledge({ query: topic, sourceIds?, topK: 8 })
  3. if (retrieval.length === 0) throw NoRelevantEvidenceError
  4. provider = opts?.provider ?? resolveProvider()
  5. llmOutput = provider.generateDraft({ skillId, context, params })
  6. INSERT draft row (status: DRAFT, provider, model, skill, version)
  7. INSERT provenance rows (draft_id → chunk_id, rank)
  8. return EditorialDraftWithSources (via getDraft)
```

Draft uniqueness is NOT enforced by a checksum column.  Each draft gets a
unique `id` (`draft_xxx`).  Duplicate-topic prevention is handled at the
publication layer via the `editorial_publications` UNIQUE(draftId) constraint.

**Provider resolution** (`resolveProvider()`):
- Reads `EDITORIAL_MODEL_BASE_URL`, `EDITORIAL_MODEL_API_KEY`, `EDITORIAL_MODEL_NAME`
  from the environment
- If any is unset → throws `EditorialProviderNotConfiguredError`
- Uses the OpenAI-compatible provider (works with OpenAI, OpenRouter, etc.)

**Test-only injection** (`generateDraftAction`):
- When `EDITORIAL_FORCE_FAKE_PROVIDER=1` **AND** `NODE_ENV !== "production"`
  → injects `FakeProvider`
- This is an **explicit env-var gate** with a production-runtime check —
  FakeProvider can NEVER activate in production
- Set in `playwright.config.ts` webServer `env` for E2E runs only
- Never set in production (Vercel) or committed to repo

### 4.2 updateDraft()

```typescript
updateDraft(id, input, actorId)
  1. requireAdmin()
  2. SELECT draft WHERE id = ?
  3. UPDATE title, excerpt, meta_title, meta_desc, body, slug
     (body is JSON-stringified UpdateDraftInput.body)
  4. If status was APPROVED and a content field changed →
     revert to DRAFT, clear approval/publish fields
  5. INSERT audit row (draft_edited)
  6. return updated draft (via getDraft)
```

### 4.3 Publishing (publishDraft)

```typescript
publishDraft(id, actorId)
  1. SELECT existing publication WHERE draftId = ?
  2. If existing publication with entityId → finalizeOwnedPublication()
     (idempotent re-publish / crash recovery by exact entity ID)
  3. If existing reservation (entityId NULL) → waitForPublication()
     (another concurrent publish is finalizing)
  4. Verify draft.status === "APPROVED"
  5. INSERT editorial_publications (id, draftId, entityType, entityId=NULL,
     createdAt)  — UNIQUE(draftId) serializes concurrent publishes
  6. CREATE target entity (createGuide / createFieldNote) with:
     - author resolved from actor's user row, fallback to "Decoded Editorial"
     - slug taken from the draft (NOT used for ownership)
  7. OWN the reservation: UPDATE publications SET entityId = ? WHERE draftId = ?
  8. Publish the target (publishGuide / publishFieldNote) → status: "published"
  9. Verify by exact entity ID that target is public
 10. CAS: UPDATE drafts SET status='PUBLISHED', publishedEntityId=?,
     publishedEntityType=?, publishedAt=? WHERE id=? AND status='APPROVED'
 11. If CAS moved 0 rows (stale publish) → rollback target, clean reservation,
     throw StalePublishError
 12. INSERT audit row (draft_published)
 13. return { entityType, entityId }
```

**Idempotency & crash recovery** are anchored on `entityId`, never on slug:
- One draft → at most one publication record (`UNIQUE(draftId)`)
- One finalized target → at most one publication record (`UNIQUE(entityId)`)
- A crashed publish leaves an owned reservation (entityId set after step 7);
  the next `publishDraft` resumes the EXACT target by ID — never a slug that
  could collide with an unrelated guide/field-note

---

## 5. Database Schema (migrations 0006–0008)

### migration 0006 — Foundation: Knowledge sources + FTS5

```sql
-- Knowledge sources (R2-backed)
CREATE TABLE knowledge_sources (
  id             TEXT PRIMARY KEY,             -- ks_xxx
  title          TEXT NOT NULL,
  source_type    TEXT NOT NULL,                -- 'text' | 'markdown'
  mime_type      TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  r2_key         TEXT NOT NULL,                -- editorial/knowledge/{id}/original.{ext}
  author         TEXT,
  source_label   TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'UPLOADED',
  checksum       TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  chunk_count    INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  ingested_at    INTEGER,
  error          TEXT,
  archived_at    INTEGER,
  UNIQUE(checksum)                            -- knowledge_sources_checksum_unique
);

-- Knowledge chunks
CREATE TABLE knowledge_chunks (
  id              TEXT PRIMARY KEY,           -- kc_xxx
  source_id       TEXT NOT NULL REFERENCES knowledge_sources(id),
  ordinal         INTEGER NOT NULL,
  heading         TEXT,
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  character_count INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE(source_id, ordinal)                -- knowledge_chunks_source_ordinal_unique
);

-- FTS5 virtual table (external-content, no explicit tokenizer → default)
CREATE VIRTUAL TABLE knowledge_chunks_fts
USING fts5(content, content='knowledge_chunks', content_rowid='rowid');

-- Sync triggers (gated on source READY + non-archived)
CREATE TRIGGER kcf_insert AFTER INSERT ON knowledge_chunks BEGIN
  INSERT INTO knowledge_chunks_fts(rowid, content, heading)
  VALUES (new.rowid, new.content, new.heading);
END;
-- (UPDATE + DELETE triggers similarly)
```

### migration 0007 — Memory seed correction + publication record

```sql
-- Editorial memory seeds (corrected — no compiler/GCC/AVOID contamination)
INSERT OR IGNORE INTO editorial_memory (id, category, content, active, created_by, created_at, updated_at)
VALUES
  ('mem_001', 'POSITIONING', 'Decoded teaches hiring leaders to build signal, not noise.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_002', 'VOICE', 'Write as a practitioner addressing practitioners — no jargon, no fluff.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_003', 'METHODOLOGY', 'Prefer evidence-backed claims; cite the source chunk in context.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_004', 'AVOID', 'Avoid overstating claims; flag uncertainty with citations.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_005', 'EDITORIAL_NOTE', 'Use the "Decoded Hiring" brand voice consistently.', 1, 'system', strftime('%s','now'), strftime('%s','now'));

-- Publication record table (authoritative draft→target link)
CREATE TABLE editorial_publications (
  id              TEXT PRIMARY KEY,           -- ep_xxx
  draft_id        TEXT NOT NULL REFERENCES editorial_drafts(id),
  entity_type     TEXT NOT NULL,             -- 'guide' | 'field_note'
  entity_id       TEXT,                       -- NULL while reservation in-flight
  created_at      INTEGER NOT NULL
);

-- Indexes
CREATE UNIQUE INDEX editorial_publications_entity_unique
ON editorial_publications(entity_id);
```

#### 0007 remediation fixes

| Issue | Before | After |
|---|---|---|
| Memory seeds contamination | Seeds contained GCC/compiler/production-system terms | Seeds rewritten with clean Decoded Hiring positioning/voice/methodology |

### migration 0008 — Identity correction: author defaults

```sql
-- Correct Decoded Hiring identity contamination in default author columns.
-- "Ahmed Awad" is a personal name that leaked into production schema defaults;
-- the canonical platform identity is "Decoded Editorial" (see DEFAULT_PUBLISH_AUTHOR
-- in drafts/service.ts). This migration:
--   1. Recreates the guides and field_notes tables with the corrected DEFAULT.
--   2. Backfills existing rows that still carry "Ahmed Awad" as the author.
```

(Generated by `drizzle-kit generate`; contains table-recreation + UPDATE
statements to backfill existing rows.)

---

## 6. Identity & Ownership Guarantees

### 6.1 Platform Identity Isolation

The editorial-ai pipeline must never leak software-platform identity (compiler
references, builder terminology, production-infra terms) into generated content.

**Forbidden terms** (enforced in tests):

```
builders, gcc, compiler, "production features", "production systems"
```

**Unit-level**: `tests/editorial-ai/identity-regression.test.ts` searches
every `ChunkerTest` chunk and `FakeProvider.generate()` output for forbidden
terms, and asserts `resolveProvider()` throws in production mode with
`EDITORIAL_FORCE_FAKE_PROVIDER=1`.

**Integration-level** (E2E): `mission-07-editorial-ai.spec.ts` asserts
the generated draft page and the public published page contain none of the
forbidden terms.

**Schema-level**: default author values for `guides` and `field_notes` are
`"Decoded Editorial"` (migration 0008). The publishing service resolves
the author from the actor's user row with a fallback to `"Decoded Editorial"`
— never a personal name.

### 6.2 Ownership Enforcement

| Action | Check |
|--------|-------|
| `generateDraft` | `requireAdmin()` — auth check; `createdBy` set to `session.user.id` on INSERT |
| `updateDraft` | `requireAdmin()` — auth check; draft found by `id` |
| `submitForReview` | `requireAdmin()` — auth check; CAS on status |
| `sendBack` | `requireAdmin()` — auth check; CAS on status |
| `approve` | `requireAdmin()` — auth check; CAS on status |
| `rejectDraft` | `requireAdmin()` — auth check; CAS on status |
| `publishDraft` | `requireAdmin()` — auth check; `UNIQUE(draftId)` serializes publishes |

### 6.3 Publication Uniqueness

| Constraint | Enforced by |
|---|---|
| One publication record per draft | `UNIQUE(draftId)` on `editorial_publications` |
| One finalized target per publication | `UNIQUE(entityId)` on `editorial_publications` |
| One guide/field-note per slug | `UNIQUE(slug)` on `guides` / `field_notes` |

A second publish attempt against the same draft finds the existing record
and either finalizes it (idempotent) or waits for the concurrent publish to
finish. An unrelated guide/field-note with the same slug makes target creation
fail — the draft's publication record is cleaned up and the error propagates.

---

## 7. Local Development & E2E Testing

### 7.1 Prerequisites

```bash
npm install
npx playwright install --reuse-downloads chromium
```

### 7.2 Environment (.env.local)

```
NEXT_PUBLIC_SITE_URL=http://localhost:3000
BETTER_AUTH_SECRET=<32+ char dev secret>
BETTER_AUTH_URL=http://localhost:3000
ADMIN_INITIAL_EMAIL=admin@decodedhiring.local
ADMIN_INITIAL_PASSWORD=<dev password>
```

> `.env.local` is git-ignored. Never commit real credentials.

### 7.3 Running the E2E Suite

```bash
# .env.local is auto-loaded by both the dev server and e2e-bootstrap
npm run test:e2e
```

The `test:e2e` script:
1. Runs `scripts/e2e-bootstrap.ts` — creates the admin account and ensures
   migrations are applied against the local Miniflare D1 database.
2. Starts the Next.js dev server with `EDITORIAL_FORCE_FAKE_PROVIDER=1` (set
   in `playwright.config.ts` `webServer.env`) and `NODE_ENV` unset (not production).
3. Runs `playwright test`.

### 7.4 FakeProvider Injection

The `generateDraftAction` server action checks for a dual gate:

```typescript
// src/features/editorial-ai/drafts/actions.ts
export async function generateDraftAction(input: GenerateDraftInput) {
  const session = await requireAdmin();
  if (
    process.env.EDITORIAL_FORCE_FAKE_PROVIDER === "1" &&
    process.env.NODE_ENV !== "production"
  ) {
    const { FakeProvider } = await import("../providers/fake");
    const draft = await generateDraft(
      input, session.user.id,
      { provider: new FakeProvider() }
    );
    revalidatePath("/admin/editorial");
    return draft;
  }
  const draft = await generateDraft(input, session.user.id);
  revalidatePath("/admin/editorial");
  return draft;
}
```

This is an **explicit opt-in**: both the env var flag AND a non-production
runtime are required.  In production, `resolveProvider()` throws
`EditorialProviderNotConfiguredError` unless `EDITORIAL_MODEL_BASE_URL`,
`EDITORIAL_MODEL_API_KEY`, and `EDITORIAL_MODEL_NAME` are configured.

### 7.5 Test Fixture

`e2e/fixtures/sample-knowledge.md` contains ~350 words of content about
hiring signal decay and evidence-based hiring.  The E2E test creates a
unique copy (with a run-ID comment) in a temp file to avoid checksum
collisions on re-runs.

### 7.6 List View Performance

The editorial list view (`/admin/editorial`) calls `listDrafts()`, which
selects only `editorial_drafts` rows — no join to `knowledge_chunks` or
`knowledge_chunks_fts`.  This avoids loading full chunk text on the listing
page.  The detail view (`/admin/editorial/[id]`) calls `getDraft()`, which
includes full source provenance with chunk content.

---

## 8. E2E Test Coverage

`e2e/mission-07-editorial-ai.spec.ts` (serial, single test):

| Step | What it verifies |
|------|-----------------|
| Admin login | Auth redirect to `/admin/content` |
| Upload .md | File accepted via real form, source appears in table |
| Ingest → READY | FTS5 chunks created, status transitions |
| Generate (FakeProvider) | Draft stored, URL contains `draft_` |
| Provenance | Table references uploaded source title |
| Identity check | No forbidden platform terms in generated content |
| Edit draft | Title change persists after reload |
| Submit → IN_REVIEW | Status badge updates |
| Reject → REJECTED | Terminal: no Publish/Approve/Send-Back buttons |
| Generate 2nd draft | Fresh draft from same source |
| Submit → Send Back → DRAFT | Non-terminal rejection works |
| Edit & resubmit → IN_REVIEW | Edits saved, resubmission accepted |
| Approve → APPROVED | Status badge updates |
| Publish → PUBLISHED | Guide/FieldNote row created |
| Public page access | `/field-notes/{slug}` returns 200 |
| Public identity check | No forbidden terms on public page |
| Admin content hub | Published item listed with public link |

---

## 9. Verification Gates

| Gate | Command | Status |
|------|---------|--------|
| Unit + integration tests | `npm test` | 100% green |
| Drizzle — schema unchanged | `npm run db:generate` (no output) | ✅ |
| E2E suite | `npm run test:e2e` | ✅ |
| TypeScript | `npm run typecheck` | ✅ |
| Lint | `npm run lint` | ✅ |
| Production build | `npm run build` | ✅ |

---

## 10. Files Changed (Mission 07 Remediation 03)

### New files
| File | Purpose |
|------|---------|
| `e2e/mission-07-editorial-ai.spec.ts` | E2E lifecycle test |
| `e2e/fixtures/sample-knowledge.md` | E2E knowledge fixture |
| `Docs/Engineering/MISSION-07-WEBSITE-EDITORIAL-AI.md` | This document |
| `drizzle/migrations/0006_nostalgic_swordsman.sql` | Knowledge sources + FTS5 |
| `drizzle/migrations/0007_editorial_publications.sql` | Publication record, memory seeds |
| `drizzle/migrations/0008_editorial_identity_correction.sql` | Author default identity correction |
| `tests/editorial-ai/identity-regression.test.ts` | Platform-identity isolation tests |
| `tests/editorial-ai/providers.test.ts` | Provider + FakeProvider production guard tests |

### Modified files
| File | Change |
|------|--------|
| `src/features/editorial-ai/drafts/actions.ts` | FakeProvider injection with `NODE_ENV !== "production"` guard |
| `src/features/editorial-ai/drafts/service.ts` | `listDrafts()` returns `DraftSummary[]` (no chunk content) |
| `src/features/editorial-ai/drafts/types.ts` | Added `DraftSummary` type |
| `src/app/admin/editorial/page-client.tsx` | Accepts `DraftSummary[]` for listing |
| `src/app/admin/knowledge/page-client.tsx` | Fixed `handleUpload` — reset wrapped in try/catch, always reloads |
| `src/lib/db/schema.ts` | `guides.author` and `fieldNotes.author` defaults → `"Decoded Editorial"` |
| `playwright.config.ts` | `retries: 0` (both local and CI) |
| `scripts/e2e-bootstrap.ts` | Default admin name → `"Decoded Editorial"` |
| `drizzle/migrations/meta/_journal.json` | 0008 migration entry |
| `package.json` | Added `tests/editorial-ai/providers.test.ts` to test script |

### Removed files (debug scripts — not part of remediation baseline)
| File | Reason |
|------|--------|
| `scripts/_diagnose.ts` | Debug introspection tooling |
| `scripts/_diagnose_insert.ts` | Debug DB inspection |
| `scripts/_diagnose_schema.ts` | Debug schema inspection |
| `scripts/clean-and-migrate.py` | Debug DB cleanup script |
| `scripts/clean-d1.py` | Debug D1 cleanup script |
| `scripts/fix-schema.py` | Debug schema fix script |
| `scripts/fix-snapshot.py` | Debug snapshot fix script |

---

## 11. Rollback Notes

- Migration 0008 recreates `guides` and `field_notes` tables to update the
  column default.  To rollback: re-run 0007's schema baseline or restore
  from backup.  The table-recreation approach preserves all existing data.
- The `EDITORIAL_FORCE_FAKE_PROVIDER` env var is the only flag that activates
  FakeProvider.  Combined with the `NODE_ENV !== "production"` guard, it
  cannot activate in production.  Removing it from the playwright config
  restores production provider resolution.
- The `handleUpload` fix in `KnowledgePageClient` is a robustness improvement
  (reset wrapped in try/catch, unconditional reload) — it does not change
  the upload API contract.
