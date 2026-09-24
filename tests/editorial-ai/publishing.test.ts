/**
 * EDITORIAL AI — PUBLISHING & LIFECYCLE TESTS
 * ---------------------------------------------------------------------------
 * Verifies the full draft lifecycle (DRAFT → IN_REVIEW → APPROVED → PUBLISHED),
 * status transition guards, publishing idempotency, and guide/field-note
 * creation from approved drafts. Uses FakeProvider injected via opts.provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "../helpers/env";

import { migrateLocalDb } from "../../src/lib/db/migrate";
import { disposeCloudflareBindings, getR2Bucket } from "../../src/lib/cloudflare/bindings";
import {
  getDb,
  editorial_drafts,
  editorial_draft_sources,
  editorial_audit_log,
  editorial_publications,
  knowledge_sources,
  knowledge_chunks,
  guides,
  fieldNotes,
} from "../../src/lib/db";
import { eq } from "drizzle-orm";

import { uploadKnowledgeSource } from "../../src/features/editorial-ai/knowledge/storage";
import { ingestKnowledgeSource } from "../../src/features/editorial-ai/knowledge/service";
import {
  generateDraft,
  submitForReview,
  approve,
  rejectDraft,
  recoverRejected,
  publishDraft,
  sendBack,
  getDraft,
  updateDraft,
} from "../../src/features/editorial-ai/drafts/service";
import { FakeProvider } from "../../src/features/editorial-ai/providers/fake";
import { createGuide, publishGuide, getPublicGuideBySlug } from "../../src/features/guides/service";
import { createFieldNote, getPublicFieldNoteBySlug } from "../../src/features/field-notes/service";
import type { ContentBlock } from "../../src/features/publishing/types";

const createdDraftIds: string[] = [];
const createdSourceIds: string[] = [];

// Seed a broad knowledge source so generateDraft can retrieve evidence for
// any test topic (evidence-first pipeline requires at least one chunk).
test.before(async () => {
  await migrateLocalDb();
  const content =
    "## Development Lifecycle\n\n" +
    "This content covers the development lifecycle for working engineers shipping real " +
    "software. A draft goes through review before it is approved and published. " +
    "Test audiences include developers, architects, and engineering teams. The publishing " +
    "workflow creates guides and field notes from approved drafts. Content is tested at " +
    "every stage before deployment.\n\n" +
    "## Testing Practices\n\n" +
    "Every draft is reviewed and tested. The testing phase ensures quality before " +
    "the content is published to the public. Test-driven development catches issues early.";
  const result = await uploadKnowledgeSource({
    buffer: new TextEncoder().encode(content).buffer,
    filename: "doc.md",
    contentType: "text/markdown",
    title: "Development Lifecycle Reference",
    createdBy: "test-admin",
  });
  createdSourceIds.push(result.id);
  await ingestKnowledgeSource(result.id, "test-admin");
});

test.after(async () => {
  const db = await getDb();
  for (const id of createdDraftIds) {
    await db.delete(editorial_draft_sources).where(eq(editorial_draft_sources.draftId, id));
  }
  await db.delete(editorial_drafts);
  await db.delete(editorial_draft_sources);
  await db.delete(editorial_audit_log);
  await db.delete(editorial_publications);
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

// Helper: run the full approval pipeline and return the approved draft.
// Injects FakeProvider via opts.provider (no env-based provider needed).
async function prepareApprovedDraft(topic: string, contentType: "GUIDE" | "FIELD_NOTE" = "GUIDE") {
  const draft = await generateDraft(
    { contentType, topic, audience: "test audience" },
    "test-admin",
    { provider: new FakeProvider() },
  );
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
  const draft = await generateDraft(
    { contentType: "GUIDE", topic: `submit-fail-${Date.now()}`, audience: "test audience" },
    "test-admin",
    { provider: new FakeProvider() },
  );
  createdDraftIds.push(draft.id);

  await submitForReview(draft.id, "test-admin");
  // Already in IN_REVIEW → second submit should throw
  await assert.rejects(
    () => submitForReview(draft.id, "test-admin"),
    /not in DRAFT status/i,
  );
});

test("lifecycle: approve on non-IN_REVIEW throws", async () => {
  const draft = await generateDraft(
    { contentType: "GUIDE", topic: `approve-fail-${Date.now()}`, audience: "test audience" },
    "test-admin",
    { provider: new FakeProvider() },
  );
  createdDraftIds.push(draft.id);

  // Draft is in DRAFT status, not IN_REVIEW
  await assert.rejects(
    () => approve(draft.id, "test-admin"),
    /not in IN_REVIEW status/i,
  );
});

test("lifecycle: publishDraft on non-APPROVED throws", async () => {
  const draft = await generateDraft(
    { contentType: "GUIDE", topic: `publish-fail-${Date.now()}`, audience: "test audience" },
    "test-admin",
    { provider: new FakeProvider() },
  );
  createdDraftIds.push(draft.id);

  // Draft is in DRAFT status, not APPROVED
  await assert.rejects(
    () => publishDraft(draft.id, "test-admin"),
    /not in APPROVED status/i,
  );
});

test("lifecycle: reject moves IN_REVIEW → REJECTED", async () => {
  const draft = await generateDraft(
    { contentType: "GUIDE", topic: `reject-test-${Date.now()}` },
    "test-admin",
    { provider: new FakeProvider() },
  );
  createdDraftIds.push(draft.id);

  await submitForReview(draft.id, "test-admin");
  const rejected = await rejectDraft(draft.id, "test-admin", "Quality concerns");
  assert.equal(rejected.status, "REJECTED");
  assert.ok(rejected.rejectedAt instanceof Date);

  // REJECTED is recoverable (not terminal) — but cannot publish directly.
  // Must recover to DRAFT first.
  await assert.rejects(
    () => publishDraft(draft.id, "test-admin"),
    /not in APPROVED status/i,
  );
});

test("lifecycle: sendBack moves IN_REVIEW → DRAFT", async () => {
  const draft = await generateDraft(
    { contentType: "GUIDE", topic: `sendback-test-${Date.now()}` },
    "test-admin",
    { provider: new FakeProvider() },
  );
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
    /already/i,
  );

  // Cannot unpublish (no unpublish action for drafts)
  // Just verify the status is PUBLISHED
  const db = await getDb();
  const row = await db.select().from(editorial_drafts).where(eq(editorial_drafts.id, approved.id)).get();
  assert.equal(row?.status, "PUBLISHED");
  assert.ok(row?.publishedEntityId);
  assert.equal(row?.publishedEntityType, "guide");

  await assert.rejects(
    () => updateDraft(approved.id, { title: "Must not change" }, "test-admin"),
    /Only DRAFT content can be edited/i,
  );
});

test("lifecycle: APPROVED content is read-only until explicitly returned to DRAFT", async () => {
  const approved = await prepareApprovedDraft(`approved-readonly-${Date.now()}`, "GUIDE");
  await assert.rejects(
    () => updateDraft(approved.id, { title: "Late mutation" }, "test-admin"),
    /Only DRAFT content can be edited/i,
  );
  const after = await getDraft(approved.id);
  assert.equal(after?.status, "APPROVED");
  assert.equal(after?.title, approved.title);
});

test("lifecycle: DRAFT edit CAS cannot cross a concurrent submit boundary", async () => {
  const topic = `edit-submit-race-${Date.now()}`;
  const draft = await generateDraft(
    { contentType: "GUIDE", topic, audience: "test audience" },
    "test-admin",
    { provider: new FakeProvider() },
  );
  createdDraftIds.push(draft.id);

  await assert.rejects(
    () =>
      updateDraft(
        draft.id,
        { title: "This edit must lose" },
        "editor-admin",
        {
          onValidated: async () => {
            await submitForReview(draft.id, "review-admin");
          },
        },
      ),
    /status changed to "IN_REVIEW".*edit was being saved/i,
  );

  const after = await getDraft(draft.id);
  assert.equal(after?.status, "IN_REVIEW");
  assert.equal(after?.title, draft.title, "content must remain the reviewed version");

  const db = await getDb();
  const audit = await db
    .select()
    .from(editorial_audit_log)
    .where(eq(editorial_audit_log.entityId, draft.id));
  assert.equal(
    audit.filter((entry) => entry.action === "draft_edited").length,
    0,
    "a lost edit CAS must not emit a draft_edited audit event",
  );
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

test("publish: stale bound reservation with already-published target is recovered", async () => {
  // Simulate a crash during publishDraft: the reservation was inserted
  // (entityId NULL), the target guide was created and published, but the
  // process died before finalizing the publication record / marking the
  // draft PUBLISHED. The next publishDraft call should detect this state,
  // finalize the record, and mark the draft PUBLISHED — without timing out.
  const topic = `crash-recovery-${Date.now()}`;
  const approved = await prepareApprovedDraft(topic, "GUIDE");

  const db = await getDb();

  // Simulate the crashed state: create and publish the target guide directly.
  const guide = await createGuide({
    title: approved.title,
    slug: approved.slug,
    excerpt: approved.excerpt ?? undefined,
    body: approved.body as unknown as ContentBlock[],
    author: "Decoded Editorial",
    coverImage: null,
  });
  await publishGuide(guide.id);

  // Insert the orphaned publication record that OWNS the target by entityId.
  // (Recovery is anchored on entityId, never slug — see publishDraft docs.)
  await db.insert(editorial_publications).values({
    id: `pub_crashed_${crypto.randomUUID().slice(0, 12)}`,
    draftId: approved.id,
    entityType: "guide",
    entityId: guide.id,
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
  });

  // Verify the target is already published before calling publishDraft.
  const published = await getPublicGuideBySlug(approved.slug);
  assert.ok(published, "target guide should already exist and be visible");
  assert.equal(published?.status, "published");

  // publishDraft should recover: detect the in-flight reservation,
  // find the already-published target, finalize the record, mark PUBLISHED.
  const result = await publishDraft(approved.id, "test-admin", { waitTimeoutMs: 25, staleReservationMs: 1_000 });

  assert.equal(result.entityType, "guide");
  assert.equal(result.entityId, guide.id);

  // The draft should now be PUBLISHED with the recovered entityId.
  const finalized = await getDraft(approved.id);
  assert.equal(finalized?.status, "PUBLISHED");
  assert.equal(finalized?.publishedEntityId, guide.id);
  assert.equal(finalized?.publishedEntityType, "guide");

  // The publication record should be finalized with the entityId.
  const pub = await db
    .select()
    .from(editorial_publications)
    .where(eq(editorial_publications.draftId, approved.id))
    .get();
  assert.ok(pub, "publication record should be finalized");
  assert.equal(pub?.entityId, guide.id);
});

test("publish: stale bound reservation with created-but-unpublished target is resumed", async () => {
  // Simulate a crash between target creation and target publishing: the guide
  // exists in "draft" status with a reservation (entityId NULL) but was never
  // published. The next publishDraft call should detect the existing target,
  // PUBLISH it, finalize the record, and mark the draft as PUBLISHED.
  const topic = `crash-recovery-draft-${Date.now()}`;
  const approved = await prepareApprovedDraft(topic, "GUIDE");

  const db = await getDb();

  // Create the guide (as a crashed publish would have done), but do NOT publish it.
  const guide = await createGuide({
    title: approved.title,
    slug: approved.slug,
    excerpt: approved.excerpt ?? undefined,
    body: approved.body as unknown as ContentBlock[],
    author: "Decoded Editorial",
    coverImage: null,
  });
  assert.equal(guide.status, "draft", "guide should start in draft status");

  // Insert the orphaned publication record that OWNS the (unpublished) target
  // by entityId. (Recovery is anchored on entityId, never slug.)
  await db.insert(editorial_publications).values({
    id: `pub_crashed_draft_${crypto.randomUUID().slice(0, 12)}`,
    draftId: approved.id,
    entityType: "guide",
    entityId: guide.id,
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
  });

  // publishDraft should recover: detect the owned reservation, find the draft
  // guide by ID, publish it, finalize the record, and mark the draft PUBLISHED.
  const result = await publishDraft(approved.id, "test-admin", { waitTimeoutMs: 25, staleReservationMs: 1_000 });

  assert.equal(result.entityType, "guide");
  assert.equal(result.entityId, guide.id);

  // The draft should be PUBLISHED with the recovered entityId.
  const finalized = await getDraft(approved.id);
  assert.equal(finalized?.status, "PUBLISHED");
  assert.equal(finalized?.publishedEntityId, guide.id);
});

test("publish: unrelated guide with same slug is NEVER claimed (ownership by entityId)", async () => {
  const db = await getDb();
  const collisionSlug = "development-lifecycle";

  // An UNRELATED guide occupies the draft's slug. Per §2, ownership is by
  // entityId — so this guide must never be silently relinked as the target.
  const unrelated = await createGuide({
    title: "Unrelated Existing Guide",
    slug: collisionSlug,
    author: "Decoded Editorial",
    body: [
      { id: "cb_seed", type: "paragraph", text: "A pre-existing guide occupying this slug." },
    ] as unknown as ContentBlock[],
  });

  const approved = await prepareApprovedDraft("Development Lifecycle", "GUIDE");
  assert.equal(approved.slug, collisionSlug, "draft slug collides with the unrelated guide");

  // createTarget → createGuide hits the unrelated guide's slug collision → fails.
  await assert.rejects(
    () => publishDraft(approved.id, "test-admin"),
    /already exists/i,
  );

  // The draft remains APPROVED and the unrelated guide is untouched.
  const draft = await getDraft(approved.id);
  assert.equal(draft?.status, "APPROVED");
  const unaffected = await db.select().from(guides).where(eq(guides.id, unrelated.id)).get();
  assert.equal(unaffected?.slug, collisionSlug);
  // No publication record was finalized for the draft's id.
  const pub = await db
    .select()
    .from(editorial_publications)
    .where(eq(editorial_publications.draftId, approved.id))
    .get();
  assert.equal(pub, undefined);
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

// ---------------------------------------------------------------------------
// REJECTED → DRAFT recovery
// ---------------------------------------------------------------------------
test("lifecycle: REJECTED → DRAFT recovery (recoverRejected)", async () => {
  const draft = await generateDraft(
    { contentType: "GUIDE", topic: `recover-test-${Date.now()}` },
    "test-admin",
    { provider: new FakeProvider() },
  );
  createdDraftIds.push(draft.id);

  await submitForReview(draft.id, "test-admin");
  const rejected = await rejectDraft(draft.id, "test-admin", "Needs more evidence");
  assert.equal(rejected.status, "REJECTED");

  // REJECTED drafts can be recovered back to DRAFT for re-editing.
  const recovered = await recoverRejected(draft.id, "test-admin", "Found more evidence");
  assert.equal(recovered.status, "DRAFT");
  assert.equal(recovered.reviewedBy, null);
  assert.equal(recovered.rejectedAt, null);

  // After recovery, the draft can be re-submitted for review.
  await submitForReview(draft.id, "test-admin");
});

test("lifecycle: recoverRejected on non-REJECTED status throws", async () => {
  const draft = await generateDraft(
    { contentType: "GUIDE", topic: `recover-fail-test-${Date.now()}` },
    "test-admin",
    { provider: new FakeProvider() },
  );
  createdDraftIds.push(draft.id);

  // Draft is in DRAFT status, not REJECTED — must throw.
  await assert.rejects(
    () => recoverRejected(draft.id, "test-admin"),
    /not in REJECTED status/i,
  );
});

test("lifecycle: PUBLISHED is terminal — recoverRejected rejected", async () => {
  const topic = `recover-terminal-${Date.now()}`;
  const approved = await prepareApprovedDraft(topic, "GUIDE");
  await publishDraft(approved.id, "test-admin");

  // PUBLISHED is terminal — even REJECTED recovery must not apply.
  await assert.rejects(
    () => recoverRejected(approved.id, "test-admin"),
    /already PUBLISHED/i,
  );
});

// ---------------------------------------------------------------------------
// Publishing reliability — lease ownership and partial failure
// ---------------------------------------------------------------------------
test("publish: fresh NULL reservation is never stolen after a short wait", async () => {
  const approved = await prepareApprovedDraft(`fresh-lease-${Date.now()}`, "GUIDE");
  const db = await getDb();
  const reservationId = `pub_fresh_${crypto.randomUUID().slice(0, 12)}`;

  await db.insert(editorial_publications).values({
    id: reservationId,
    draftId: approved.id,
    entityType: "guide",
    entityId: null,
    createdAt: new Date(),
  });

  await assert.rejects(
    () => publishDraft(approved.id, "test-admin", { waitTimeoutMs: 25, staleReservationMs: 60_000 }),
    /still in progress/i,
  );

  const reservation = await db
    .select()
    .from(editorial_publications)
    .where(eq(editorial_publications.draftId, approved.id))
    .get();
  assert.equal(reservation?.id, reservationId, "fresh lease must remain owned by the original publisher");
  assert.equal(reservation?.entityId, null);
});

test("publish: failure after target binding keeps exact ownership and retry resumes same target", async () => {
  const approved = await prepareApprovedDraft(`bound-retry-${Date.now()}`, "GUIDE");
  const db = await getDb();
  let createdId: string | null = null;

  await assert.rejects(
    () =>
      publishDraft(approved.id, "test-admin", {
        onCreateTarget: async (_type, entityId) => {
          createdId = entityId;
          throw new Error("synthetic post-bind failure");
        },
      }),
    /synthetic post-bind failure/,
  );
  assert.ok(createdId);

  const reservation = await db
    .select()
    .from(editorial_publications)
    .where(eq(editorial_publications.draftId, approved.id))
    .get();
  assert.equal(reservation?.entityId, createdId, "bound target ownership must survive a transient failure");

  const targetBeforeRetry = await db.select().from(guides).where(eq(guides.id, createdId!)).get();
  assert.equal(targetBeforeRetry?.status, "draft");

  const result = await publishDraft(approved.id, "test-admin", { waitTimeoutMs: 25, staleReservationMs: 0 });
  assert.equal(result.entityId, createdId, "retry must resume the exact owned target");
  assert.equal((await getDraft(approved.id))?.status, "PUBLISHED");
});

// ---------------------------------------------------------------------------
// Publishing reliability — crash recovery (scenario B)
// ---------------------------------------------------------------------------
test("publish: stale crash reservation before target creation is safely reclaimed", async () => {
  // Simulate a crash between inserting the publication reservation
  // (entityId = NULL) and creating the target entity. The next publishDraft
  // call should detect the orphaned reservation, re-reserve, create the
  // target, and finalize — without hanging or double-publishing.
  const topic = `crash-orphaned-${Date.now()}`;
  const approved = await prepareApprovedDraft(topic, "GUIDE");

  const db = await getDb();

  // Simulate the crashed state: reservation exists but entityId is NULL
  // and no target guide was ever created.
  await db.insert(editorial_publications).values({
    id: `pub_orphan_${crypto.randomUUID().slice(0, 12)}`,
    draftId: approved.id,
    entityType: "guide",
    entityId: null,
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
  });

  // Only a genuinely stale unbound lease may be reclaimed; a fresh lease is never stolen.
  const result = await publishDraft(approved.id, "test-admin", { waitTimeoutMs: 25, staleReservationMs: 1_000 });
  assert.equal(result.entityType, "guide");
  assert.ok(result.entityId, "should have created and published a new guide");

  const finalized = await getDraft(approved.id);
  assert.equal(finalized?.status, "PUBLISHED");
  assert.equal(finalized?.publishedEntityId, result.entityId);
});

// ---------------------------------------------------------------------------
// Publishing reliability — field-note slug collision (scenario F)
// ---------------------------------------------------------------------------
test("publish: unrelated field-note with same slug is NEVER claimed (ownership by entityId)", async () => {
  const db = await getDb();
  const collisionSlug = `fn-collision-${Date.now()}`;

  // An UNRELATED field note occupies the draft's slug. Ownership is by
  // entityId — so this field note must never be silently relinked.
  const unrelated = await createFieldNote({
    title: "Unrelated Existing Field Note",
    slug: collisionSlug,
    excerpt: "Pre-existing note occupying this slug.",
    body: [
      { id: "cb_seed", type: "paragraph", text: "Pre-existing content." },
    ] as unknown as ContentBlock[],
    author: "Decoded Editorial",
    coverImage: null,
  });

  const approved = await prepareApprovedDraft(collisionSlug, "FIELD_NOTE");
  assert.equal(approved.slug, collisionSlug, "draft slug collides with unrelated field note");

  // createTarget → createFieldNote hits the slug collision → fails.
  await assert.rejects(
    () => publishDraft(approved.id, "test-admin"),
    /already exists/i,
  );

  // The draft remains APPROVED and the unrelated field note is untouched.
  const draft = await getDraft(approved.id);
  assert.equal(draft?.status, "APPROVED");
  assert.equal(draft?.publishedEntityId, null);

  const unaffected = await db
    .select()
    .from(fieldNotes)
    .where(eq(fieldNotes.id, unrelated.id))
    .get();
  assert.equal(unaffected?.slug, collisionSlug);

  // The unrelated field note is a draft (not published) — it must NOT be
  // publicly visible, proving the collision did not "claim" it.
  const publicView = await getPublicFieldNoteBySlug(collisionSlug);
  assert.equal(publicView, null, "unrelated field note must remain unpublished");

  // No publication record was finalized for the draft's id.
  const pub = await db
    .select()
    .from(editorial_publications)
    .where(eq(editorial_publications.draftId, approved.id))
    .get();
  assert.equal(pub, undefined);
});

// ---------------------------------------------------------------------------
// Publishing reliability — stale edit during publication (scenario G)
// ---------------------------------------------------------------------------
test("publish: stale edit during publication triggers CAS rollback — target is rolled back, draft unchanged", async () => {
  // Simulate concurrent edit: after the target is created and published but
  // BEFORE the draft is marked PUBLISHED, another actor edits the draft
  // (APPROVED → DRAFT). The CAS guard must detect this, roll back the target
  // (unpublish it), clean up the reservation, and throw — never silently
  // marking a stale draft as PUBLISHED.
  const topic = `stale-edit-${Date.now()}`;
  const approved = await prepareApprovedDraft(topic, "GUIDE");

  const db = await getDb();

  // Create and publish the target (as the winning publish would have done).
  const guide = await createGuide({
    title: approved.title,
    slug: approved.slug,
    excerpt: approved.excerpt ?? undefined,
    body: approved.body as unknown as ContentBlock[],
    author: "Decoded Editorial",
    coverImage: null,
  });
  await publishGuide(guide.id);

  // Insert the publication reservation that OWNS the target by entityId.
  await db.insert(editorial_publications).values({
    id: `pub_stale_${crypto.randomUUID().slice(0, 12)}`,
    draftId: approved.id,
    entityType: "guide",
    entityId: guide.id,
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
  });

  // Simulate a concurrent edit: revert the draft from APPROVED → DRAFT
  // (this is what updateDraft does when an APPROVED draft receives a content edit).
  await db
    .update(editorial_drafts)
    .set({ status: "DRAFT", updatedAt: new Date() })
    .where(eq(editorial_drafts.id, approved.id));

  // publishDraft sees the reservation (entityId set) → finalizeOwnedPublication
  // → CAS update WHERE status=APPROVED moves 0 rows → rollback + throw.
  await assert.rejects(
    () => publishDraft(approved.id, "test-admin", { waitTimeoutMs: 25, staleReservationMs: 1_000 }),
    /stale publish.*modified.*during publication/i,
  );

  // The draft must NOT have been marked PUBLISHED (CAS guard held).
  const after = await getDraft(approved.id);
  assert.equal(after?.status, "DRAFT");

  // The target must NOT be published (rolled back).
  const published = await getPublicGuideBySlug(approved.slug);
  assert.equal(published, null, "target should be unpublished after rollback");

  // The publication record should be cleaned up.
  const pub = await db
    .select()
    .from(editorial_publications)
    .where(eq(editorial_publications.draftId, approved.id))
    .get();
  assert.equal(pub, undefined, "publication record should be cleaned up after rollback");
});
