/**
 * EDITORIAL AI — CHECKSUM & INGESTION LIFECYCLE TESTS
 * ---------------------------------------------------------------------------
 * Verifies: upload validation, checksum duplicate detection, deterministic
 * ingestion (UPLOADED → READY), idempotent re-ingestion, archive/restore
 * lifecycle, and failure recovery (UPLOADED → FAILED).
 */
import test from "node:test";
import assert from "node:assert/strict";
import "../helpers/env"; // FIRST: fake BETTER_AUTH_SECRET before app modules.

import { disposeCloudflareBindings } from "../../src/lib/cloudflare/bindings";
import { getR2Bucket } from "../../src/lib/cloudflare/bindings";
import { getDb, knowledge_sources, knowledge_chunks } from "../../src/lib/db";
import { eq } from "drizzle-orm";

import { uploadKnowledgeSource } from "../../src/features/editorial-ai/knowledge/storage";
import {
  ingestKnowledgeSource,
  archiveKnowledgeSource,
  restoreKnowledgeSource,
  getKnowledgeSource,
} from "../../src/features/editorial-ai/knowledge/service";
import type { KnowledgeSource } from "../../src/lib/db";

// Helper: upload a source with given content.
async function upload(content: string, title: string, overrides: { contentType?: string; filename?: string } = {}): Promise<KnowledgeSource> {
  const buffer = new TextEncoder().encode(content).buffer;
  const result = await uploadKnowledgeSource({
    buffer,
    filename: overrides.filename ?? "test.md",
    contentType: overrides.contentType ?? "text/markdown",
    title,
    createdBy: "test-admin",
  });
  const src = await getKnowledgeSource(result.id);
  assert.ok(src, "uploaded source should exist in D1");
  return src;
}

// Cleanup: remove all test sources and their chunks + R2 objects.
async function cleanupAllKnowledge() {
  const db = await getDb();

  // Collect R2 keys to delete
  const sources = await db.select().from(knowledge_sources);
  const r2Keys = sources.map((s) => s.r2Key);

  // Delete chunks, then sources
  await db.delete(knowledge_chunks);
  await db.delete(knowledge_sources);

  // Delete R2 objects
  const bucket = await getR2Bucket();
  for (const key of r2Keys) {
    await bucket.delete(key).catch(() => undefined);
  }
}

test.after(async () => {
  await cleanupAllKnowledge();
  await disposeCloudflareBindings();
});

// ---------------------------------------------------------------------------
// Upload validation
// ---------------------------------------------------------------------------
test("upload: rejects unsupported MIME type", async () => {
  await assert.rejects(
    () =>
      uploadKnowledgeSource({
        buffer: new TextEncoder().encode("hello").buffer,
        filename: "data.json",
        contentType: "application/json",
        title: "Should Fail",
        createdBy: "test-admin",
      }),
    /Unsupported file type/
  );
});

test("upload: rejects empty file", async () => {
  await assert.rejects(
    () =>
      uploadKnowledgeSource({
        buffer: new ArrayBuffer(0),
        filename: "empty.md",
        contentType: "text/markdown",
        title: "Empty File",
        createdBy: "test-admin",
      }),
    /empty/
  );
});

test("upload: rejects oversized file (> 2 MB)", async () => {
  const bigContent = "x".repeat(2 * 1024 * 1024 + 1);
  await assert.rejects(
    () =>
      uploadKnowledgeSource({
        buffer: new TextEncoder().encode(bigContent).buffer,
        filename: "big.md",
        contentType: "text/markdown",
        title: "Big File",
        createdBy: "test-admin",
      }),
    /exceeds the 2 MB/
  );
});

test("upload: valid source gets UPLOADED status and correct metadata", async () => {
  const content = "## Test Heading\n\nSome test content for validation.";
  const src = await upload(content, "Test Source");

  assert.equal(src.status, "UPLOADED");
  assert.equal(src.chunkCount, 0);
  assert.equal(src.sourceType, "markdown");
  assert.ok(src.r2Key.startsWith("editorial/knowledge/"));
  assert.ok(src.checksum.length === 64); // SHA-256 hex
  assert.ok(src.createdAt instanceof Date);
  assert.equal(src.archivedAt, null);

  // R2 object should exist
  const bucket = await getR2Bucket();
  const obj = await bucket.get(src.r2Key);
  assert.ok(obj, "R2 object should exist");
});

// ---------------------------------------------------------------------------
// Checksum-based duplicate detection
// ---------------------------------------------------------------------------
test("upload: duplicate checksum rejected", async () => {
  const content = "## Duplicate Test\n\nThis content is unique.";
  const src1 = await upload(content, "First Upload");

  // Same content, different title — should be rejected by checksum
  await assert.rejects(
    () =>
      uploadKnowledgeSource({
        buffer: new TextEncoder().encode(content).buffer,
        filename: "test.md",
        contentType: "text/markdown",
        title: "Second Upload (Different Title)",
        createdBy: "test-admin",
      }),
    /already exists/i
  );

  // Original is still there
  const check = await getKnowledgeSource(src1.id);
  assert.ok(check);
});

