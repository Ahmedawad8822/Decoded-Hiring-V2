/**
 * EDITORIAL AI — DRAFT GENERATION TESTS
 * ---------------------------------------------------------------------------
 * Verifies: generation pipeline (knowledge retrieval -> memory assembly -> LLM
 * call -> draft save -> provenance recording -> audit log). Uses the FakeProvider
 * injected via generateDraft's opts.provider so no external API key is needed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "../helpers/env";
import { migrateLocalDb } from "../../src/lib/db/migrate";
import { disposeCloudflareBindings, getR2Bucket } from "../../src/lib/cloudflare/bindings";
import {
  getDb,
  knowledge_sources,
  knowledge_chunks,
  editorial_drafts,
  editorial_draft_sources,
  editorial_audit_log,
  guides,
  fieldNotes,
} from "../../src/lib/db";
import { eq } from "drizzle-orm";

import { uploadKnowledgeSource } from "../../src/features/editorial-ai/knowledge/storage";
import { ingestKnowledgeSource } from "../../src/features/editorial-ai/knowledge/service";
import { generateDraft } from "../../src/features/editorial-ai/drafts/service";
import { generateDraftSchema, updateDraftSchema } from "../../src/features/editorial-ai/drafts/types";
import { resolveProvider, EditorialProviderNotConfiguredError, isProviderNotConfigured } from "../../src/features/editorial-ai/providers";
import { FakeProvider } from "../../src/features/editorial-ai/providers/fake";

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
// Provider resolution (fail-closed)
// ---------------------------------------------------------------------------
test("resolveProvider: throws EditorialProviderNotConfiguredError when no env vars set", async () => {
  await assert.rejects(
    async () => resolveProvider(),
    (err) => {
      assert.ok(err instanceof EditorialProviderNotConfiguredError);
      assert.equal(err.code, "EDITORIAL_PROVIDER_NOT_CONFIGURED");
      return true;
    },
  );
});

test("isProviderNotConfigured: true for unconfigured error", () => {
  const err = new EditorialProviderNotConfiguredError();
  assert.equal(isProviderNotConfigured(err), true);
  assert.equal(isProviderNotConfigured(new Error("other")), false);
});

// ---------------------------------------------------------------------------
// Runtime input contracts
// ---------------------------------------------------------------------------
test("draft schemas: accept real ks_ source ids and reject malformed content blocks", () => {
  const parsed = generateDraftSchema.parse({
    contentType: "GUIDE",
    topic: "structured hiring intake",
    sourceIds: ["ks_12345678-abc"],
  });
  assert.deepEqual(parsed.sourceIds, ["ks_12345678-abc"]);

  assert.throws(
    () =>
      generateDraftSchema.parse({
        contentType: "GUIDE",
        topic: "structured hiring intake",
        sourceIds: ["550e8400-e29b-41d4-a716-446655440000"],
      }),
    /Invalid knowledge source id/i,
  );

  assert.throws(
    () =>
      updateDraftSchema.parse({
        body: [{ type: "script", text: "<script>alert(1)</script>" }],
      }),
  );
});

// ---------------------------------------------------------------------------
// Generation pipeline
// ---------------------------------------------------------------------------
test("generateDraft: creates a DRAFT with content blocks", async () => {
  const topic = "Build system optimization patterns";
  await seedKnowledge(
    "## Build Optimization\n\nBuild systems apply multiple optimization passes to reduce output size. " +
    "The production build flag enables standard passes including tree shaking and dead code elimination.",
    "Build Optimization Test",
  );

  const draft = await generateDraft({
    contentType: "GUIDE",
    topic,
    workingTitle: "Understanding Build Optimizations",
    audience: "Frontend developers",
    angle: "pass-by-pass walkthrough",
  }, "test-admin", { provider: new FakeProvider() });
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
  const topic = "Deployment pipeline architecture";
  await seedKnowledge(
    "## Deployment Pipeline\n\nModern deployment systems use a pass-based optimization architecture. " +
    "The build output is transformed through multiple stages in the pipeline before reaching production.",
    "Deployment Pipeline Test",
  );

  const draft = await generateDraft({
    contentType: "FIELD_NOTE",
    topic,
    audience: "systems programmers",
  }, "test-admin", { provider: new FakeProvider() });
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

test("generateDraft: uses sourceIds filter when provided", async () => {
  const topic = "Build tool comparison";
  const srcId = await seedKnowledge(
    "## Build Tool A\n\nBuild tool A and Build tool B are both modern bundlers. " +
    "Build tool A is the popular choice with fast incremental builds.",
    "Build Tool Comparison Test",
  );

  const draft = await generateDraft({
    contentType: "GUIDE",
    topic,
    sourceIds: [srcId],
  }, "test-admin", { provider: new FakeProvider() });
  createdDraftIds.push(draft.id);

  assert.equal(draft.status, "DRAFT");
  for (const prov of draft.sources) {
    assert.equal(prov.sourceId, srcId);
  }
});

test("generateDraft: audit entry logged on generation", async () => {
  const topic = "Tree shaking in build systems";
  await seedKnowledge(
    "## Tree Shaking\n\nTree shaking removes unused exports from bundle output. " +
    "This optimization pass runs after module resolution in the build pipeline.",
    "Tree Shaking Test",
  );

  const draft = await generateDraft({
    contentType: "GUIDE",
    topic,
    workingTitle: "Tree Shaking Deep Dive",
  }, "test-admin", { provider: new FakeProvider() });
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
  await seedKnowledge(
    "## Test Knowledge\n\nThis source covers multiple test topics including topic alpha, " +
    "topic beta, and topic gamma. Each is discussed in its own section.",
    "Multi Topic Test",
  );

  const ids = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const draft = await generateDraft({
      contentType: "GUIDE",
      topic: `topic ${i}`,
    }, "test-admin", { provider: new FakeProvider() });
    createdDraftIds.push(draft.id);
    assert.ok(!ids.has(draft.id), `draft ID should be unique: ${draft.id}`);
    ids.add(draft.id);
  }
  assert.equal(ids.size, 3);
});

test("generateDraft: throws NoRelevantEvidenceError when no knowledge matches topic", async () => {
  await assert.rejects(
    async () =>
      generateDraft({
        contentType: "GUIDE",
        topic: "Quantum flux capacitor engineering",
      }, "test-admin", { provider: new FakeProvider() }),
    /No relevant evidence/i,
  );
});
