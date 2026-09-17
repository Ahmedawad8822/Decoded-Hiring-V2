/**
 * EDITORIAL AI — DRAFT GENERATION TESTS
 * ---------------------------------------------------------------------------
 * Verifies: generation pipeline (knowledge retrieval -> memory assembly -> LLM
 * call -> draft save -> provenance recording -> audit log). Uses the FakeProvider
 * so no external API key is needed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "../helpers/env";
import { migrateLocalDb } from "../../src/lib/db/migrate";
import { disposeCloudflareBindings, getR2Bucket } from "../../src/lib/cloudflare/bindings";
import { getDb, knowledge_sources, knowledge_chunks, editorial_drafts, editorial_draft_sources, editorial_audit_log, guides, fieldNotes } from "../../src/lib/db";
import { eq } from "drizzle-orm";

import { uploadKnowledgeSource } from "../../src/features/editorial-ai/knowledge/storage";
import { ingestKnowledgeSource } from "../../src/features/editorial-ai/knowledge/service";
import { generateDraft } from "../../src/features/editorial-ai/drafts/service";
import { resolveProvider } from "../../src/features/editorial-ai/providers";

const createdDraftIds: string[] = [];
const createdSourceIds: string[] = [];

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  const db = await getDb();
  for (const id of createdDraftIds) {
    await db.delete(editorial_draft_sources).where(eq(editorial_draft_sources.draftId, id));
  }
  await db.delete(editorial_drafts);
  await db.delete(editorial_draft_sources);
  await db.delete(editorial_audit_log);
  for (const id of createdSourceIds) {
    await db.delete(knowledge_chunks).where(eq(knowledge_chunks.sourceId, id));
    const src = await db.select().from(knowledge_sources).where(eq(knowledge_sources.id, id)).get();
    if (src) {
      const bucket = await getR2Bucket();
      await bucket.delete(src.r2Key).catch(() => undefined);
    }
  }
  await db.delete(knowledge_sources);
  await db.delete(knowledge_chunks);
  await db.delete(guides);
  await db.delete(fieldNotes);
  await disposeCloudflareBindings();
});

async function seedKnowledge(content: string, title: string) {
  const buffer = new TextEncoder().encode(content).buffer;
  const result = await uploadKnowledgeSource({
    buffer, filename: "doc.md", contentType: "text/markdown",
    title, createdBy: "test-admin",
  });
  createdSourceIds.push(result.id);
  await ingestKnowledgeSource(result.id, "test-admin");
  return result.id;
}

// ---------------------------------------------------------------------------
test("resolveProvider: returns FakeProvider when no env vars set", async () => {
  const provider = await resolveProvider();
  assert.equal(provider.name, "fake");
});

test("generateDraft: creates a DRAFT with content blocks", async () => {
  const topic = "GCC compiler optimization";
  await seedKnowledge(
    "## GCC Optimizations\n\nGCC applies multiple optimization passes to GIMPLE IR. " +
    "The -O2 flag enables standard passes including dead code elimination.",
    "GCC Optimizations Test"
  );

  const draft = await generateDraft({
    contentType: "GUIDE",
    topic,
    workingTitle: "Understanding GCC Optimizations",
    audience: "C++ developers",
    angle: "pass-by-pass walkthrough",
  }, "test-admin");
  createdDraftIds.push(draft.id);

  assert.equal(draft.status, "DRAFT");
  assert.equal(draft.contentType, "GUIDE");
  assert.equal(draft.title, "Draft: " + topic);
  assert.ok(draft.slug.length > 0);
  assert.ok(draft.body.length > 0, "body should have content blocks");
  for (const block of draft.body) {
    assert.ok(["heading", "paragraph", "blockquote", "callout", "list"].includes(block.type));
  }
  assert.ok(draft.skillId);
  assert.ok(draft.skillVersion);
});

test("generateDraft: records source provenance", async () => {
  const topic = "LLVM backend pipeline";
  await seedKnowledge(
    "## LLVM Pipeline\n\nLLVM uses a pass-based optimization architecture. " +
    "The LLVM IR is transformed through multiple passes in the pass manager.",
    "LLVM Pipeline Test"
  );

  const draft = await generateDraft({
    contentType: "FIELD_NOTE",
    topic,
    audience: "systems programmers",
  }, "test-admin");
  createdDraftIds.push(draft.id);

  assert.equal(draft.contentType, "FIELD_NOTE");
  assert.ok(draft.sources.length > 0, "should have source provenance");
  const sourceIds = new Set(draft.sources.map((s) => s.sourceId));
  assert.ok(sourceIds.size > 0, "provenance should reference at least one source");
  for (const prov of draft.sources) {
    assert.ok(prov.chunkId, "should have chunkId");
    assert.ok(prov.sourceTitle, "should have sourceTitle");
    assert.ok(prov.content, "should have chunk content");
    assert.equal(typeof prov.ordinal, "number");
  }
});

test("generateDraft: creates draft even without knowledge sources", async () => {
  const topic = "Compiler architecture design";
  const draft = await generateDraft({
    contentType: "GUIDE",
    topic,
    audience: "compiler engineers",
  }, "test-admin");
  createdDraftIds.push(draft.id);

  assert.equal(draft.status, "DRAFT");
  assert.ok(draft.body.length > 0);
});

test("generateDraft: uses sourceIds filter when provided", async () => {
  const topic = "GCC vs Clang comparison";
  const srcId = await seedKnowledge(
    "## GCC vs Clang\n\nGCC and Clang are both C/C++ compilers. " +
    "GCC is the GNU Compiler Collection. Clang is part of the LLVM project.",
    "GCC vs Clang Test"
  );

  const draft = await generateDraft({
    contentType: "GUIDE",
    topic,
    sourceIds: [srcId],
  }, "test-admin");
  createdDraftIds.push(draft.id);

  assert.equal(draft.status, "DRAFT");
  for (const prov of draft.sources) {
    assert.equal(prov.sourceId, srcId);
  }
});

test("generateDraft: audit entry logged on generation", async () => {
  const topic = "Dead code elimination";
  const draft = await generateDraft({
    contentType: "GUIDE",
    topic,
    workingTitle: "DCE Analysis",
  }, "test-admin");
  createdDraftIds.push(draft.id);

  const db = await getDb();
  const auditEntries = await db
    .select()
    .from(editorial_audit_log)
    .where(eq(editorial_audit_log.entityId, draft.id));

  assert.ok(auditEntries.length > 0, "should have audit log entry");
  assert.equal(auditEntries[0]?.action, "draft_generated");
  assert.equal(auditEntries[0]?.actor, "test-admin");
  assert.equal(auditEntries[0]?.entityType, "editorial_draft");
});

test("generateDraft: unique IDs across multiple drafts", async () => {
  const ids = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const draft = await generateDraft({
      contentType: "GUIDE",
      topic: `test topic ${i}`,
    }, "test-admin");
    createdDraftIds.push(draft.id);
    assert.ok(!ids.has(draft.id), `draft ID should be unique: ${draft.id}`);
    ids.add(draft.id);
  }
  assert.equal(ids.size, 3);
});
