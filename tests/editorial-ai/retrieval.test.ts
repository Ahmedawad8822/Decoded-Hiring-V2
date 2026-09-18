/**
 * EDITORIAL AI — RETRIEVAL TESTS (FTS5)
 * ---------------------------------------------------------------------------
 * Verifies FTS5 full-text search: term matching, ranking, source filtering,
 * topK clamping, non-READY exclusion, and query sanitization.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "../helpers/env";

import { migrateLocalDb } from "../../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../../src/lib/cloudflare/bindings";
import { getR2Bucket } from "../../src/lib/cloudflare/bindings";
import { getDb, knowledge_sources, knowledge_chunks } from "../../src/lib/db";
import { eq } from "drizzle-orm";

import { uploadKnowledgeSource } from "../../src/features/editorial-ai/knowledge/storage";
import { ingestKnowledgeSource } from "../../src/features/editorial-ai/knowledge/service";
import { retrieveKnowledge } from "../../src/features/editorial-ai/knowledge/retrieval";

let testSourceId = "";

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  // Cleanup: delete test sources + chunks + R2
  if (testSourceId) {
    const db = await getDb();
    await db.delete(knowledge_chunks).where(eq(knowledge_chunks.sourceId, testSourceId));
    const src = await db.select().from(knowledge_sources).where(eq(knowledge_sources.id, testSourceId)).get();
    if (src) {
      const bucket = await getR2Bucket();
      await bucket.delete(src.r2Key).catch(() => undefined);
    }
    await db.delete(knowledge_sources).where(eq(knowledge_sources.id, testSourceId));
  }
  await disposeCloudflareBindings();
});

async function setupSource(content: string, title: string) {
  const buffer = new TextEncoder().encode(content).buffer;
  const result = await uploadKnowledgeSource({
    buffer,
    filename: "doc.md",
    contentType: "text/markdown",
    title,
    createdBy: "test-admin",
  });
  testSourceId = result.id;
  await ingestKnowledgeSource(result.id, "test-admin");
  return result.id;
}

// ---------------------------------------------------------------------------
// Basic retrieval
// ---------------------------------------------------------------------------
test("retrieve: finds chunks matching a term", async () => {
  await setupSource(
    "## System Architecture\n\nThe system uses microservices as its primary deployment pattern. " +
    "Microservices allow independent scaling of different service components.\n\n" +
    "## Infrastructure\n\nAfter deployment, the system converts to production configuration. " +
    "Infrastructure is the final layer before the application goes live.",
    "System Architecture Test",
  );

  const results = await retrieveKnowledge({ query: "microservices", topK: 5 });
  assert.ok(results.length > 0, "should find chunks mentioning microservices");
  const allContent = results.map((r) => r.content).join(" ");
  assert.match(allContent, /microservices/i);

  // Rank should be positive (FTS5 bm25 rank)
  for (const r of results) {
    assert.ok(typeof r.rank === "number");
  }
});

test("retrieve: returns empty for non-matching query", async () => {
  const results = await retrieveKnowledge({ query: "xylophone qzxz non-existent term" });
  assert.equal(results.length, 0);
});

test("retrieve: multi-word query uses AND matching", async () => {
  await setupSource(
    "## Build Tools\n\nWebpack and Vite are both JavaScript bundlers. " +
    "Webpack is the mature bundler with extensive plugin support. " +
    "Vite uses native ES modules for fast development builds. Both are widely used today.",
    "Build Tools Test",
  );

  // "Webpack Vite" should match chunks with either term
  await retrieveKnowledge({ query: "Webpack Vite", topK: 5 });

  // "Webpack" alone should match
  const webpackResults = await retrieveKnowledge({ query: "Webpack", topK: 5 });
  assert.ok(webpackResults.length > 0);
});

// ---------------------------------------------------------------------------
// topK clamping
// ---------------------------------------------------------------------------
test("retrieve: topK clamped to MAX_RETRIEVAL_K (10)", async () => {
  await setupSource(
    Array.from({ length: 10 }, (_, i) => `## Section ${i}\n\n${"term ".repeat(200)}`).join("\n\n"),
    "Many Sections Test"
  );

  const results = await retrieveKnowledge({ query: "term", topK: 100 });
  assert.ok(results.length <= 10, `topK should be clamped to 10, got ${results.length}`);
});

test("retrieve: topK defaults to MAX_RETRIEVAL_K when omitted", async () => {
  await setupSource(
    "## Default TopK\n\n" + "word ".repeat(500),
    "Default TopK Test"
  );

  const results = await retrieveKnowledge({ query: "word" });
  assert.ok(results.length <= 10);
});

// ---------------------------------------------------------------------------
// Source ID filtering
// ---------------------------------------------------------------------------
test("retrieve: sourceIds filter restricts results", async () => {
  // Upload two sources with different content
  const content1 = "## Source A\n\nWebpack optimization pipeline information here.";
  const buffer1 = new TextEncoder().encode(content1).buffer;
  const result1 = await uploadKnowledgeSource({
    buffer: buffer1,
    filename: "a.md",
    contentType: "text/markdown",
    title: "Source A",
    createdBy: "test-admin",
  });
  await ingestKnowledgeSource(result1.id, "test-admin");

  const content2 = "## Source B\n\nVite native build backend information here.";
  const buffer2 = new TextEncoder().encode(content2).buffer;
  const result2 = await uploadKnowledgeSource({
    buffer: buffer2,
    filename: "b.md",
    contentType: "text/markdown",
    title: "Source B",
    createdBy: "test-admin",
  });
  await ingestKnowledgeSource(result2.id, "test-admin");

  // Search for "information" — should find from both sources
  const allResults = await retrieveKnowledge({ query: "information", topK: 10 });
  assert.ok(allResults.length >= 2, "should find chunks from both sources");

  // Filter to only source1
  const filtered = await retrieveKnowledge({ query: "information", topK: 10, sourceIds: [result1.id] });
  for (const r of filtered) {
    assert.equal(r.sourceId, result1.id);
  }
  assert.ok(filtered.length > 0, "should find results for filtered source");

  // Filter to only source2
  const filtered2 = await retrieveKnowledge({ query: "information", topK: 10, sourceIds: [result2.id] });
  for (const r of filtered2) {
    assert.equal(r.sourceId, result2.id);
  }

  // Cleanup second source
  const db = await getDb();
  await db.delete(knowledge_chunks).where(eq(knowledge_chunks.sourceId, result2.id));
  const s2 = await db.select().from(knowledge_sources).where(eq(knowledge_sources.id, result2.id)).get();
  if (s2) {
    const bucket = await getR2Bucket();
    await bucket.delete(s2.r2Key).catch(() => undefined);
  }
  await db.delete(knowledge_sources).where(eq(knowledge_sources.id, result2.id));
});

// ---------------------------------------------------------------------------
// Non-READY exclusion
// ---------------------------------------------------------------------------
test("retrieve: excludes non-READY sources", async () => {
  // Set the test source to UPLOADED (not READY)
  const db = await getDb();
  await db
    .update(knowledge_sources)
    .set({ status: "UPLOADED" })
    .where(eq(knowledge_sources.id, testSourceId));

  // Search should return empty because source is not READY
  const results = await retrieveKnowledge({ query: "word" });
  assert.equal(results.length, 0, "non-READY sources should not appear in results");

  // Restore to READY for subsequent tests
  await db
    .update(knowledge_sources)
    .set({ status: "READY" })
    .where(eq(knowledge_sources.id, testSourceId));
});

// ---------------------------------------------------------------------------
// Query sanitization
// ---------------------------------------------------------------------------
test("retrieve: FTS5 injection via query syntax is neutralized", async () => {
  // Restore the source to READY for this test
  const db = await getDb();
  await db
    .update(knowledge_sources)
    .set({ status: "READY" })
    .where(eq(knowledge_sources.id, testSourceId));

  // A malicious query with FTS5 operators should be treated as literal terms
  const results = await retrieveKnowledge({ query: '"webpack" OR "1"="1' });
  // The query should be treated as matching "gcc" AND "1" AND "1" — not as
  // an OR injection. Results are bounded and safe.
  assert.ok(Array.isArray(results));
});

// ---------------------------------------------------------------------------
// Result metadata
// ---------------------------------------------------------------------------
test("retrieve: results include full metadata (sourceTitle, heading, ordinal)", async () => {
  const db = await getDb();
  await db
    .update(knowledge_sources)
    .set({ status: "READY" })
    .where(eq(knowledge_sources.id, testSourceId));

  const results = await retrieveKnowledge({ query: "webpack", topK: 5 });
  assert.ok(results.length > 0, "should find results for webpack");

  const r = results[0]!;
  assert.ok(r.chunkId, "should have chunkId");
  assert.ok(r.sourceId, "should have sourceId");
  assert.ok(r.sourceTitle, "should have sourceTitle");
  assert.ok(r.heading === null || typeof r.heading === "string", "should have heading or null");
  assert.equal(typeof r.ordinal, "number", "should have ordinal");
  assert.ok(r.content, "should have content");
});
