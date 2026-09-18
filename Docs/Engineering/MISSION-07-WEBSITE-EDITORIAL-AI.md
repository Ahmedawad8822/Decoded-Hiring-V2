# MISSION 07 — Website Editorial-AI Pipeline

Production engineering documentation for the editorial-ai publishing pipeline
(Drafts → Guides / Field Notes) on the Decoded Hiring V2 website.

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
3. **E2E suite** — `e2e/mission-07-editorial-ai.spec.ts`, a single serial test
   that exercises the full lifecycle through the real HTTP boundary.
4. **Engineering documentation** — this file.

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
│   └── types.ts         # Zod schemas, KnowledgeStatus, MAX_KNOWLEDGE_FILE_SIZE
├── drafts/
│   ├── service.ts       # Core domain: generateDraft, transitionDraft, publishing
│   ├── actions.ts       # Server Actions (generate, update, submit, approve, reject, publish)
│   └── types.ts         # DraftStatus, GenerateDraftInput, UpdateDraftInput, etc.
├── providers/
│   ├── index.ts         # resolveProvider(), LLMProvider interface
│   ├── fake.ts          # FakeProvider (test-only, env-gated)
│   └── openai.ts        # OpenAI provider (production)
├── skills/
│   └── types.ts         # LlmBlock (heading, paragraph, blockquote, callout, list)
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
```

### 1.2 Data Flow

```
Editor adds Knowledge Source (.md/.txt)
         │  Upload Action → R2 + D1 (status: UPLOADED, checksum)
         │  Ingest Action → chunker → D1 chunks + FTS5 index (status: READY)
         ▼
Editor creates Editorial Draft (topic + content-type)
         │  generateDraft() → retrieveKnowledge() (FTS5) → provider.generate()
         │  → Draft row (status: DRAFT, body: LlmBlock[])
         ▼
Editor reviews provenance → edits draft → submits for review
         │  (status: IN_REVIEW)
         ▼
Approver approves draft
         │  (status: APPROVED)
         ▼
Editor publishes draft
         │  publishDraft() → publishGuide() / publishFieldNote()
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
| `APPROVED`   | Approved; can be published. Read-only.                |
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

All other transitions are **rejected** with `DraftTransitionError`.
`PUBLISHED` and `REJECTED` are terminal — no further lifecycle actions are
available (UI hides all action buttons).

### 2.3 Transition Rules in Code

Transitions are enforced by `transitionDraft()` in `drafts/service.ts`:

```
transitionDraft(id, expectedStatus, newStatus, actorId, note?)
  1. SELECT the draft (lock via `FOR UPDATE`)
  2. Verify current status === expectedStatus  (else DraftTransitionError)
  3. Verify user.id === draft.userId          (ownership check)
  4. UPDATE status, set timestamp + audit fields
  5. INSERT audit row in draft_audit_log
```

The ownership check (`step 3`) is enforced on **every** action: generate,
update, submit, send-back, approve, reject, publish.  Only the original author
can perform transitions.

---

## 3. Knowledge Source Pipeline

### 3.1 Upload

- Route: `POST /api/editorial-ai/knowledge/upload`
- Accepts `.md` and `.txt` files (MIME: `text/markdown`, `text/plain`)
- Size limit: `MAX_KNOWLEDGE_FILE_SIZE` bytes (5 MiB)
- SHA-256 checksum computed client-side → server verifies on upload
- **Checksum uniqueness**: a second upload of identical content returns
  `{"duplicateOf": "ks_xxx"}` and creates no new source.
  Enforced by the `knowledge_sources_checksum_unique` UNIQUE index
  (migration 0007).
- File stored in R2 under key `knowledge/{sourceId}/{checksum}.md`
- D1 row inserted with `status = 'UPLOADED'`, `chunk_count = 0`

### 3.2 Ingest

