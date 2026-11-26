/**
 * AI COURSE OUTLINE (Studio curriculum: draft outline with AI)
 * ---------------------------------------------------------------------------
 * Covers: admin-only actions (signed-out / learner / admin), brief
 * validation, FakeProvider deterministic + grounded generation, bad model
 * output failing cleanly, unknown source ids dropped, apply appending drafts
 * in order without touching existing rows, and audit writing for both
 * generation and creation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.
import { markEmailVerified } from "./helpers/verified";
// These admins have no 2FA enrolled; the 2FA gate itself is covered by
// tests/admin-two-factor.test.ts.
process.env.ADMIN_REQUIRE_2FA = "false";
process.env.EDITORIAL_FORCE_FAKE_PROVIDER = "1";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import {
  adminAuditLog,
  courseSections,
  courses,
  getDb,
  knowledge_chunks,
  knowledge_sources,
  lessons,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings, getR2Bucket } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import { uploadKnowledgeSource } from "../src/features/editorial-ai/knowledge/storage";
import { ingestKnowledgeSource } from "../src/features/editorial-ai/knowledge/service";
import { createLesson, createSection } from "../src/features/courses/service";
import { createCourse } from "../src/features/courses/service";
import {
  applyCourseOutline,
  draftCourseOutline,
} from "../src/features/course-outline/service";
import { FakeProvider } from "../src/features/editorial-ai/providers/fake";

const nodeRequire = createRequire(__filename);
let cookieHeader = "";

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
let adminCookie = "";
let learnerCookie = "";
const createdCourseIds: string[] = [];
const createdSourceIds: string[] = [];

type Mods = {
  outline: typeof import("../src/features/course-outline/actions");
};
let m: Mods;

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", {
    revalidatePath: () => {},
    revalidateTag: () => {},
    unstable_cache: <T>(fn: T) => fn,
  });

  const auth = await getAuth();
  async function makeUser(email: string, role: "admin" | "user"): Promise<{ id: string; cookie: string }> {
    const created = await auth.api.signUpEmail({
      body: { email, password: "OutlineTestPass123!", name: "Outline User" },
    });
    const db = await getDb();
    if (role === "admin") {
      await db.update((await import("../src/lib/db")).users).set({ role: "admin" }).where(eq((await import("../src/lib/db")).users.id, created.user.id));
    }
    await markEmailVerified(created.user.id);
    const signIn = await auth.api.signInEmail({ body: { email, password: "OutlineTestPass123!" }, returnHeaders: true });
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    assert.ok(cookie, "sign-in must yield a session cookie");
    return { id: created.user.id, cookie };
  }

  const admin = await makeUser(`outline-admin-${uid()}@example.com`, "admin");
  adminId = admin.id;
  adminCookie = admin.cookie;
  const learner = await makeUser(`outline-learner-${uid()}@example.com`, "user");
  learnerCookie = learner.cookie;

  m = { outline: await import("../src/features/course-outline/actions") };
});

test.after(async () => {
  const db = await getDb();
  for (const id of createdCourseIds) {
    await db.delete(courses).where(eq(courses.id, id));
  }
  await db.delete(adminAuditLog);
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
  await disposeCloudflareBindings();
});

async function seedKnowledge(topicWord: string, title: string): Promise<string> {
  const content =
    `## ${title}\n\n${topicWord} practices shape how teams hire and grow. ` +
    `First, define the ${topicWord} scorecard before any interview. ` +
    `Second, run a structured ${topicWord} panel with the same questions. ` +
    `Third, review ${topicWord} evidence the same day and decide fast. ` +
    `Marker ${uid()} keeps this upload unique.`;
  const buffer = new TextEncoder().encode(content).buffer;
  const result = await uploadKnowledgeSource({
    buffer, filename: "doc.md", contentType: "text/markdown",
    title, createdBy: "test-admin",
  });
  createdSourceIds.push(result.id);
  await ingestKnowledgeSource(result.id, "test-admin");
  return result.id;
}

async function makeCourse(suffix: string) {
  const course = await createCourse({ title: `Outline course ${suffix}`, slug: `outline-${suffix}` });
  createdCourseIds.push(course.id);
  return course;
}

// ---------------------------------------------------------------------------
// Authorization + validation (action level)
// ---------------------------------------------------------------------------

test("signed-out visitors cannot draft or apply", async () => {
  cookieHeader = "";
  const course = await makeCourse(uid());
  const drafted = await m.outline.draftOutlineAction({ courseId: course.id, topic: "Hiring loops" });
  assert.equal(drafted.ok, false);
  assert.match(drafted.error!, /signed in/i);
  const applied = await m.outline.applyOutlineAction({
    courseId: course.id,
    sections: [{ title: "S", lessons: [{ title: "L", summary: "Sum" }] }],
  });
  assert.equal(applied.ok, false);
  assert.match(applied.error!, /signed in/i);
});

test("learners cannot draft or apply (admin-only)", async () => {
  cookieHeader = learnerCookie;
  const course = await makeCourse(uid());
  const drafted = await m.outline.draftOutlineAction({ courseId: course.id, topic: "Hiring loops" });
  assert.equal(drafted.ok, false);
  assert.match(drafted.error!, /admin/i);
  const applied = await m.outline.applyOutlineAction({
    courseId: course.id,
    sections: [{ title: "S", lessons: [{ title: "L", summary: "Sum" }] }],
  });
  assert.equal(applied.ok, false);
  assert.match(applied.error!, /admin/i);
});

test("brief validation rejects a short topic", async () => {
  cookieHeader = adminCookie;
  const course = await makeCourse(uid());
  const res = await m.outline.draftOutlineAction({ courseId: course.id, topic: "ab" });
  assert.equal(res.ok, false);
  assert.match(res.error!, /at least 3 characters/i);
});

test("drafting for a missing course fails cleanly", async () => {
  cookieHeader = adminCookie;
  const res = await m.outline.draftOutlineAction({ courseId: `missing-${uid()}`, topic: "Hiring loops" });
  assert.equal(res.ok, false);
  assert.match(res.error!, /not found/i);
});

// ---------------------------------------------------------------------------
// Generation (service level, FakeProvider)
// ---------------------------------------------------------------------------

test("fake generation is deterministic and grounded in retrieved sources", async () => {
  const word = `scorecard${uid()}`;
  const course = await makeCourse(uid());
  await seedKnowledge(word, `Grounded ${word}`);
  const brief = { courseId: course.id, topic: word, audience: "Hiring managers" };

  const first = await draftCourseOutline(brief, adminId, { provider: new FakeProvider() });
  const second = await draftCourseOutline(brief, adminId, { provider: new FakeProvider() });
  assert.deepEqual(first.sections, second.sections, "fake outline must be deterministic");

  assert.ok(first.sections.length >= 1 && first.sections.length <= 12);
  const known = new Set(first.sources.map((s) => s.sourceId));
  assert.ok(known.size > 0, "outline must cite retrieved sources");
  for (const section of first.sections) {
    assert.ok(section.title.length >= 1 && section.title.length <= 160);
    assert.ok(!/<[^>]*>/.test(section.title), "titles must be plain text");
    for (const lesson of section.lessons) {
      assert.ok(lesson.title.length >= 1 && lesson.title.length <= 160);
      assert.ok(lesson.summary.length >= 1 && lesson.summary.length <= 500);
      assert.ok(
        lesson.durationMinutes === null ||
          (Number.isInteger(lesson.durationMinutes) && lesson.durationMinutes >= 1 && lesson.durationMinutes <= 600),
      );
      for (const id of lesson.sourceIds) assert.ok(known.has(id), `cited source ${id} must be retrieved`);
    }
  }
});

test("bad model output fails with a user-safe error", async () => {
  const word = `garbage${uid()}`;
  const course = await makeCourse(uid());
  await seedKnowledge(word, `Garbage ${word}`);
  const brief = { courseId: course.id, topic: word };

  await assert.rejects(
    () => draftCourseOutline(brief, adminId, { generateRawJson: async () => ({ bogus: 1 }) }),
    /could not use/i,
  );
  await assert.rejects(
    () =>
      draftCourseOutline(brief, adminId, {
        generateRawJson: async () => ({
          sections: [{ title: "<br>", lessons: [{ title: "<br>", summary: "<br>", durationMinutes: 5, sourceIds: [] }] }],
        }),
      }),
    /empty after safety checks/i,
  );
});

test("unknown cited source ids are dropped, known ones kept", async () => {
  const word = `grounding${uid()}`;
  const course = await makeCourse(uid());
  const realSourceId = await seedKnowledge(word, `Grounding ${word}`);
  const brief = { courseId: course.id, topic: word };

  const draft = await draftCourseOutline(brief, adminId, {
    generateRawJson: async () => ({
      sections: [
        {
          title: "Section <b>one</b>",
          lessons: [
            {
              title: "Lesson <script>alert(1)</script>one",
              summary: "A <em>plain</em> summary sentence.",
              durationMinutes: 9999,
              sourceIds: [realSourceId, "ks_doesnotexist"],
            },
          ],
        },
      ],
    }),
  });
  assert.equal(draft.sections.length, 1);
  const lesson = draft.sections[0]!.lessons[0]!;
  assert.equal(lesson.title, "Lesson alert(1)one");
  assert.equal(lesson.summary, "A plain summary sentence.");
  assert.equal(lesson.durationMinutes, null, "out-of-range durations become null");
  assert.deepEqual(lesson.sourceIds, [realSourceId]);
});

test("no retrieved evidence fails with a clear message", async () => {
  const course = await makeCourse(uid());
  await assert.rejects(
    () =>
      draftCourseOutline(
        { courseId: course.id, topic: `nothingcovers${uid()} xyzzy` },
        adminId,
        { provider: new FakeProvider() },
      ),
    /No relevant evidence/i,
  );
});

test("missing provider key fails closed with a clear error", async () => {
  const word = `nokey${uid()}`;
  const course = await makeCourse(uid());
  await seedKnowledge(word, `No key ${word}`);
  const saved = {
    baseUrl: process.env.EDITORIAL_MODEL_BASE_URL,
    apiKey: process.env.EDITORIAL_MODEL_API_KEY,
    modelName: process.env.EDITORIAL_MODEL_NAME,
  };
  delete process.env.EDITORIAL_MODEL_BASE_URL;
  delete process.env.EDITORIAL_MODEL_API_KEY;
  delete process.env.EDITORIAL_MODEL_NAME;
  try {
    await assert.rejects(
      () => draftCourseOutline({ courseId: course.id, topic: word }, adminId),
      /no provider key/i,
    );
  } finally {
    if (saved.baseUrl !== undefined) process.env.EDITORIAL_MODEL_BASE_URL = saved.baseUrl;
    if (saved.apiKey !== undefined) process.env.EDITORIAL_MODEL_API_KEY = saved.apiKey;
    if (saved.modelName !== undefined) process.env.EDITORIAL_MODEL_NAME = saved.modelName;
  }
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

test("apply appends drafts in order without touching existing rows", async () => {
  const course = await makeCourse(uid());
  const existing = await createSection({ courseId: course.id, title: "Existing section" });
  const existingLesson = await createLesson({
    courseId: course.id,
    sectionId: existing.id,
    title: "Existing lesson",
    slug: `existing-${uid()}`,
    body: [],
    required: true,
  });
  const beforeSection = { ...existing };
  const beforeLesson = { ...existingLesson };

  const result = await applyCourseOutline(
    {
      courseId: course.id,
      sections: [
        {
          title: "New <b>section</b> one",
          lessons: [
            { title: "Same title", summary: "First summary.", durationMinutes: 20 },
            { title: "Same title", summary: "Second summary.", durationMinutes: null },
          ],
        },
        {
          title: "New section two",
          lessons: [{ title: "Solo lesson", summary: "Solo summary.", durationMinutes: 600 }],
        },
      ],
    },
    adminId,
  );
  assert.equal(result.sectionCount, 2);
  assert.equal(result.lessonCount, 3);

  const db = await getDb();
  const sections = await db
    .select()
    .from(courseSections)
    .where(eq(courseSections.courseId, course.id))
    .orderBy(courseSections.position);
  assert.equal(sections.length, 3);
  assert.equal(sections[0]!.id, existing.id, "existing section stays first");
  assert.equal(sections[0]!.title, beforeSection.title);
  assert.deepEqual(
    sections.slice(1).map((s) => s.title),
    ["New section one", "New section two"],
    "HTML stripped from applied titles",
  );
  assert.ok(sections[1]!.position > sections[0]!.position);
  assert.ok(sections[2]!.position > sections[1]!.position);

  const allLessons = await db.select().from(lessons).where(eq(lessons.courseId, course.id));
  const untouched = allLessons.find((l) => l.id === existingLesson.id)!;
  assert.equal(untouched.title, beforeLesson.title);
  assert.equal(untouched.body, beforeLesson.body);
  assert.equal(untouched.position, beforeLesson.position);

  const created = allLessons.filter((l) => result.lessonIds.includes(l.id));
  assert.equal(created.length, 3);
  for (const lesson of created) {
    assert.equal(lesson.status, "draft", "applied lessons are unpublished");
    const blocks = JSON.parse(lesson.body) as Array<{ type: string; text: string }>;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.type, "paragraph");
  }
  const summaries = created.map((l) => (JSON.parse(l.body) as Array<{ text: string }>)[0]!.text).sort();
  assert.deepEqual(summaries, ["First summary.", "Second summary.", "Solo summary."].sort());
  const slugs = created.map((l) => l.slug);
  assert.equal(new Set(slugs).size, 3, "duplicate titles get unique slugs");
  assert.ok(created.find((l) => l.title === "Solo lesson")!.durationMinutes === 600);
});

test("generation and apply each write an admin audit row", async () => {
  cookieHeader = adminCookie;
  const word = `audit${uid()}`;
  const course = await makeCourse(uid());
  await seedKnowledge(word, `Audit ${word}`);

  const drafted = await m.outline.draftOutlineAction({ courseId: course.id, topic: word });
  assert.ok(drafted.ok, !drafted.ok ? drafted.error : "expected draft to succeed");
  const applied = await m.outline.applyOutlineAction({
    courseId: course.id,
    sections: [
      {
        title: drafted.data!.sections[0]!.title,
        lessons: [
          {
            title: drafted.data!.sections[0]!.lessons[0]!.title,
            summary: drafted.data!.sections[0]!.lessons[0]!.summary,
            durationMinutes: drafted.data!.sections[0]!.lessons[0]!.durationMinutes,
          },
        ],
      },
    ],
  });
  assert.ok(applied.ok, !applied.ok ? applied.error : "expected apply to succeed");

  const db = await getDb();
  const rows = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityType, "course"), eq(adminAuditLog.entityId, course.id)));
  assert.deepEqual(
    rows.map((r) => r.action).sort(),
    ["course.ai_outline_apply", "course.ai_outline_generate"],
  );
  assert.ok(rows.every((r) => r.actorId === adminId));
  const appliedRow = rows.find((r) => r.action === "course.ai_outline_apply")!;
  assert.equal(JSON.parse(appliedRow.details!).lessons, 1);
});

test("draft rate limit allows 20 per hour then refuses", async () => {
  const word = `ratelimit${uid()}`;
  const course = await makeCourse(uid());
  await seedKnowledge(word, `Rate ${word}`);
  const actor = `rate-admin-${uid()}`;
  const brief = { courseId: course.id, topic: word };
  for (let i = 0; i < 20; i++) {
    await draftCourseOutline(brief, actor, { provider: new FakeProvider() });
  }
  await assert.rejects(
    () => draftCourseOutline(brief, actor, { provider: new FakeProvider() }),
    /limit reached/i,
  );
});
