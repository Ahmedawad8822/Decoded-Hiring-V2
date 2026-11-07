import "./helpers/env";
process.env.ADMIN_REQUIRE_2FA = "false";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { getDb, users, lessons, enrollments } from "../src/lib/db";
import { getAuth } from "../src/lib/auth";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  disposeCloudflareBindings, getD1Database, setD1DatabaseForTest, clearD1DatabaseForTest,
} from "../src/lib/cloudflare/bindings";
import { prepareCourseContent, prepareLessonContent } from "../src/features/courses/content-data";
import * as service from "../src/features/courses/service";
import { enrollFree } from "../src/features/enrollments/service";
import { getEnrollmentProgress, markLessonComplete } from "../src/features/progress/service";

// Next's incremental cache needs a running Next server. This suite tests real
// D1 preparation and real authenticated actions/pages, with a deterministic
// cache double ONLY for Next request-scope APIs (same seam as admin-audit-trail).
// It proves keys/tags/invalidation wiring, not Next/OpenNext cache internals.
const nodeRequire = createRequire(__filename);
const uid = () => crypto.randomUUID().slice(0, 8);
let cookieHeader = "";
let adminCookie = "";
let learnerCookie = "";
let strangerCookie = "";
let learnerId = "";
let strangerId = "";
const entries = new Map<string, { value: string; tags: string[] }>();
const invalidations: { tag: string; profile: unknown }[] = [];
let cacheCalls = 0;
let cacheMisses = 0;

function stubModule(id: string, exports: Record<string, unknown>) {
  const resolved = nodeRequire.resolve(id);
  nodeRequire.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [],
  } as unknown as NodeJS.Module;
}

let actions: typeof import("../src/features/courses/actions");
let cached: typeof import("../src/features/courses/content-cache");
let upload: typeof import("../src/app/api/course-resources/upload/route");
let lessonPage: typeof import("../src/app/learn/courses/[courseSlug]/lessons/[lessonSlug]/page");
let overview: typeof import("../src/app/learn/courses/[courseSlug]/page");

async function makeSession(admin = false) {
  const auth = await getAuth();
  const email = `cache-${uid()}@example.com`;
  const password = "LessonCachePass123!";
  const { user } = await auth.api.signUpEmail({ body: { email, password, name: "Cache Test" } });
  if (admin) await (await getDb()).update(users).set({ role: "admin" }).where(eq(users.id, user.id));
  const signedIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return { id: user.id, cookie: signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}

test.before(async () => {
  await migrateLocalDb();
  // Confirm why the real API is not used by this tsx suite.
  await assert.rejects(nodeRequire("next/cache").unstable_cache(async () => null)(), /incrementalCache missing/);
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", {
    revalidatePath: () => {},
    revalidateTag: (tag: string, profile: unknown) => {
      invalidations.push({ tag, profile });
      for (const [key, entry] of entries) if (entry.tags.includes(tag)) entries.delete(key);
    },
    unstable_cache: <A extends unknown[], R>(fn: (...args: A) => Promise<R>, keys: string[], opts: { tags: string[]; revalidate: boolean }) => {
      assert.equal(opts.revalidate, false, "shared cache has no timed stale window");
      return async (...args: A): Promise<R> => {
        cacheCalls++;
        const key = JSON.stringify([keys, args]);
        const hit = entries.get(key);
        if (hit) return JSON.parse(hit.value);
        cacheMisses++;
        const value = await fn(...args);
        entries.set(key, { value: JSON.stringify(value), tags: opts.tags });
        return value;
      };
    },
  });
  // Redirect/404 control flow only. Components are invoked, not browser-rendered.
  const navigation = nodeRequire("next/navigation");
  stubModule("next/navigation", {
    ...navigation,
    notFound: () => { throw new Error("TEST_NOT_FOUND"); },
    permanentRedirect: (url: string) => { throw new Error(`TEST_REDIRECT:${url}`); },
  });
  adminCookie = (await makeSession(true)).cookie;
  ({ id: learnerId, cookie: learnerCookie } = await makeSession());
  ({ id: strangerId, cookie: strangerCookie } = await makeSession());
  cookieHeader = adminCookie;
  actions = await import("../src/features/courses/actions");
  cached = await import("../src/features/courses/content-cache");
  upload = await import("../src/app/api/course-resources/upload/route");
  lessonPage = await import("../src/app/learn/courses/[courseSlug]/lessons/[lessonSlug]/page");
  overview = await import("../src/app/learn/courses/[courseSlug]/page");
});

