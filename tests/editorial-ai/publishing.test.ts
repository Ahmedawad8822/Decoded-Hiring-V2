/**
 * EDITORIAL AI — PUBLISHING & LIFECYCLE TESTS
 * ---------------------------------------------------------------------------
 * Verifies the full draft lifecycle (DRAFT → IN_REVIEW → APPROVED → PUBLISHED),
 * status transition guards, publishing idempotency, and guide/field-note
 * creation from approved drafts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "../helpers/env";
import { migrateLocalDb } from "../../src/lib/db/migrate";
import { disposeCloudflareBindings, getR2Bucket } from "../../src/lib/cloudflare/bindings";
import { getDb, editorial_drafts, editorial_draft_sources, editorial_audit_log, knowledge_sources, knowledge_chunks, guides, fieldNotes } from "../../src/lib/db";
import { eq } from "drizzle-orm";

import {
  generateDraft,
  submitForReview,
  approve,
  rejectDraft,
  publishDraft,
  sendBack,
} from "../../src/features/editorial-ai/drafts/service";

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

// Helper: run the full approval pipeline and return the approved draft
async function prepareApprovedDraft(topic: string, contentType: "GUIDE" | "FIELD_NOTE" = "GUIDE") {
  const draft = await generateDraft({
    contentType,
    topic,
    audience: "test audience",
  }, "test-admin");
  createdDraftIds.push(draft.id);

  await submitForReview(draft.id, "test-admin");
  const reviewed = await approve(draft.id, "test-admin");
  assert.equal(reviewed.status, "APPROVED");
  return reviewed;
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------
test("lifecycle: DRAFT → IN_REVIEW → APPROVED → PUBLISHED (happy path, guide)", async () => {
  const topic = `lifecycle-happy-${Date.now()}`;
  const approved = await prepareApprovedDraft(topic, "GUIDE");

  const published = await publishDraft(approved.id, "test-admin");
  assert.equal(published.entityType, "guide");
  assert.ok(published.entityId);

  // Verify the guide exists in the guides table
  const db = await getDb();
  const guide = await db.select().from(guides).where(eq(guides.id, published.entityId)).get();
  assert.ok(guide, "guide should exist in guides table");
  assert.ok(guide?.title, "guide should have a title");
  assert.equal(guide?.slug, approved.slug);
});

test("lifecycle: submitForReview on non-DRAFT throws", async () => {
  const draft = await generateDraft({
    contentType: "GUIDE",
    topic: `submit-fail-${Date.now()}`,
  }, "test-admin");
  createdDraftIds.push(draft.id);

  await submitForReview(draft.id, "test-admin");
  // Already in IN_REVIEW → second submit should throw
  await assert.rejects(
    () => submitForReview(draft.id, "test-admin"),
    /not in DRAFT status/i
  );
});

test("lifecycle: approve on non-IN_REVIEW throws", async () => {
  const draft = await generateDraft({
    contentType: "GUIDE",
    topic: `approve-fail-${Date.now()}`,
  }, "test-admin");
  createdDraftIds.push(draft.id);

  // Draft is in DRAFT status, not IN_REVIEW
  await assert.rejects(
    () => approve(draft.id, "test-admin"),
    /not in IN_REVIEW status/i
  );
});

test("lifecycle: publishDraft on non-APPROVED throws", async () => {
  const draft = await generateDraft({
    contentType: "GUIDE",
    topic: `publish-fail-${Date.now()}`,
  }, "test-admin");
  createdDraftIds.push(draft.id);

  // Draft is in DRAFT status, not APPROVED
  await assert.rejects(
    () => publishDraft(draft.id, "test-admin"),
    /not in APPROVED status/i
  );
});

test("lifecycle: reject moves IN_REVIEW → REJECTED", async () => {
  const draft = await generateDraft({
    contentType: "GUIDE",
    topic: `reject-test-${Date.now()}`,
  }, "test-admin");
  createdDraftIds.push(draft.id);

  await submitForReview(draft.id, "test-admin");
  const rejected = await rejectDraft(draft.id, "test-admin", "Quality concerns");
  assert.equal(rejected.status, "REJECTED");
  assert.ok(rejected.rejectedAt instanceof Date);

  // REJECTED is terminal — cannot publish
  await assert.rejects(
    () => publishDraft(draft.id, "test-admin"),
    /not in APPROVED status/i
  );
});

test("lifecycle: sendBack moves IN_REVIEW → DRAFT", async () => {
  const draft = await generateDraft({
    contentType: "GUIDE",
    topic: `sendback-test-${Date.now()}`,
  }, "test-admin");
  createdDraftIds.push(draft.id);

  await submitForReview(draft.id, "test-admin");
  const returned = await sendBack(draft.id, "test-admin", "Needs more evidence");
  assert.equal(returned.status, "DRAFT");
  assert.equal(returned.reviewedBy, null);

  // Can re-submit for review after send-back
  await submitForReview(draft.id, "test-admin");
});

test("lifecycle: PUBLISHED is terminal — no further transitions", async () => {
  const topic = `terminal-published-${Date.now()}`;
  const approved = await prepareApprovedDraft(topic, "GUIDE");
  await publishDraft(approved.id, "test-admin");

  // Cannot submit for review after publishing (not DRAFT)
  await assert.rejects(
    () => submitForReview(approved.id, "test-admin"),
    /already/i
  );

  // Cannot unpublish (no unpublish action for drafts)
  // Just verify the status is PUBLISHED
  const db = await getDb();
  const row = await db.select().from(editorial_drafts).where(eq(editorial_drafts.id, approved.id)).get();
  assert.equal(row?.status, "PUBLISHED");
  assert.ok(row?.publishedEntityId);
  assert.equal(row?.publishedEntityType, "guide");
});

// ---------------------------------------------------------------------------
// Publishing idempotency
// ---------------------------------------------------------------------------
test("publish: idempotent — publishing same draft twice returns same entity", async () => {
  const topic = `idempotent-${Date.now()}`;
  const approved = await prepareApprovedDraft(topic, "GUIDE");

  const pub1 = await publishDraft(approved.id, "test-admin");
  const pub2 = await publishDraft(approved.id, "test-admin");

  assert.equal(pub1.entityId, pub2.entityId);
  assert.equal(pub1.entityType, pub2.entityType);
});

test("publish: two different drafts create different guides", async () => {
  const topicA = `dual-a-${Date.now()}`;
  const topicB = `dual-b-${Date.now()}`;
  const approvedA = await prepareApprovedDraft(topicA, "GUIDE");
  const approvedB = await prepareApprovedDraft(topicB, "GUIDE");

  const pubA = await publishDraft(approvedA.id, "test-admin");
  const pubB = await publishDraft(approvedB.id, "test-admin");

  assert.notEqual(pubA.entityId, pubB.entityId, "different drafts should create different guides");
});

test("publish: field-note draft creates a field_note entity", async () => {
  const topic = `fn-publish-${Date.now()}`;
  const approved = await prepareApprovedDraft(topic, "FIELD_NOTE");

  const published = await publishDraft(approved.id, "test-admin");
  assert.equal(published.entityType, "field_note");
  assert.ok(published.entityId);

  const db = await getDb();
  const note = await db.select().from(fieldNotes).where(eq(fieldNotes.id, published.entityId)).get();
  assert.ok(note, "field note should exist in field_notes table");
});

// ---------------------------------------------------------------------------
// Content conversion
// ---------------------------------------------------------------------------
test("publish: LLM blocks converted to ContentBlocks with id and anchor", async () => {
  const topic = `content-convert-${Date.now()}`;
  const approved = await prepareApprovedDraft(topic, "GUIDE");
  const published = await publishDraft(approved.id, "test-admin");

  const db = await getDb();
  const guide = await db.select().from(guides).where(eq(guides.id, published.entityId)).get();
  assert.ok(guide, "guide should exist");

  // Body should be JSON-serialized ContentBlock[]
  const body = JSON.parse(guide!.body);
  assert.ok(Array.isArray(body), "body should be an array of ContentBlocks");

  for (const block of body) {
    assert.equal(typeof block.id, "string", "each block should have an id");
    assert.ok(["heading", "paragraph", "blockquote", "callout", "list", "resource"].includes(block.type));
    if (block.type === "heading") {
      assert.ok(block.anchor, "heading blocks should have an anchor");
      assert.ok(block.level === 2 || block.level === 3, "heading level should be 2 or 3");
    }
  }
});