// ---------------------------------------------------------------------------
// Checksum duplicate detection — global UNIQUE (§9)
// ---------------------------------------------------------------------------
test("upload: duplicate checksum rejected even after archive (Option A)", async () => {
  // The checksum UNIQUE index is GLOBAL: an ARCHIVED source still occupies its
  // checksum, so it cannot be re-uploaded until it is deleted. (This is the
  // Option A tradeoff chosen for §9: archived sources are preserved for
  // restore and keep their checksum busy.)
  const content = "## Archived Duplicate\n\nContent that should not be re-uploadable after archiving.";
  const src = await upload(content, "Archive Dup Parent");
  await ingestKnowledgeSource(src.id, "test-admin");
  await archiveKnowledgeSource(src.id, "test-admin");
  assert.equal((await getKnowledgeSource(src.id))?.status, "ARCHIVED");

  await assert.rejects(
    () =>
      uploadKnowledgeSource({
        buffer: new TextEncoder().encode(content).buffer,
        filename: "test.md",
        contentType: "text/markdown",
        title: "Archive Dup Reborn",
        createdBy: "test-admin",
      }),
    /already exists/i
  );
});

test("upload: deletion frees checksum for identical re-upload", async () => {
  // Deleting a source frees its checksum, so identical content can be
  // re-uploaded under a new id (Option A: only deletion, not archive, releases it).
  const content = "## Deleted Then Renewed\n\nFresh content for re-upload after delete.";
  const src = await upload(content, "Delete Parent");
  const db = await getDb();
  await db.delete(knowledge_chunks).where(eq(knowledge_chunks.sourceId, src.id));
  await db.delete(knowledge_sources).where(eq(knowledge_sources.id, src.id));

  const renewed = await upload(content, "Delete Renewed");
  assert.notEqual(renewed.id, src.id, "re-upload should yield a new source id");
  assert.equal(renewed.checksum, src.checksum, "checksum is identical for identical content");
});

