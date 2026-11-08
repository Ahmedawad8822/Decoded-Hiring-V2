/**
 * ADMIN AUDIT TRAIL (threat-model G4)
 * ---------------------------------------------------------------------------
 * Drives the REAL server actions / route handlers as a signed-in admin (a real
 * Better Auth session cookie; only `next/headers` and `next/cache` are stubbed
 * because there is no Next request scope under tsx) and asserts one
 * `admin_audit_log` row per entity type, plus the admin page's query and the
 * "audit failure is logged, not thrown" contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.
// These admins have no 2FA enrolled; the 2FA gate itself is covered by
// tests/admin-two-factor.test.ts.
process.env.ADMIN_REQUIRE_2FA = "false";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import { adminAuditLog, getDb, users } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import { IMAGE_FIXTURES } from "./helpers/image-fixtures";

const nodeRequire = createRequire(__filename);
let cookieHeader = "";
const revalidatedPaths: string[] = [];

/** Install stubs in require.cache BEFORE the app modules that import them load. */
function stubModule(id: string, exports: Record<string, unknown>) {
  const resolved = nodeRequire.resolve(id);
  nodeRequire.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
}

const uid = () => crypto.randomUUID().slice(0, 8);
let adminId = "";

type Mods = {
  guides: typeof import("../src/features/guides/actions");
  notes: typeof import("../src/features/field-notes/actions");
  courses: typeof import("../src/features/courses/actions");
  media: typeof import("../src/app/api/media/upload/route");
  commerce: typeof import("../src/features/commerce/admin-actions");
  audit: typeof import("../src/features/audit/service");
};
let m: Mods;

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", {
    revalidatePath: (path: string) => { revalidatedPaths.push(path); },
    revalidateTag: () => {},
    unstable_cache: <T>(fn: T) => fn,
  });

  const auth = await getAuth();
  const email = `audit-admin-${uid()}@example.com`;
  const password = "AuditAdminPass123!";
  const created = await auth.api.signUpEmail({ body: { email, password, name: "Audit Admin" } });
  adminId = created.user.id;
  const db = await getDb();
  await db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  cookieHeader = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookieHeader, "sign-in must yield a session cookie");

  m = {
    guides: await import("../src/features/guides/actions"),
    notes: await import("../src/features/field-notes/actions"),
    courses: await import("../src/features/courses/actions"),
    media: await import("../src/app/api/media/upload/route"),
    commerce: await import("../src/features/commerce/admin-actions"),
    audit: await import("../src/features/audit/service"),
  };
});

test.after(async () => {
  await disposeCloudflareBindings();
});

async function rowsFor(entityType: string, entityId: string) {
  const db = await getDb();
  return db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityType, entityType), eq(adminAuditLog.entityId, entityId)));
}

test("guide create/update/publish write audit rows with actor, slugs and status", async () => {
  const a = `ag-a-${uid()}`;
  const b = `ag-b-${uid()}`;
  const created = await m.guides.createGuideAction({ title: "Audit guide", slug: a, author: "Test", body: [] });
  assert.ok(created.ok, String(created.error));
  const id = created.data!.id;
  const upd = await m.guides.updateGuideAction({ id, slug: b });
  assert.ok(upd.ok, String(upd.error));
  const pub = await m.guides.publishGuideAction(id);
  assert.ok(pub.ok, String(pub.error));

  const rows = await rowsFor("guide", id);
  assert.deepEqual(rows.map((r) => r.action).sort(), ["guide.create", "guide.publish", "guide.update"]);
  assert.ok(rows.every((r) => r.actorId === adminId));
  const update = rows.find((r) => r.action === "guide.update")!;
  assert.deepEqual(JSON.parse(update.details!), { oldSlug: a, newSlug: b });
  const publish = rows.find((r) => r.action === "guide.publish")!;
  assert.deepEqual(JSON.parse(publish.details!), { slug: b, status: "published" });
});