test.after(async () => { await disposeCloudflareBindings(); });

function success<T>(result: { ok: boolean; data?: T; error?: string }): T {
  assert.equal(result.ok, true, result.error ?? "Action failed");
  return result.data!;
}
function assertTags(start: number, courseId: string, lessonId?: string) {
  assert.deepEqual(invalidations.slice(start), [
    { tag: `course:${courseId}`, profile: { expire: 0 } },
    ...(lessonId ? [{ tag: `lesson:${lessonId}`, profile: { expire: 0 } }] : []),
  ]);
}
async function checked<T>(courseId: string, lessonId: string | undefined, run: () => Promise<T>) {
  const start = invalidations.length;
  const result = await run();
  assertTags(start, courseId, lessonId);
  return result;
}
const body = (text: string) => [{ id: "body", type: "paragraph" as const, text }];

async function fixture(published = true) {
  cookieHeader = adminCookie;
  const course = success(await actions.createCourseAction({ title: "Cache Course", slug: `cache-${uid()}` }));
  const section = success(await checked(course.id, undefined, () => actions.createSectionAction({ courseId: course.id, title: "First section" })));
  const start = invalidations.length;
  const lesson = success(await actions.createLessonAction({
    courseId: course.id, sectionId: section.id, title: "Cache Lesson", slug: `lesson-${uid()}`, body: body("Original **body**"), videoUrl: "https://youtu.be/dQw4w9WgXcQ",
  })).id;
  assertTags(start, course.id, lesson);
  if (published) success(await checked(course.id, lesson, () => actions.publishLessonAction(lesson)));
  success(await checked(course.id, undefined, () => actions.publishCourseAction(course.id)));
  const row = (await service.getAdminLessonById(lesson))!;
  return { course, section, lesson: row };
}

test("lesson edit, publish and unpublish expire parsed content and curriculum immediately", async () => {
  const { course, lesson } = await fixture(false);
  assert.equal(await cached.getCachedLessonContent(course.id, lesson.id), null);
  assert.equal((await cached.getCachedCourseContent(course.id)).publishedLessons.length, 0);
  success(await checked(course.id, lesson.id, () => actions.publishLessonAction(lesson.id)));
  const first = await cached.getCachedLessonContent(course.id, lesson.id);
  assert.deepEqual(first?.blocks, body("Original **body**"));
  assert.match(first!.embedUrl!, /youtube-nocookie.com/);
  const misses = cacheMisses;
  assert.deepEqual(await cached.getCachedLessonContent(course.id, lesson.id), first);
  assert.equal(cacheMisses, misses, "repeat request uses same learner-independent key");
  const entry = [...entries.values()].find((e) => e.tags.includes(`lesson:${lesson.id}`))!;
  assert.deepEqual(entry.tags, [`course:${course.id}`, `lesson:${lesson.id}`]);
  assert.ok(!entry.value.includes('"body":'), "raw JSON body is not retained");

  success(await checked(course.id, lesson.id, () => actions.updateLessonAction({
    id: lesson.id, title: "Edited lesson", slug: `renamed-${uid()}`, body: body("Edited body"), videoUrl: null,
  })));
  const edited = await cached.getCachedLessonContent(course.id, lesson.id);
  assert.deepEqual(edited?.blocks, body("Edited body"));
  assert.equal(edited?.embedUrl, null);
  assert.equal((await cached.getCachedCourseContent(course.id)).publishedLessons[0].title, "Edited lesson");
  assert.equal(await service.getPublishedLessonIdentityBySlug(course.id, lesson.slug), null, "old slug gate stays live");

  success(await checked(course.id, lesson.id, () => actions.unpublishLessonAction(lesson.id)));
  assert.equal(await cached.getCachedLessonContent(course.id, lesson.id), null);
  assert.equal((await cached.getCachedCourseContent(course.id)).publishedLessons.length, 0);
  assert.equal(await prepareLessonContent(course.id, lesson.id), null);
});

