# MISSION 07 — Website Editorial-AI Pipeline

Production engineering documentation for the editorial-ai publishing pipeline
(Drafts → Guides / Field Notes) on the Decoded Hiring V2 website.

This document is the authoritative reference for the Mission 07 final remediation
state on branch `mission-07-website-editorial-ai`. Code and lifecycle descriptions
below reflect the current source tree; release gates must be rerun after the latest
remediation commits before merge approval.

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
│   ├── actions.ts       # Server Actions (generate, update, submit, approve, reject, recover, publish)
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
| `REJECTED`   | Rejected by approver. Recoverable to DRAFT.         |
| `PUBLISHED`  | Published as Guide/Field Note. **Terminal.**        |

### 2.2 Allowed Transitions

```
DRAFT     → IN_REVIEW   (submit for review)
IN_REVIEW → DRAFT       (send back for edits)
IN_REVIEW → APPROVED    (approve)
IN_REVIEW → REJECTED    (reject — recoverable)
REJECTED  → DRAFT       (recover for edits)
APPROVED  → PUBLISHED   (publish)
```

All other transitions are **rejected** with an error.
Only `PUBLISHED` is terminal; `REJECTED` is recoverable to `DRAFT` via
`recoverRejectedAction`.

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
  2. Parse UpdateDraftInput with updateDraftSchema
  3. SELECT draft WHERE id = ?
  4. Require status === DRAFT
     - IN_REVIEW / APPROVED / REJECTED / PUBLISHED are read-only
     - review-state content must explicitly return to DRAFT before editing
  5. UPDATE validated title, excerpt, meta_title, meta_desc, body, slug
     (body accepts only the strict llmBlockSchema whitelist)
  6. INSERT audit row (draft_edited)
  7. return updated draft (via getDraft)
```

The server-side DRAFT-only rule is authoritative. The admin UI mirrors it by
rendering the Edit control only for DRAFT content. This prevents an APPROVED or
PUBLISHED editorial record from drifting away from the public entity it represents.

### 4.3 Publishing (publishDraft)

```typescript
publishDraft(id, actorId)
  1. SELECT existing publication WHERE draftId = ?
  2. If the draft is already PUBLISHED and the exact target is public:
       return the existing publication idempotently
  3. Otherwise wait for the concurrent publisher to fully finish,
     whether entityId is still NULL or has already been bound
       - a bound entityId can still belong to a LIVE publisher
       - a short wait timeout is NOT proof of abandonment
       - only a publication lease older than the stale threshold
         (default 5 minutes) may enter crash recovery
       - stale bound lease → resume the exact target by entity ID
       - stale unbound lease → reclaim by exact row id + draft id
         + entityId IS NULL (CAS)
  4. Require draft.status === APPROVED
  5. INSERT editorial_publications reservation with a unique row id
       - UNIQUE(draftId) serializes concurrent publishers
       - the publication row id is the ownership / lease token
  6. CREATE target Guide / Field Note
  7. Bind target to the exact reservation with CAS:
       WHERE publication.id = reservationId
         AND draftId = ?
         AND entityId IS NULL
  8. If target binding loses:
       safely discard only the unpublished target created by this request
       and fail without publishing
  9. Publish target and verify by exact entity ID
 10. CAS draft APPROVED → PUBLISHED
 11. If draft CAS loses:
       unpublish + discard the exact owned target,
       release the exact publication reservation,
       and fail closed
 12. INSERT audit row (draft_published)
 13. return { entityType, entityId }
```

**Idempotency, concurrency and crash recovery are anchored on the publication
row id plus `entityId`, never on slug.**

- One draft → at most one publication record (`UNIQUE(draftId)`).
- One finalized target → at most one publication record (`UNIQUE(entityId)`).
- A fresh publication lease is treated as live even if another request's
  bounded poll expires, whether or not an `entityId` has already been bound.
- Crash recovery starts only after the lease is sufficiently old. A stale
  unbound lease may be reclaimed by exact identity; a stale bound lease resumes
  the exact target by ID.
- Once a target `entityId` is bound to a reservation, transient failures keep
  that ownership record. A later stale-recovery retry resumes that exact target
  rather than creating another target or relying on slug.
- An unrelated Guide / Field Note sharing the slug can never be claimed as the
  draft's publication.
- The editorial draft is marked PUBLISHED only after the exact target is
  verified public.

### 4.4 Knowledge ingestion concurrency

Knowledge ingestion uses the same ownership principle at the source-state level:

```text
UPLOADED / READY / FAILED
       ↓ CAS on (id, status, updatedAt)
   INGESTING lease
       ↓