test("field note create + archive write audit rows", async () => {
  const slug = `an-${uid()}`;
  const created = await m.notes.createFieldNoteAction({ title: "Audit note", slug, body: [] } as never);
  assert.ok(created.ok, String(created.error));
  const id = created.data!.id;
  const arch = await m.notes.archiveFieldNoteAction(id);
  assert.ok(arch.ok, String(arch.error));
  const rows = await rowsFor("field_note", id);
  assert.deepEqual(rows.map((r) => r.action).sort(), ["field_note.archive", "field_note.create"]);
});

// Both domains must invalidate identical public surfaces for every lifecycle
// mutation, including edits/renames and draft creation (negative caches).
for (const kind of ["guide", "note"] as const) {
  test(`${kind} actions expire sitemap and public paths consistently`, async () => {
    const actions = kind === "guide" ? {
      create: m.guides.createGuideAction, update: m.guides.updateGuideAction,
      publish: m.guides.publishGuideAction, unpublish: m.guides.unpublishGuideAction,
      archive: m.guides.archiveGuideAction,
    } : {
      create: m.notes.createFieldNoteAction, update: m.notes.updateFieldNoteAction,
      publish: m.notes.publishFieldNoteAction, unpublish: m.notes.unpublishFieldNoteAction,
      archive: m.notes.archiveFieldNoteAction,
    };
    const base = kind === "guide" ? "/guides" : "/field-notes";
    const slug = `invalidate-${kind}-${uid()}`;
    function paths(current: string, previous?: string) {
      assert.deepEqual(revalidatedPaths.splice(0), [base, "/sitemap.xml", `${base}/${current}`,
        ...(previous ? [`${base}/${previous}`] : []), "/admin/content"]);
    }
    revalidatedPaths.length = 0;
    const created = await actions.create({ title: "Sitemap freshness", slug, author: "Test", body: [] });
    assert.ok(created.ok, String(created.error));
    const id = created.data!.id;
    paths(slug);
    for (const mutate of [actions.publish, actions.unpublish, actions.publish]) {
      const result = await mutate(id);
      assert.ok(result.ok, String(result.error));
      paths(slug);
    }
    const renamed = `${slug}-renamed`;
    const edited = await actions.update({ id, slug: renamed, title: "Edited" });
    assert.ok(edited.ok, String(edited.error));
    paths(renamed, slug);
    const archived = await actions.archive(id);
    assert.ok(archived.ok, String(archived.error));
    paths(renamed);
  });
}

test("course, section and lesson mutations write audit rows", async () => {
  const course = await m.courses.createCourseAction({ title: "Audit course", slug: `ac-${uid()}` });
  assert.ok(course.ok, String(course.error));
  const courseId = course.data!.id;
  const section = await m.courses.createSectionAction({ courseId, title: "Section one" });
  assert.ok(section.ok, String(section.error));
  const lesson = await m.courses.createLessonAction({
    courseId,
    sectionId: section.data!.id,
    title: "Lesson one",
    slug: `al-${uid()}`,
  });
  assert.ok(lesson.ok, String(lesson.error));
  const pub = await m.courses.publishLessonAction(lesson.data!.id);
  assert.ok(pub.ok, String(pub.error));
  const mv = await m.courses.moveLessonAction(lesson.data!.id, "up");
  assert.ok(mv.ok, String(mv.error));

  assert.deepEqual((await rowsFor("course", courseId)).map((r) => r.action), ["course.create"]);
  assert.deepEqual((await rowsFor("course_section", section.data!.id)).map((r) => r.action), [
    "course_section.create",
  ]);
  assert.deepEqual((await rowsFor("lesson", lesson.data!.id)).map((r) => r.action).sort(), [
    "lesson.create",
    "lesson.move",
    "lesson.publish",
  ]);
});

test("media upload route writes an audit row", async () => {
  const form = new FormData();
  form.set("file", new File([IMAGE_FIXTURES["image/png"] as BlobPart], "a.png", { type: "image/png" }));
  const res = await m.media.POST(new Request("http://localhost/api/media/upload", { method: "POST", body: form }));
  assert.equal(res.status, 201);
  const { key } = (await res.json()) as { key: string };
  const rows = await rowsFor("media", key);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "media.upload");
  assert.equal(rows[0].actorId, adminId);
});