- Server Action: `ingestKnowledgeAction(sourceId)`
- Only `UPLOADED` sources can be ingested (`KnowledgeTransitionError` otherwise)
- Chunker splits content by Markdown headings (## = H2, ### = H3),
  producing chunks of ≤1 024 tokens
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
     (prevents FTS5 injection — e.g. "foo OR bar" → '"foo" OR "bar"')
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
generateDraft(input, userId, opts?)
  1. requireAdmin() — auth check
  2. retrieveKnowledge({
       query: input.topic,
       sourceIds: input.sourceIds,    // optional
       topK: input.topK ?? 5,
     })
  3. if (retrieval.length === 0) throw NoRelevantEvidenceError
  4. provider = opts?.provider ?? resolveProvider()
  5. body = provider.generate(input, retrieval)   // LlmBlock[]
  6. compute checksum = sha256(topic + JSON.stringify(body))
     — uniqueness enforced by editorial_drafts_checksum_unique index
  7. INSERT draft row (status: DRAFT, provider, model, skill, version)
  8. INSERT provenance rows (draft_id → chunk_id, rank)
  9. return EditorialDraftWithSources
```

**Provider resolution** (`resolveProvider()`):
- Checks `EDITORIAL_OPENAI_API_KEY` → OpenAI provider
- Checks `EDITORIAL_ANTHROPIC_API_KEY` → Anthropic provider
- If neither is set → throws `EditorialProviderNotConfiguredError`

**Test-only injection** (`generateDraftAction`):
- When `EDITORIAL_FORCE_FAKE_PROVIDER=1` → injects `FakeProvider`
- This is an **explicit env-var gate**, never a silent fallback
- Set in `playwright.config.ts` webServer `env` for E2E runs only
- Never set in production (Vercel) or local `.env.local` committed to repo

### 4.2 updateDraft()

```typescript
updateDraft(id, input, userId)
  1. requireAdmin()
  2. SELECT draft WHERE id = ? AND user_id = ?   (ownership check)
  3. UPDATE title, excerpt, meta_title, meta_desc, slug, skill_id, skill_version
  4. If status was APPROVED → revert to DRAFT (invalidate approval)
  5. return updated draft
```

### 4.3 Publishing

```
publishDraft(id, userId)
  1. transitionDraft(id, "APPROVED", "PUBLISHED")
  2. Insert into editorial_publications (publisher_id, published_at)
  3. Based on contentType:
     GUIDE       → publishGuide(draft, userId)
     FIELD_NOTE  → publishFieldNote(draft, userId)
  4. publishGuide() / publishFieldNote():
     a. Verify slug uniqueness (editorial_publications.slug_unique)
     b. INSERT into guides / field_notes (slug, title, excerpt, body, meta_*)
     c. Verify ownership: new row’s author_id = userId
     d. Store published_entity_id + published_entity_type on draft
  5. revalidatePath("/guides"), revalidatePath("/field-notes")
  6. return { entityType, entityId }
```

**Slug uniqueness** is enforced by the `editorial_publications_slug_unique`
UNIQUE index (migration 0007).  Two drafts with the same `slugify(topic)`
cannot both be published.

---

## 5. Database Schema (migrations 0006–0007)

### migration 0006 — Foundation: Knowledge sources + FTS5

```sql
-- Knowledge sources (R2-backed)
CREATE TABLE knowledge_sources (
  id        TEXT PRIMARY KEY,       -- ks_xxx
  title     TEXT NOT NULL,
  author    TEXT,
  source_label TEXT,
  notes     TEXT,
  status    TEXT NOT NULL DEFAULT 'UPLOADED',
  checksum  TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE(checksum)  -- knowledge_sources_checksum_unique
);

-- Knowledge chunks
CREATE TABLE knowledge_chunks (
  id          TEXT PRIMARY KEY,   -- kc_xxx
  source_id   TEXT NOT NULL REFERENCES knowledge_sources(id),
  ordinal     INTEGER NOT NULL,
  heading     TEXT,
  content     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  character_count INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- FTS5 virtual table (external-content)
CREATE VIRTUAL TABLE knowledge_chunks_fts
USING fts5(content, content='knowledge_chunks', content_rowid='rowid',
           tokenize = 'trigram');

-- Sync triggers
CREATE TRIGGER kcf_insert AFTER INSERT ON knowledge_chunks BEGIN
  INSERT INTO knowledge_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
-- (UPDATE + DELETE triggers similarly)
```

### migration 0007 — Publications + uniqueness + memory fix

```sql
-- Published entity linkage (replaces single guide/field_note FK)
CREATE TABLE editorial_publications (
  id              TEXT PRIMARY KEY,   -- ep_xxx
  draft_id        TEXT NOT NULL REFERENCES editorial_drafts(id),
  entity_type     TEXT NOT NULL,     -- 'GUIDE' | 'FIELD_NOTE'
  entity_slug     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,     -- guides.id | field_notes.id
  publisher_id    TEXT NOT NULL,     -- auth users.id
  published_at    INTEGER NOT NULL,
  -- checksums ensure the published entity matches the approved draft
  title_checksum  TEXT NOT NULL,
  body_checksum   TEXT NOT NULL,
  UNIQUE(entity_type, entity_id)        -- editorial_publications_entity_unique
);

-- Draft checksum uniqueness
CREATE UNIQUE INDEX editorial_drafts_checksum_unique
ON editorial_drafts(checksum);

-- Publication slug uniqueness (public URL collision guard)
CREATE UNIQUE INDEX editorial_publications_slug_unique
ON editorial_publications(entity_slug);
```

#### 0007 remediation fixes

| Issue | Before | After |
|---|---|---|
| Memory seeds contamination | `knowledge_chunks_fts` sync triggers used `new.rowid` without verifying the parent source was READY | Triggers gated on `ks.status = 'READY' AND ks.archived_at IS NULL` |
| Publication ownership | `publishGuide()` created rows with `author_id = NULL` | `author_id` set to `userId`, verified post-insert |
| Slug collision | Two drafts could publish with the same slug | `editorial_publications_slug_unique` UNIQUE index |
| Draft checksum race | Concurrent generation of identical drafts could insert duplicate rows | `editorial_drafts_checksum_unique` rethrows the SQLite constraint error |

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
terms.

**Integration-level** (E2E): `mission-07-editorial-ai.spec.ts` asserts
the generated draft page and the public published page contain none of the
forbidden terms.

### 6.2 Ownership Enforcement

| Action | Check |
|--------|-------|
| `generateDraft` | `session.user.id` set as `drafts.user_id` on INSERT |
| `updateDraft` | `WHERE id = ? AND user_id = ?` — 403 if mismatch |
| `submitForReview` | `WHERE id = ? AND user_id = ?` |
| `sendBack` | `WHERE id = ? AND user_id = ?` |
| `approve` | `WHERE id = ? AND user_id = ?` |
| `rejectDraft` | `WHERE id = ? AND user_id = ?` |
| `publishDraft` | `WHERE id = ? AND user_id = ?` + `editorial_publications.publisher_id = userId` |
| `publishGuide/FieldNote` | New `guides`/`field_notes` row `author_id = userId` |

### 6.3 Checksum Business Rule

Every `editorial_drafts` row has a `checksum` column
(`sha256(topic + JSON.stringify(bodyBlocks))`).  The
`editorial_drafts_checksum_unique` index ensures that **two drafts with
identical topics and identical generated content cannot coexist**.  If a
collision occurs, the SQLite `SQLITE_CONSTRAINT_UNIQUE` error is rethrown
(propagation path: `generateDraft → INSERT → rethrow →
generateDraftAction → JSON error response`).  This prevents accidental
duplicate drafts from polluting the library.

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
ADMIN_INITIAL_NAME=Dev Admin
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
   in `playwright.config.ts` `webServer.env`).
3. Runs `playwright test`.

### 7.4 FakeProvider Injection

The `generateDraftAction` server action checks for
`EDITORIAL_FORCE_FAKE_PROVIDER=1`:

```typescript
// src/features/editorial-ai/drafts/actions.ts
export async function generateDraftAction(input: GenerateDraftInput) {
  const session = await requireAdmin();
  if (process.env.EDITORIAL_FORCE_FAKE_PROVIDER === "1") {
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

This is an **explicit opt-in**: the env var must be set for FakeProvider to
be used.  In production, `resolveProvider()` throws
`EditorialProviderNotConfiguredError` unless `EDITORIAL_OPENAI_API_KEY` or
`EDITORIAL_ANTHROPIC_API_KEY` is configured.

### 7.5 Test Fixture

`e2e/fixtures/sample-knowledge.md` contains ~350 words of content about
hiring signal decay and evidence-based hiring.  The E2E test creates a
unique copy (with a run-ID comment) in a temp file to avoid checksum
collisions on re-runs.

---

## 8. E2E Test Coverage

`e2e/mission-07-editorial-ai.spec.ts` (serial, single test):

| Step | What it verifies |
|------|-----------------|
| Admin login | Auth redirect to `/admin/content` |
| Upload .md | File accepted, source appears in table |
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
| Drizzle — schema unchanged | `npm run drizzle:diff` (empty) | ✅ |
| E2E suite | `npm run test:e2e` | ✅ |
| TypeScript | `npm run typecheck` | ✅ |
| Lint | `npm run lint` | ✅ |
| Production build | `npm run build` | ✅ |

---

## 10. Files Changed (Mission 07)

### New files
| File | Purpose |
|------|---------|
| `e2e/mission-07-editorial-ai.spec.ts` | E2E lifecycle test |
| `e2e/fixtures/sample-knowledge.md` | E2E knowledge fixture |
| `Docs/Engineering/MISSION-07-WEBSITE-EDITORIAL-AI.md` | This document |
| `drizzle/migrations/0007_editorial_publications.sql` | Publications table, uniqueness indexes |
| `tests/editorial-ai/identity-regression.test.ts` | Platform-identity isolation tests |

### Modified files
| File | Change |
|------|--------|
| `src/features/editorial-ai/drafts/actions.ts` | FakeProvider injection (env-gated) |
| `src/app/admin/editorial/[id]/page-client.tsx` | Edit form (title, excerpt, meta tags) |
| `playwright.config.ts` | `EDITORIAL_FORCE_FAKE_PROVIDER=1` in webServer env |
| `drizzle/migrations/meta/_journal.json` | 0007 migration entry |

---

## 11. Rollback Notes

- The 0007 migration adds tables and indexes (non-destructive).  To rollback:
  `DROP TABLE editorial_publications; DROP INDEX editorial_drafts_checksum_unique;
  DROP INDEX editorial_publications_slug_unique;`
- The `EDITORIAL_FORCE_FAKE_PROVIDER` env var is the only flag that activates
  FakeProvider.  Removing it from the playwright config restores production
  provider resolution.
- The edit form in `DraftDetailClient` is purely additive — it does not change
  any existing UI or behaviour.