replace chunks + FTS rows
       ↓ CAS on exact INGESTING updatedAt lease
      READY
```

Rules:

- A fresh `INGESTING` source cannot be ingested again or archived.
- A crashed `INGESTING` lease can be reclaimed only after the stale threshold
  and only by CAS against the exact `updatedAt` version that was read.
- Failure cleanup deletes chunks and marks FAILED only when the caller still
  owns that exact INGESTING lease.
- Archive and restore also use CAS against status + `updatedAt`, preventing
  lifecycle operations from overwriting a concurrently-started ingestion.

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
  ('mem_001', 'POSITIONING', 'Decoded teaches hiring leaders to build signal, not noise. Every insight must lead to an action the reader can take in their hiring process today.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_002', 'POSITIONING', 'Decoded verifies every claim against real hiring situations and recruitment practice before publication — never documentation alone.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_003', 'VOICE', 'Write like a senior recruiter who has run the process they''re describing — confident, precise, never salesy. Assume deep domain knowledge; cite evidence by name.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_004', 'AUDIENCE', 'Audience: working recruiters and talent leaders operating real hiring processes. Assume deep domain knowledge but not familiarity with the specific problem space.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_005', 'METHODOLOGY', 'Aha Authority format: lead with an unexpected insight, ground every claim in evidence, then provide a concrete next step. Never lead with context-setting.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_006', 'EDITORIAL_RULE', 'Never embed raw Markdown, HTML, or code blocks in output — only structured content blocks (headings, paragraphs, blockquotes, callouts, lists).', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_007', 'AVOID', 'Avoid: ''in today''s tutorial'', ''let''s build together'', filler phrases, promises about future content, and any instruction to ''imagine'' or ''pretend''.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_008', 'AVOID', 'Never reproduce full source material verbatim — summarize, paraphrase, and cite by name.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_009', 'EDITORIAL_NOTE', 'When writing about a specific hiring tool, assessment method, or market signal, reference the real version and data in use — not upstream documentation or memory.', 1, 'system', strftime('%s','now'), strftime('%s','now')),
  ('mem_010', 'EDITORIAL_RULE', 'Callout blocks with tone ''evidence'' must cite the source title in the label field. Blockquote blocks are for direct paraphrase attribution.', 1, 'system', strftime('%s','now'), strftime('%s','now'));

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
|| Memory seeds contamination | Seeds contained GCC/compiler/production-system terms AND residual "working engineers"/"codebase"/"senior engineer" contamination | Seeds rewritten with clean Decoded Hiring positioning/voice/methodology (0007 removed GCC/builder terms; 0009 corrected residual contamination) |

### migration 0008 — Identity correction: author defaults

```sql
-- Correct Decoded Hiring identity contamination in default author columns.
-- "Ahmed Awad" is a personal name that leaked into production schema defaults;
-- the canonical platform identity is "Decoded Editorial" (see DEFAULT_PUBLISH_AUTHOR
-- in drafts/service.ts). This migration:
--   1. Recreates the guides and field_notes tables with the corrected DEFAULT.
--   2. Preserves existing `author` values verbatim via INSERT ... SELECT
--      (legitimate Ahmed-authored content keeps "Ahmed Awad"); only the
--      column DEFAULT is corrected for new rows. No blanket author rewrite.
```

(Generated by `drizzle-kit generate`; contains table-recreation with the
corrected DEFAULT and an author-preserving INSERT ... SELECT — no backfill UPDATE.)

### migration 0009 — Memory identity correction (residual contamination)

Migration 0007 removed GCC/builder/production-system terms from memory
seeds but left residual platform-contamination: "working engineers",
"codebase", "senior engineer". Migration 0009 corrects the remaining
`editorial_memory` rows to the clean Decoded Hiring identity (recruiters,
hiring leaders, talent acquisition) matching the `SEEDED_MEMORY` constant
in `memory/types.ts`.

```sql
UPDATE editorial_memory
  SET content = 'Write like a senior recruiter who has run the process
                 they''re describing — confident, precise, never salesy.
                 Assume deep domain knowledge; cite evidence by name.'