test("offer, booking type and availability window mutations write audit rows", async () => {
  const bt = await m.commerce.createBookingTypeAdminAction({
    slug: `abt-${uid()}`,
    title: "Audit coaching",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingHorizonDays: 30,
    timezone: "Africa/Cairo",
    confirmationPolicy: "AHMED_APPROVAL",
    accessMode: "PAYMENT_DISABLED",
    meetingMethod: "TO_BE_CONFIRMED",
    attendeeLimit: 1,
  });
  assert.ok(bt.ok, String(bt.error));
  const btId = bt.data!.id;
  const win = await m.commerce.createAvailabilityWindowAdminAction({
    bookingTypeId: btId,
    weekday: 2,
    startMinute: 540,
    endMinute: 1020,
  });
  assert.ok(win.ok, String(win.error));
  const offer = await m.commerce.createOfferAdminAction({
    kind: "COACHING",
    bookingTypeId: btId,
    title: "Audit offer",
    slug: `ao-${uid()}`,
    accessMode: "PAYMENT_DISABLED",
    alternativeCtaLabel: "Send a brief",
    alternativeCtaUrl: "#brief",
  });
  assert.ok(offer.ok, String(offer.error));

  assert.deepEqual((await rowsFor("booking_type", btId)).map((r) => r.action), ["booking_type.create"]);
  assert.deepEqual((await rowsFor("availability_window", win.data!.id)).map((r) => r.action), [
    "availability_window.create",
  ]);
  const offerRows = await rowsFor("offer", offer.data!.id);
  assert.deepEqual(offerRows.map((r) => r.action), ["offer.create"]);
  assert.equal(JSON.parse(offerRows[0].details!).accessMode, "PAYMENT_DISABLED");
});

test("a failed action writes no audit row", async () => {
  const before = (await m.audit.listAdminAudit({})).total;
  const res = await m.guides.publishGuideAction(`missing-${uid()}`);
  assert.equal(res.ok, false);
  assert.equal((await m.audit.listAdminAudit({})).total, before);
});

test("listAdminAudit filters by entity type and paginates newest first", async () => {
  const all = await m.audit.listAdminAudit({});
  assert.ok(all.total >= 8);
  const guides = await m.audit.listAdminAudit({ entityType: "guide" });
  assert.ok(guides.entries.length >= 3);
  assert.ok(guides.entries.every((e) => e.entityType === "guide"));
  assert.ok(guides.entries.some((e) => e.actorEmail?.startsWith("audit-admin-")));

  const p1 = await m.audit.listAdminAudit({ pageSize: 3, page: 1 });
  const p2 = await m.audit.listAdminAudit({ pageSize: 3, page: 2 });
  assert.equal(p1.entries.length, 3);
  assert.equal(p1.pageCount, Math.ceil(all.total / 3));
  assert.ok(p1.entries[0].createdAt >= p1.entries[2].createdAt);
  assert.notEqual(p1.entries[0].id, p2.entries[0].id);

  // Unknown filter is ignored; out-of-range page is clamped.
  assert.equal((await m.audit.listAdminAudit({ entityType: "bogus" })).total, all.total);
  assert.equal((await m.audit.listAdminAudit({ page: 9999, pageSize: 3 })).page, p1.pageCount);
});

test("recordAdminAudit logs and returns false instead of throwing on failure", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const ok = await m.audit.recordAdminAudit({
    actorId: adminId,
    action: "guide.publish",
    entityType: "guide",
    entityId: "x",
    details: { n: 1 },
  });
  assert.equal(ok, true);
  const bad = await m.audit.recordAdminAudit({
    actorId: null as unknown as string, // violates NOT NULL
    action: "guide.publish",
    entityType: "guide",
    entityId: "x",
  });
  assert.equal(bad, false);
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(logged.mock.calls[0].arguments[0], "admin_audit_write_failed");
});