test("all course and section writes invalidate shared overview/navigation", async () => {
  const start = invalidations.length;
  const { course, section } = await fixture();
  assert.deepEqual(invalidations[start], { tag: `course:${course.id}`, profile: { expire: 0 } });
  await cached.getCachedCourseContent(course.id);
  success(await checked(course.id, undefined, () => actions.updateCourseAction({ id: course.id, title: "Renamed course", slug: `renamed-${uid()}` })));
  assert.equal((await service.getAdminCourseById(course.id))?.title, "Renamed course");
  success(await checked(course.id, undefined, () => actions.renameSectionAction({ id: section.id, title: "Renamed section" })));
  assert.equal((await cached.getCachedCourseContent(course.id)).curriculum[0].section.title, "Renamed section");
  const second = success(await checked(course.id, undefined, () => actions.createSectionAction({ courseId: course.id, title: "Second section" })));
  success(await checked(course.id, undefined, () => actions.moveSectionAction(second.id, "up")));
  assert.equal((await cached.getCachedCourseContent(course.id)).curriculum[0].section.id, second.id);
  success(await checked(course.id, undefined, () => actions.unpublishCourseAction(course.id)));
  assert.equal(await service.getLearnerCourseBySlug(course.slug, learnerId), null);
  success(await checked(course.id, undefined, () => actions.publishCourseAction(course.id)));
  success(await checked(course.id, undefined, () => actions.archiveCourseAction(course.id)));
});

test("lesson moves invalidate course ordering and required edits refresh progress input", async () => {
  const { course, section, lesson } = await fixture();
  const start = invalidations.length;
  const second = success(await actions.createLessonAction({ courseId: course.id, sectionId: section.id, title: "Second lesson", slug: `second-${uid()}` }));
  assertTags(start, course.id, second.id);
  success(await checked(course.id, second.id, () => actions.publishLessonAction(second.id)));
  const before = await cached.getCachedCourseContent(course.id);
  assert.equal(before.navigation[lesson.id].next?.id, second.id);
  success(await checked(course.id, second.id, () => actions.moveLessonAction(second.id, "up")));
  const moved = await cached.getCachedCourseContent(course.id);
  assert.equal(moved.navigation[second.id].position, 1);
  assert.equal(moved.navigation[lesson.id].prev?.id, second.id);
  success(await checked(course.id, second.id, () => actions.updateLessonAction({ id: second.id, required: false })));
  assert.equal((await cached.getCachedCourseContent(course.id)).publishedLessons[0].required, false);
});

test("PDF upload invalidates the prepared resource list (download stays private)", async () => {
  const { course, lesson } = await fixture();
  assert.deepEqual((await cached.getCachedLessonContent(course.id, lesson.id))?.resources, []);
  const form = new FormData();
  form.set("file", new File(["%PDF-1.7\ncache test"], "worksheet.pdf", { type: "application/pdf" }));
  form.set("courseId", course.id);
  form.set("lessonId", lesson.id);
  form.set("title", "Worksheet");
  const response = await checked(course.id, lesson.id, () => upload.POST(new Request("http://localhost/api/course-resources/upload", { method: "POST", body: form })));
  assert.equal(response.status, 201, await response.clone().text());
  const resources = (await cached.getCachedLessonContent(course.id, lesson.id))!.resources;
  assert.equal(resources[0].title, "Worksheet");
  assert.deepEqual(Object.keys(resources[0]).sort(), ["id", "sizeLabel", "title"]);
});

async function pageFor(courseSlug: string, lessonSlug: string) {
  return lessonPage.default({ params: Promise.resolve({ courseSlug, lessonSlug }) });
}
function textInTree(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textInTree).join(" ");
  if (node && typeof node === "object" && "props" in node) {
    return textInTree((node.props as { children?: unknown }).children);
  }
  return "";
}

