import "./helpers/env";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import { adminAuditLog, certificates, courses, enrollments, getDb, users } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings, getD1Database, setD1DatabaseForTest, clearD1DatabaseForTest } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import { createCourse, createLesson, createSection, publishCourse, publishLesson, updateCourse, archiveCourse } from "../src/features/courses/service";
import { enrollFree } from "../src/features/enrollments/service";
import { markLessonComplete } from "../src/features/progress/service";
import { claimCertificate, getPublicCertificate, listCourseCertificates, listLearnerCertificates, mutateCertificate } from "../src/features/certificates/service";
import { generateCertificateId, isCertificateId, recipientNameSchema } from "../src/features/certificates/types";
import { staticRoutes } from "../src/lib/public-routes";
import { buildSitemapEntries } from "../src/lib/sitemap-entries";

process.env.ADMIN_REQUIRE_2FA = "false";
const nodeRequire = createRequire(__filename);
let cookieHeader = "";
let learnerCookie = "";
let adminCookie = "";
let learnerId = "";
let adminId = "";
let actions: typeof import("../src/features/certificates/actions");
let courseActions: typeof import("../src/features/courses/actions");
const uid = () => crypto.randomUUID().slice(0, 8);
function stubModule(id: string, exports: Record<string, unknown>) {
  const resolved = nodeRequire.resolve(id);
  nodeRequire.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
}