WHERE id = 'mem_003';

UPDATE editorial_memory
  SET content = 'Audience: working recruiters and talent leaders operating
                 real hiring processes. Assume deep domain knowledge but not
                 familiarity with the specific problem space.'
WHERE id = 'mem_004';

UPDATE editorial_memory
  SET content = 'When writing about a specific hiring tool, assessment
                 method, or market signal, reference the real version and
                 data in use — not upstream documentation or memory.'
WHERE id = 'mem_009';
```

---

## 6. Identity & Ownership Guarantees

### 6.1 Platform Identity Isolation

The editorial-ai pipeline must never leak software-platform identity (compiler
references, builder terminology, production-infra terms) into generated content.

**Forbidden terms** (enforced in tests):

```
builders, gcc, compiler, "production features", "production systems",
"learning platform", "engineers", "ship better software", "codebase",
"senior engineer", "tutorials", "working engineers", "recruitment platform"
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
| `generateDraft` | `requireAdmin()` + `generateDraftSchema.parse()`; `createdBy` set to `session.user.id` on INSERT |
| `updateDraft` | `requireAdmin()` + `updateDraftSchema.parse()`; server enforces DRAFT-only editing |
| `submitForReview` | `requireAdmin()` — auth check; CAS on status |
| `sendBack` | `requireAdmin()` — auth check; CAS on status |
| `approve` | `requireAdmin()` — auth check; CAS on status |
| `rejectDraft` | `requireAdmin()` — auth check; CAS on status |
| `recoverRejected` | `requireAdmin()` — auth check; CAS on status |
| `publishDraft` | `requireAdmin()` — auth check; `UNIQUE(draftId)` serializes publishes |

### 6.3 Publication Uniqueness

| Constraint | Enforced by |
|---|---|
| One publication record per draft | `UNIQUE(draftId)` on `editorial_publications` |
| One finalized target per publication | `UNIQUE(entityId)` on `editorial_publications` |
| One guide/field-note per slug | `UNIQUE(slug)` on `guides` / `field_notes` |

A second publish attempt against the same draft finds the existing record
and either finalizes the exact owned target (idempotent/crash recovery) or
waits for the concurrent publisher to fully finish. A bounded wait timeout by
itself never deletes a reservation. Reclamation is permitted only for a
sufficiently old, still-unbound reservation and only through an exact
reservation-identity CAS. Once an `entityId` is bound, the record is retained
through transient failures so a retry resumes the same target. An unrelated
Guide/Field Note with the same slug can never be claimed.

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
| Reject → REJECTED | Recoverable: "Recover to DRAFT" button appears, no Publish button |
| Recover → DRAFT | Status badge returns to DRAFT, Submit for Review button appears |
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

The earlier Mission 07 implementation passed its local gates before the final
release-review remediation. Those results **do not certify the current head**
because publication, ingestion, validation, UI lifecycle and regression tests
have changed since then.

Before Ahmed gives merge approval, rerun all gates against the final branch head:

| Gate | Command | Current post-remediation status |
|------|---------|---------------------------------|
| Unit + integration tests | `npm test` | **MUST RERUN** |
| E2E suite | `npm run test:e2e` | **MUST RERUN** |
| TypeScript | `npm run typecheck` | **MUST RERUN** |
| Lint | `npm run lint` | **MUST RERUN** |
| Production build | `npm run build` | **MUST RERUN** |
| Drizzle schema drift | `npm run db:generate` | **MUST RERUN; expect no unintended migration** |

Release remains blocked until these gates are green and an independent
`dh-release-review` re-review confirms the six final-review blockers are closed.

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