test("warm caches never bypass anonymous, non-enrolled or cancelled learner gates", async () => {
  const { course, lesson } = await fixture();
  await enrollFree(learnerId, course.id);
  cookieHeader = learnerCookie;
  await pageFor(course.slug, lesson.slug); // warm from a real entitled session
  for (const cookie of ["", strangerCookie]) {
    cookieHeader = cookie;
    const before = cacheCalls;
    const denied = await pageFor(course.slug, lesson.slug);
    assert.match(textInTree(denied), /Enrollment required/);
    assert.equal(cacheCalls, before, "denied request never reads protected shared cache");
  }
  const cancelled = await enrollFree(strangerId, course.id);
  await (await getDb()).update(enrollments).set({ status: "cancelled" }).where(eq(enrollments.id, cancelled.id));
  cookieHeader = strangerCookie;
  assert.match(textInTree(await pageFor(course.slug, lesson.slug)), /Enrollment required/);
});

test("draft/archived lessons and draft courses fail live gates even with deliberately stale cache entries", async () => {
  const { course, lesson } = await fixture();
  await enrollFree(learnerId, course.id);
  cookieHeader = learnerCookie;
  await pageFor(course.slug, lesson.slug);
  const db = await getDb();
  // Bypass actions deliberately: proves publication is independently checked
  // per request, even if an invalidation is missing or the tag backend fails.
  for (const status of ["draft", "archived"] as const) {
    await db.update(lessons).set({ status }).where(eq(lessons.id, lesson.id));
    const before = cacheCalls;
    await assert.rejects(() => pageFor(course.slug, lesson.slug), /TEST_NOT_FOUND/);
    assert.equal(cacheCalls, before);
    assert.equal(await prepareLessonContent(course.id, lesson.id), null);
    assert.equal((await prepareCourseContent(course.id)).publishedLessons.length, 0);
  }
  await db.update(lessons).set({ status: "published" }).where(eq(lessons.id, lesson.id));
  cookieHeader = adminCookie;
  success(await actions.unpublishCourseAction(course.id));
  cookieHeader = learnerCookie;
  await assert.rejects(() => pageFor(course.slug, lesson.slug), /TEST_NOT_FOUND/);
  await assert.rejects(() => overview.default({ params: Promise.resolve({ courseSlug: course.slug }) }), /TEST_NOT_FOUND/);
});

test("archived courses retain access only for entitled learners; overview progress stays fresh", async () => {
  const { course, lesson } = await fixture();
  const enrollment = await enrollFree(learnerId, course.id);
  cookieHeader = learnerCookie;
  const params = Promise.resolve({ courseSlug: course.slug });
  assert.match(textInTree(await overview.default({ params })), /Continue where you left off/);
  const shared = await cached.getCachedCourseContent(course.id);
  assert.equal((await getEnrollmentProgress(enrollment, shared.publishedLessons)).completed, false);
  await markLessonComplete(learnerId, enrollment.id, lesson.id);
  const misses = cacheMisses;
  assert.match(textInTree(await overview.default({ params })), /Course complete/);
  assert.equal(cacheMisses, misses, "progress write needs no shared cache invalidation");
  cookieHeader = adminCookie;
  success(await actions.archiveCourseAction(course.id));
  cookieHeader = learnerCookie;
  await pageFor(course.slug, lesson.slug);
  await overview.default({ params });
  for (const cookie of ["", strangerCookie]) {
    cookieHeader = cookie;
    await assert.rejects(() => pageFor(course.slug, lesson.slug), /TEST_NOT_FOUND/);
    await assert.rejects(() => overview.default({ params }), /TEST_NOT_FOUND/);
  }
});

test("malformed or non-array lesson JSON prepares an empty body", async () => {
  const { course, lesson } = await fixture();
  const db = await getDb();
  for (const badBody of ["{broken", '{"type":"paragraph"}', "null"]) {
    await db.update(lessons).set({ body: badBody }).where(eq(lessons.id, lesson.id));
    assert.deepEqual((await prepareLessonContent(course.id, lesson.id))?.blocks, []);
  }
});