async function account(admin: boolean) {
  const auth = await getAuth();
  const email = `certificate-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({ body: { email, password, name: "Certificate Learner" } });
  if (admin) await (await getDb()).update(users).set({ role: "admin" }).where(eq(users.id, created.user.id));
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return { id: created.user.id, cookie: signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") };
}

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn });
  const learner = await account(false);
  learnerId = learner.id; learnerCookie = learner.cookie;
  const admin = await account(true);
  adminId = admin.id; adminCookie = admin.cookie;
  actions = await import("../src/features/certificates/actions");
  courseActions = await import("../src/features/courses/actions");
});
test.after(async () => { await disposeCloudflareBindings(); });

async function fixture(complete = true, enabled = true) {
  const course = await createCourse({ title: "Certificate course", slug: `certificate-${uid()}`, certificateEnabled: enabled });
  const section = await createSection({ courseId: course.id, title: "Certificate section" });
  const lesson = await createLesson({ courseId: course.id, sectionId: section.id, title: "Certificate lesson", slug: `lesson-${uid()}`, required: true });
  await publishLesson(lesson.id);
  await publishCourse(course.id);
  const enrollment = await enrollFree(learnerId, course.id);
  if (complete) await markLessonComplete(learnerId, enrollment.id, lesson.id);
  return { course, enrollment };
}

test("ids have 26 base32 digits, 130 random bits and no duplicates in 10,000 runs", () => {
  const ids = new Set(Array.from({ length: 10000 }, generateCertificateId));
  assert.equal(ids.size, 10000);
  for (const id of ids) { assert.equal(id.length, 26); assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/); }
});

test("id validator rejects malformed, ambiguous, lowercase and non-string ids", () => {
  assert.equal(isCertificateId("0".repeat(26)), true);
  assert.equal(isCertificateId("Z".repeat(26)), true);
  for (const id of [null, 12, "", "A".repeat(25), "A".repeat(27), "a".repeat(26), "I".repeat(26), "O".repeat(26), "U".repeat(26), "L".repeat(26), "../", `${"A".repeat(26)}\n`]) assert.equal(isCertificateId(id), false);
});

test("name validation trims, bounds length and rejects control characters before trimming", () => {
  assert.equal(recipientNameSchema.parse("  Example Learner  "), "Example Learner");
  assert.equal(recipientNameSchema.parse("AB"), "AB");
  assert.equal(recipientNameSchema.parse("A".repeat(80)).length, 80);
  for (const name of [null, " ", "A", "A".repeat(81), "A\nB", "A\tB", "\tAB", "AB\r", "A\u0000B", "A\u007fB", "A\u0085B", "A\u200bB", "\u202eAB", "A\u2028B", "\u200b\u200b", "--"]) assert.equal(recipientNameSchema.safeParse(name).success, false);
  assert.equal(recipientNameSchema.parse("Zoë O'Brien-Ng"), "Zoë O'Brien-Ng");
  assert.equal(recipientNameSchema.parse("<b>Example</b>"), "<b>Example</b>");
});

test("claim action denies anonymous users and ignores forged user ids", async () => {
  const { course } = await fixture();
  cookieHeader = "";
  assert.equal((await actions.claimCertificateAction({ courseSlug: course.slug, recipientName: "Example Learner" })).ok, false);
  await assert.rejects(() => claimCertificate("", course.slug, "Example Learner"), /Sign in/);
  cookieHeader = adminCookie;
  assert.equal((await actions.claimCertificateAction({ userId: learnerId, courseSlug: course.slug, recipientName: "Example Learner" })).ok, false);
  assert.equal((await (await getDb()).select().from(certificates).where(eq(certificates.courseId, course.id))).length, 0);
});

test("eligibility rejects incomplete, disabled, unenrolled and cancelled enrollments", async () => {
  const incomplete = await fixture(false);
  const disabled = await fixture(true, false);
  const cancelled = await fixture();
  await (await getDb()).update(enrollments).set({ status: "cancelled" }).where(eq(enrollments.id, cancelled.enrollment.id));
  for (const f of [incomplete, disabled, cancelled]) await assert.rejects(() => claimCertificate(learnerId, f.course.slug, "Example Learner"));
  await assert.rejects(() => claimCertificate(adminId, incomplete.course.slug, "Example Learner"));
});

test("complete + enabled claim succeeds; repeat returns the immutable original", async () => {
  const { course, enrollment } = await fixture();
  cookieHeader = learnerCookie;
  const result = await actions.claimCertificateAction({ courseSlug: course.slug, recipientName: "  Example Learner  " });
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("Expected successful claim");
  const repeated = await claimCertificate(learnerId, course.slug, "Different Name");
  assert.equal(repeated.id, result.data.id);
  assert.equal(repeated.recipientName, "Example Learner");
  assert.equal(repeated.enrollmentId, enrollment.id);
  await updateCourse(course.id, { id: course.id, title: "Renamed course", certificateEnabled: false });
  assert.equal((await getPublicCertificate(repeated.id))?.courseTitle, "Certificate course");
  assert.equal((await getPublicCertificate(repeated.id))?.revokedAt, null);
});

test("archived course with completed enrollment can claim", async () => {
  const { course } = await fixture();
  await archiveCourse(course.id);
  assert.ok((await claimCertificate(learnerId, course.slug, "Archived Learner")).id);
});

test("concurrent claims converge on one row through the unique-constraint race", async () => {
  const { course } = await fixture();
  // Hold both pre-checks until they have read absence, forcing two inserts.
  const realD1 = await getD1Database();
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setD1DatabaseForTest({
    prepare(sql: string) {
      const statement = realD1.prepare(sql);
      if (!/^select .* from "certificates" where /i.test(sql)) return statement;
      return new Proxy(statement, { get(target, property) {
        if (property === "bind") return (...args: unknown[]) => {
          const bound = target.bind(...args);
          return new Proxy(bound, { get(inner, method) {
            if (method === "raw") return async (...rawArgs: Parameters<typeof inner.raw>) => {
              const result = await inner.raw(...rawArgs);
              if (++reads <= 2) { if (reads === 2) release(); await gate; }
              return result;
            };
            const value = Reflect.get(inner, method);
            return typeof value === "function" ? value.bind(inner) : value;
          } });
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
    batch: realD1.batch.bind(realD1),
  } as unknown as Parameters<typeof setD1DatabaseForTest>[0]);
  try {
    const [a, b] = await Promise.all([claimCertificate(learnerId, course.slug, "Race One"), claimCertificate(learnerId, course.slug, "Race Two")]);
    assert.equal(a.id, b.id);
    assert.ok(reads >= 3, "expected two absent reads and winner lookup after unique error");
  } finally { clearD1DatabaseForTest(); }
  const rows = await (await getDb()).select().from(certificates).where(eq(certificates.courseId, course.id));
  assert.equal(rows.length, 1);
});

test("public lookup exposes only printed fields and unknown ids return null", async () => {
  const { course } = await fixture();
  const issued = await claimCertificate(learnerId, course.slug, "Verify Learner");
  const publicRow = await getPublicCertificate(issued.id);
  assert.equal(publicRow?.revokedAt, null);
  assert.equal(publicRow?.recipientName, "Verify Learner");
  assert.deepEqual(Object.keys(publicRow!).sort(), ["courseTitle", "id", "issuedAt", "recipientName", "revokedAt", "revokedReason"]);
  assert.equal(await getPublicCertificate(generateCertificateId()), null);
});

test("malformed verify ids are rejected before accessing D1", async () => {
  const realD1 = await getD1Database();
  let queries = 0;
  setD1DatabaseForTest({ prepare(sql: string) { queries++; return realD1.prepare(sql); }, batch: realD1.batch.bind(realD1) } as unknown as Parameters<typeof setD1DatabaseForTest>[0]);
  try {
    for (const id of ["bad", "I".repeat(26), "a".repeat(26)]) assert.equal(await getPublicCertificate(id), null);
    assert.equal(queries, 0);
  } finally { clearD1DatabaseForTest(); }
});

test("revoke, restore and name correction require admin and write audit rows", async () => {
  const { course } = await fixture();
  const certificate = await claimCertificate(learnerId, course.slug, "Original Learner");
  const operations = [
    { id: certificate.id, operation: "revoke", reason: "<b>Review required</b>" },
    { id: certificate.id, operation: "restore" },
    { id: certificate.id, operation: "edit", recipientName: "  Corrected Learner  " },
  ];
  for (const cookie of ["", learnerCookie]) {
    cookieHeader = cookie;
    for (const input of operations) assert.equal((await actions.mutateCertificateAction(input)).ok, false);
    await assert.rejects(() => listCourseCertificates(course.id, 1));
  }
  cookieHeader = adminCookie;
  for (const input of operations) {
    const result = await actions.mutateCertificateAction(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    const row = await getPublicCertificate(certificate.id);
    if (input.operation === "revoke") {
      assert.ok(row?.revokedAt); assert.equal(row?.revokedReason, "<b>Review required</b>");
      const repeated = await claimCertificate(learnerId, course.slug, "Replacement Name");
      assert.equal(repeated.id, certificate.id);
      assert.ok(repeated.revokedAt, "claiming again cannot bypass revocation");
    }
    if (input.operation === "restore") { assert.equal(row?.revokedAt, null); assert.equal(row?.revokedReason, null); }
  }
  assert.equal((await getPublicCertificate(certificate.id))?.recipientName, "Corrected Learner");
  const audit = await (await getDb()).select().from(adminAuditLog).where(and(eq(adminAuditLog.entityType, "certificate"), eq(adminAuditLog.entityId, certificate.id)));
  assert.deepEqual(audit.map((row) => row.action).sort(), ["certificate.edit", "certificate.restore", "certificate.revoke"]);
  assert.ok(audit.every((row) => row.actorId === adminId));
  assert.ok(audit.every((row) => !row.details?.includes("Learner")), "name corrections are not copied into audit details");
});

test("invalid admin mutations and unknown certificate write no audit rows", async () => {
  cookieHeader = adminCookie;
  const { course } = await fixture();
  const certificate = await claimCertificate(learnerId, course.slug, "Valid Learner");
  for (const input of [
    { id: certificate.id, operation: "revoke", reason: " " },
    { id: certificate.id, operation: "revoke", reason: "A".repeat(201) },
    { id: certificate.id, operation: "edit", recipientName: "X" },
    { id: certificate.id, operation: "invalid" },
    { id: generateCertificateId(), operation: "restore" },
  ]) await assert.rejects(() => mutateCertificate(input));
  const audit = await (await getDb()).select().from(adminAuditLog).where(eq(adminAuditLog.entityId, certificate.id));
  assert.equal(audit.length, 0);
});

test("course toggle is admin-only and audited on create and update", async () => {
  cookieHeader = learnerCookie;
  assert.equal((await courseActions.createCourseAction({ title: "No permission", slug: `denied-${uid()}`, certificateEnabled: true })).ok, false);
  cookieHeader = adminCookie;
  const created = await courseActions.createCourseAction({ title: "Toggle course", slug: `toggle-${uid()}`, certificateEnabled: true });
  assert.equal(created.ok, true);
  const id = created.data!.id;
  const updated = await courseActions.updateCourseAction({ id, certificateEnabled: false });
  assert.equal(updated.ok, true);
  const rows = await (await getDb()).select().from(adminAuditLog).where(eq(adminAuditLog.entityId, id));
  assert.deepEqual(rows.map((row) => JSON.parse(row.details!).certificateEnabled), [true, false]);
  assert.equal((await (await getDb()).select().from(courses).where(eq(courses.id, id)).get())?.certificateEnabled, false);
});

test("learner listing is private to its owner and Studio pagination is bounded", async () => {
  const { course, enrollment } = await fixture();
  const db = await getDb();
  // Separate synthetic owners keep the unique user/course key intact.
  for (let n = 0; n < 27; n++) {
    const id = `cert-owner-${uid()}`;
    await db.insert(users).values({ id, name: "Fixture Learner", email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const enrollmentId = `cert-enrollment-${uid()}`;
    await db.insert(enrollments).values({ id: enrollmentId, userId: id, courseId: course.id, enrolledAt: new Date(), status: "completed" });
    await db.insert(certificates).values({ id: generateCertificateId(), userId: id, courseId: course.id, enrollmentId, recipientName: "Fixture Learner", courseTitle: course.title, issuedAt: new Date() });
  }
  assert.ok(enrollment.id);
  assert.equal((await listLearnerCertificates(adminId)).length, 0);
  const ownCertificate = await claimCertificate(learnerId, course.slug, "Owner Learner");
  const realD1 = await getD1Database();
  let queries = 0;
  setD1DatabaseForTest({ prepare(sql: string) { queries++; return realD1.prepare(sql); }, batch: realD1.batch.bind(realD1) } as unknown as Parameters<typeof setD1DatabaseForTest>[0]);
  try {
    const own = await listLearnerCertificates(learnerId);
    assert.ok(own.some((row) => row.id === ownCertificate.id));
    assert.equal(queries, 1, "dashboard certificate list must use one query");
    const foreignIds = new Set((await db.select({ id: certificates.id }).from(certificates).where(eq(certificates.courseId, course.id))).map((row) => row.id));
    assert.deepEqual(own.filter((row) => foreignIds.has(row.id)).map((row) => row.id), [ownCertificate.id]);
  } finally { clearD1DatabaseForTest(); }
  cookieHeader = adminCookie;
  const first = await listCourseCertificates(course.id, 1);
  const second = await listCourseCertificates(course.id, 2);
  assert.equal(first.length, 26); // one extra row for next-page detection
  assert.equal(second.length, 3);
  assert.ok(!first.slice(0, 25).some((row) => second.some((other) => other.id === row.id)));
});

test("certificate URLs stay out of the sitemap and prewarm allowlist", async () => {
  assert.ok(staticRoutes.every((route) => !route.startsWith("/certificates")));
  assert.ok((await buildSitemapEntries()).every((entry) => !entry.url.includes("/certificates/")));
});