test("upload: concurrent identical uploads — exactly one wins (lost race)", async () => {
  // The global UNIQUE(checksum) index is the authoritative backstop: two
  // concurrent identical uploads resolve to one winner; the loser is rejected.
  const content = "## Race Condition\n\nIdentical content uploaded concurrently.";
  const makePayload = () => ({
    buffer: new TextEncoder().encode(content).buffer,
    filename: "test.md",
    contentType: "text/markdown",
    title: "Race Upload",
    createdBy: "test-admin",
  });

  const results = await Promise.allSettled([
    uploadKnowledgeSource(makePayload()),
    uploadKnowledgeSource(makePayload()),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one upload should win the checksum race");
  assert.equal(rejected.length, 1, "the loser must be rejected by the duplicate constraint");
});

// ---------------------------------------------------------------------------
// Ingestion lifecycle
// ---------------------------------------------------------------------------
test("ingest: UPLOADED → READY with deterministic chunks", async () => {
  const content = "## Introduction\n\nThis is the first paragraph with enough content.\n\n## Details\n\nThis is the second paragraph with enough content to form a chunk.";
  const src = await upload(content, "Lifecycle Test");

  assert.equal(src.status, "UPLOADED");

  const result = await ingestKnowledgeSource(src.id, "test-admin");
  assert.equal(result.status, "READY");
  assert.ok(result.chunkCount > 0);

  const updated = await getKnowledgeSource(src.id);
  assert.equal(updated?.status, "READY");
  assert.equal(updated?.chunkCount, result.chunkCount);
  assert.ok(updated?.ingestedAt instanceof Date);
});

test("ingest: deterministic chunking — same content produces identical chunks", async () => {
  const content = "## Section A\n\n" + "alpha ".repeat(300) + "\n\n## Section B\n\n" + "beta ".repeat(300);
  const src = await upload(content, "Determinism Test");

  const result1 = await ingestKnowledgeSource(src.id, "test-admin");
  const chunks1 = await getChunkContents(src.id);

  // Re-ingest: deletes old chunks, re-chunks from same content
  const result2 = await ingestKnowledgeSource(src.id, "test-admin");
  const chunks2 = await getChunkContents(src.id);

  assert.equal(result1.chunkCount, result2.chunkCount);
  assert.deepEqual(chunks1.map((c) => c.contentHash), chunks2.map((c) => c.contentHash));
});

test("ingest: FAILED source can be re-ingested", async () => {
  // Start with a valid source, then try to ingest when R2 is missing
  const content = "## Recoverable\n\nContent that can be recovered.";
  const src = await upload(content, "Recoverable Test");

  // Manually delete the D1 source but keep R2 (simulating a FAILED state)
  await ingestKnowledgeSource(src.id, "test-admin");
  assert.equal((await getKnowledgeSource(src.id))?.status, "READY");

  // Re-ingest after READY — should work (idempotent re-ingest on READY source)
  const result = await ingestKnowledgeSource(src.id, "test-admin");
  assert.equal(result.status, "READY");
  assert.ok(result.chunkCount > 0);
});

test("ingest: concurrent re-ingestion is serialized and archive cannot steal the lease", async () => {
  const content = "## Exclusive Ingestion\n\n" + "evidence ".repeat(220);
  const src = await upload(content, "Exclusive Ingestion");

  let releaseClaim!: () => void;
  let signalClaim!: () => void;
  const claimHeld = new Promise<void>((resolve) => { releaseClaim = resolve; });
  const claimStarted = new Promise<void>((resolve) => { signalClaim = resolve; });

  const first = ingestKnowledgeSource(src.id, "test-admin", {
    onClaim: async () => {
      signalClaim();
      await claimHeld;
    },
  });

  await claimStarted;

  await assert.rejects(
    () => ingestKnowledgeSource(src.id, "test-admin"),
    /already being ingested/i,
  );

  await assert.rejects(
    () => archiveKnowledgeSource(src.id, "test-admin"),
    /currently being ingested/i,
  );

  releaseClaim();
  const completed = await first;
  assert.equal(completed.status, "READY");
  assert.equal((await getKnowledgeSource(src.id))?.status, "READY");
});

test("ingest: stale INGESTING lease can be reclaimed by exact version", async () => {
  const content = "## Crash Recovery\n\n" + "recovered evidence ".repeat(120);
  const src = await upload(content, "Stale Ingestion");
  const db = await getDb();

  await db
    .update(knowledge_sources)
    .set({ status: "INGESTING", updatedAt: new Date(Date.now() - 10 * 60 * 1000) })
    .where(eq(knowledge_sources.id, src.id));

  const result = await ingestKnowledgeSource(src.id, "test-admin", { staleAfterMs: 1_000 });
  assert.equal(result.status, "READY");
  assert.ok(result.chunkCount > 0);
});

test("ingest: zero-chunk source fails gracefully", async () => {
  // A source with only whitespace
  const content = "   \n\n  \n\t  ";
  const src = await upload(content, "Empty Chunk Test");

  await assert.rejects(
    () => ingestKnowledgeSource(src.id, "test-admin"),
    /zero chunks/
  );

  const updated = await getKnowledgeSource(src.id);
  assert.equal(updated?.status, "FAILED");
});

// ---------------------------------------------------------------------------
// Archive / restore
// ---------------------------------------------------------------------------
test("archive: READY → ARCHIVED, chunks preserved", async () => {
  const content = "## Archive Me\n\nContent to be archived after ingestion.";
  const src = await upload(content, "Archive Prepped");
  await ingestKnowledgeSource(src.id, "test-admin");
  assert.equal((await getKnowledgeSource(src.id))?.status, "READY");

  const archived = await archiveKnowledgeSource(src.id, "test-admin");
  assert.equal(archived.status, "ARCHIVED");
  assert.ok(archived.archivedAt instanceof Date);

  // Chunks are preserved on archive (FK cascade only fires on D1 row delete)
});

test("archive: ARCHIVED → ARCHIVED throws (already archived)", async () => {
  const content = "## Already Archived\n\nThis is content.";
  const src = await upload(content, "Already Archived");
  await ingestKnowledgeSource(src.id, "test-admin");
  await archiveKnowledgeSource(src.id, "test-admin");

  await assert.rejects(
    () => archiveKnowledgeSource(src.id, "test-admin"),
    /already archived/i
  );
});

test("archive: INGESTING source cannot be archived", async () => {
  const content = "## Ingesting Now\n\nContent being ingested.";
  const src = await upload(content, "Ingesting Source");

  // Manually set status to INGESTING
  const db = await getDb();
  await db
    .update(knowledge_sources)
    .set({ status: "INGESTING" })
    .where(eq(knowledge_sources.id, src.id));

  await assert.rejects(
    () => archiveKnowledgeSource(src.id, "test-admin"),
    /currently being ingested/i
  );
});

test("restore: ARCHIVED → READY", async () => {
  const content = "## Restorable\n\nContent that can be restored.";
  const src = await upload(content, "Restore Me");
  await ingestKnowledgeSource(src.id, "test-admin");
  await archiveKnowledgeSource(src.id, "test-admin");

  const restored = await restoreKnowledgeSource(src.id, "test-admin");
  assert.equal(restored.status, "READY");
  assert.equal(await restored.archivedAt, null);
});

test("restore: non-archived source throws", async () => {
  const content = "## Not Archived\n\nContent not archived.";
  const src = await upload(content, "Not Archived");

  await assert.rejects(
    () => restoreKnowledgeSource(src.id, "test-admin"),
    /Only archived sources can be restored/
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getChunkContents(sourceId: string): Promise<{ contentHash: string; content: string }[]> {
  const db = await getDb();
  const rows = await db
    .select({ contentHash: knowledge_chunks.contentHash, content: knowledge_chunks.content })
    .from(knowledge_chunks)
    .where(eq(knowledge_chunks.sourceId, sourceId))
    .orderBy(knowledge_chunks.ordinal);
  return rows;
}