test("the installed OpenNext D1 tag adapter persists immediate expiration on the DB alias", async () => {
  const { getCloudflareBindings } = await import("../src/lib/cloudflare/bindings");
  const { D1NextModeTagCache } = await import("@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache");
  const env = await getCloudflareBindings() as unknown as {
    DB: import("@cloudflare/workers-types").D1Database;
    NEXT_TAG_CACHE_D1: import("@cloudflare/workers-types").D1Database;
  };
  // Mirrors the table owned/created by OpenNext populateCache, not app migrations.
  await env.NEXT_TAG_CACHE_D1.prepare(`CREATE TABLE IF NOT EXISTS revalidations (
    tag TEXT NOT NULL, revalidatedAt INTEGER NOT NULL, stale INTEGER,
    expire INTEGER default NULL, UNIQUE(tag) ON CONFLICT REPLACE
  )`).run();
  const symbol = Symbol.for("__cloudflare-context__");
  const previousContext = Reflect.get(globalThis, symbol);
  const previousConfig = Reflect.get(globalThis, "openNextConfig");
  Reflect.set(globalThis, symbol, { env });
  Reflect.set(globalThis, "openNextConfig", { dangerous: {} });
  try {
    const adapter = new D1NextModeTagCache();
    const tag = `lesson:${uid()}`;
    const now = Date.now();
    assert.equal(await adapter.hasBeenRevalidated([tag], now - 100), false);
    await adapter.writeTags([{ tag, stale: now, expire: now }]);
    assert.equal(await adapter.hasBeenRevalidated([tag], now - 100), true);
    assert.equal(await adapter.isStale([tag], now - 100), false, "expired tag must not serve stale");
    await adapter.writeTags([{ tag, stale: now + 1, expire: now + 1 }]);
    const persisted = await env.DB.prepare("SELECT revalidatedAt FROM revalidations WHERE tag LIKE ?")
      .bind(`%/${tag}`).first<{ revalidatedAt: number }>();
    assert.equal(persisted?.revalidatedAt, now + 1, "repeated invalidations replace the same row in the app DB");
  } finally {
    if (previousContext === undefined) Reflect.deleteProperty(globalThis, symbol);
    else Reflect.set(globalThis, symbol, previousContext);
    if (previousConfig === undefined) Reflect.deleteProperty(globalThis, "openNextConfig");
    else Reflect.set(globalThis, "openNextConfig", previousConfig);
  }
});

test("a committed lesson edit still invalidates if enrollment reconciliation fails", async (t) => {
  const { course, lesson } = await fixture();
  const realDb = await getD1Database();
  const logger = t.mock.method(console, "error", () => {});
  try {
    for (const mutate of [
      () => actions.unpublishLessonAction(lesson.id),
      () => actions.publishLessonAction(lesson.id),
      () => actions.updateLessonAction({ id: lesson.id, required: false, body: body("Committed despite reconcile error") }),
    ]) {
      await cached.getCachedLessonContent(course.id, lesson.id);
      await cached.getCachedCourseContent(course.id);
      setD1DatabaseForTest({
        prepare: (sql: string) => {
          if (/^\s*update\s+"?enrollments\b/i.test(sql)) throw new Error("Injected reconciliation failure");
          return realDb.prepare(sql);
        },
        batch: realDb.batch.bind(realDb),
      } as unknown as Parameters<typeof setD1DatabaseForTest>[0]);
      try {
        const result = await checked(course.id, lesson.id, mutate);
        assert.equal(result.ok, false, "caller sees the reconciliation error");
      } finally {
        clearD1DatabaseForTest();
      }
      assert.ok(![...entries.values()].some((entry) => entry.tags.includes(`course:${course.id}`)), "old shared entries expired despite service failure");
    }
    assert.deepEqual((await prepareLessonContent(course.id, lesson.id))?.blocks, body("Committed despite reconcile error"));
  } finally {
    clearD1DatabaseForTest();
    logger.mock.restore();
  }
});
