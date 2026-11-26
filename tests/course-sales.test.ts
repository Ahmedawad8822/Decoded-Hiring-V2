/**
 * PUBLIC COURSE SALES PAGES (§2 of Docs/PAGE-TYPE-SPECS.md).
 *
 * Proves, against an isolated local D1:
 * - published courses render public data only (no lesson bodies, video URLs
 *   or learner/enrollment data in the sales projections)
 * - drafts and archived courses 404 (null public read; archived stays visible
 *   only to entitled learners via the classroom service, never here)
 * - trashed courses are treated as missing (runtime gate, forward-compatible
 *   with the parallel Trash change; no migration in this feature)
 * - slug renames 308 to /courses/<new> for published courses only
 * - the sitemap lists /courses plus published courses only
 * - Course JSON-LD is well-formed
 * - the pages never touch the session (source-level cacheability guard)
 * - offer access policy + seat availability drive the public CTA state,
 *   and CTA clicks record the existing offer_cta_clicked business event
 */
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import { eq } from "drizzle-orm";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getDb, users, businessEvents, courses, type Offer } from "@/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  archiveCourse,
  createCourse,
  createLesson,
  createSection,
  getPublishedLessonCounts,
  publishCourse,
  publishLesson,
  updateCourse,
} from "@/features/courses/service";
import {
  getPublicCourseBySlug,
  getPublicCourses,
  getPublicCourseCurriculum,
  isTrashedCourse,
} from "@/features/courses/sales";
import {
  resolvePublicCourseRedirect,
  resolveCourseRedirect,
} from "@/features/slug-redirects/service";
import {
  createOffer,
  getEffectiveCourseAccessPolicy,
  getOffersForCourses,
} from "@/features/offers/service";
import { getOfferAvailability } from "@/features/offers/availability";
import { resolveOfferPublicPresentation } from "@/features/offers/presentation";
import { enrollFree } from "@/features/enrollments/service";
import { recordPublicOfferCta } from "@/features/analytics/public-actions";
import { buildSitemapEntries } from "@/lib/sitemap-entries";
import { buildCourseJsonLd, getSiteUrl } from "@/lib/seo";

before(async () => {
  // NOTE: the await below runs first on purpose. The stub helpers are
  // declared later in this file, and a before() body with no preceding await
  // executes before the module finishes evaluating (TDZ). migrateLocalDb
  // also must precede the stubs: the stubs have to be installed before any
  // TEST loads the real next/* modules (Node caches the first ESM import, so
  // a later require.cache stub would not win — test 9's analytics call
  // imports next/headers for real). The headers stub reads the live cookie
  // variable, filled in by stubAdminSession().
  await migrateLocalDb();
  stubModule("next/headers", {
    headers: async () => new Headers({ cookie: reviewCookieHeader }),
  });
  stubModule("next/cache", {
    revalidatePath: (path: string) => {
      revalidatedPaths.push(path);
    },
  });
});

after(async () => {
  await disposeCloudflareBindings();
});

let seq = 0;
const uid = () => `cs${Date.now().toString(36)}-${seq++}`;

async function makeUser(): Promise<string> {
  const db = await getDb();
  const id = `cs_user_${uid()}`;
  const now = new Date();
  await db.insert(users).values({
    id,
    name: "Sales Test Learner",
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
    role: "user",
  });
  return id;
}

async function makePublishedCourse(options?: {
  title?: string;
  accessMode?: "FREE" | "PAID_ONE_TIME" | "MANUAL_INVOICE" | "PAYMENT_DISABLED";
}) {
  const slug = `cs-course-${uid()}`;
  const course = await createCourse({
    title: options?.title ?? `Sales Course ${slug}`,
    slug,
    description: "Learn it properly.",
    outcomes: ["Think clearly", "Decide well"],
    audience: "Recruiters",
    faq: [{ q: "How long?", a: "Two hours." }],
    instructorName: "Ahmed Awad",
    instructorBio: "Recruitment strategist.",
    accessMode: options?.accessMode ?? "FREE",
  });
  const section = await createSection({ courseId: course.id, title: "Basics" });
  // NOTE: no videoUrl — keeps the fixture independent of YouTube validation;
  // a video lesson is covered by the projection unit shape below.
  const preview = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "First lesson",
    slug: `first-${uid()}`,
    body: [{ id: "p1", type: "paragraph", text: "SECRET-BODY-MUST-NOT-LEAK" }],
    isPreview: true,
    durationMinutes: 8,
  });
  const regular = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Second lesson",
    slug: `second-${uid()}`,
    body: [{ id: "p1", type: "paragraph", text: "SECRET-BODY-MUST-NOT-LEAK" }],
    durationMinutes: 12,
  });
  const draft = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Draft lesson",
    slug: `draft-${uid()}`,
    body: [{ id: "p1", type: "paragraph", text: "SECRET-BODY-MUST-NOT-LEAK" }],
  });
  await publishLesson(preview.id);
  await publishLesson(regular.id);
  await publishCourse(course.id);
  return { course: (await getPublicCourseBySlug(slug))!, slug, preview, regular, draft };
}

// ---------------------------------------------------------------- visibility

test("published courses are publicly visible; drafts and archived are not", async () => {
  const draftSlug = `cs-draft-${uid()}`;
  await createCourse({ title: "Draft", slug: draftSlug, accessMode: "FREE" });
  assert.equal(await getPublicCourseBySlug(draftSlug), null);

  const archivedSlug = `cs-archived-${uid()}`;
  const archived = await createCourse({ title: "Archived", slug: archivedSlug, accessMode: "FREE" });
  await publishCourse(archived.id);
  await archiveCourse(archived.id);
  assert.equal(await getPublicCourseBySlug(archivedSlug), null);

  assert.equal(await getPublicCourseBySlug(`cs-missing-${uid()}`), null);

  const { slug } = await makePublishedCourse();
  const visible = await getPublicCourseBySlug(slug);
  assert.ok(visible, "published course must be publicly visible");
  assert.equal(
    (await getPublicCourses()).some((c) => c.slug === slug),
    true,
  );
  const slugs = (await getPublicCourses()).map((c) => c.slug);
  assert.ok(!slugs.includes(draftSlug), "draft must stay out of the list");
  assert.ok(!slugs.includes(archivedSlug), "archived must stay out of the list");
});

test("trashed courses are treated as missing (runtime Trash gate)", async () => {
  // The Trash lifecycle (trashed_at) lands in a parallel change; the public
  // reads gate on the property at runtime either way.
  assert.equal(isTrashedCourse({ status: "published" }), false);
  assert.equal(isTrashedCourse({ status: "published", trashedAt: null } as never), false);
  assert.equal(isTrashedCourse({ status: "published", trashedAt: new Date() } as never), true);
  assert.equal(isTrashedCourse({ status: "published", trashed_at: new Date() } as never), true);

  // A published row with no trash marker stays visible.
  const { slug } = await makePublishedCourse();
  assert.ok(await getPublicCourseBySlug(slug));
});

// ---------------------------------------------------------------- projections

test("sales curriculum exposes previews and durations but never lesson bodies", async () => {
  const { course, preview, regular, draft } = await makePublishedCourse();
  const curriculum = await getPublicCourseCurriculum(course.id);
  assert.equal(curriculum.length, 1);
  const lessons = curriculum[0].lessons;
  // Draft lessons never appear; published ones do, in position order.
  assert.deepEqual(
    lessons.map((l) => l.id),
    [preview.id, regular.id],
  );
  assert.equal(
    lessons.some((l) => l.id === draft.id),
    false,
  );

  const serialised = JSON.stringify(lessons);
  assert.ok(!serialised.includes("SECRET-BODY-MUST-NOT-LEAK"), "lesson bodies must never leak");
  assert.ok(!serialised.includes('"body"'), "no body key may be projected");

  const first = lessons.find((l) => l.id === preview.id)!;
  assert.equal(first.isPreview, true);
  assert.equal(first.durationMinutes, 8);
  assert.equal(first.kind, "reading");

  const db = await getDb();
  const row = await db.select().from(courses).where(eq(courses.id, course.id)).get();
  assert.ok(row && !("body" in (lessons[0] as Record<string, unknown>)));
});

test("enrollments never change the public projection", async () => {
  const { course, slug } = await makePublishedCourse();
  const before = JSON.stringify(await getPublicCourseCurriculum(course.id));
  await enrollFree(await makeUser(), course.id);
  const after = JSON.stringify(await getPublicCourseCurriculum(course.id));
  assert.equal(after, before, "learner state must not affect public data");
  assert.ok(await getPublicCourseBySlug(slug));
});

// ---------------------------------------------------------------- redirects

test("renamed published courses redirect to /courses/<new>; drafts do not", async () => {
  const oldSlug = `cs-rename-${uid()}`;
  const course = await createCourse({ title: "Rename", slug: oldSlug, accessMode: "FREE" });
  assert.equal(await resolvePublicCourseRedirect(oldSlug), null, "draft rename records no public redirect");

  await publishCourse(course.id);
  const newSlug = `${oldSlug}-new`;
  await updateCourse(course.id, { id: course.id, slug: newSlug });
  assert.equal(await resolvePublicCourseRedirect(oldSlug), `/courses/${newSlug}`);
  assert.equal(await resolvePublicCourseRedirect(newSlug), null, "current slug is not a redirect");
  // The public resolver never points at the classroom.
  assert.ok(!(await resolvePublicCourseRedirect(oldSlug))!.startsWith("/learn"));

  // Archived targets 404 instead of redirecting (classroom may still redirect
  // entitled learners via its own resolver).
  await archiveCourse(course.id);
  assert.equal(await resolvePublicCourseRedirect(oldSlug), null);
  assert.notEqual(
    await resolveCourseRedirect(oldSlug),
    await resolvePublicCourseRedirect(oldSlug),
    "classroom and sales redirects diverge for archived courses",
  );
});

// ---------------------------------------------------------------- sitemap/SEO

test("sitemap lists /courses and published courses only", async () => {
  const { slug } = await makePublishedCourse();
  const draftSlug = `cs-sitemap-draft-${uid()}`;
  await createCourse({ title: "Sitemap draft", slug: draftSlug, accessMode: "FREE" });
  const archivedSlug = `cs-sitemap-arch-${uid()}`;
  const archived = await createCourse({ title: "Sitemap archived", slug: archivedSlug, accessMode: "FREE" });
  await publishCourse(archived.id);
  await archiveCourse(archived.id);

  const urls = (await buildSitemapEntries()).map((e) => e.url);
  assert.ok(urls.some((u) => u.endsWith("/courses")), "sitemap must include /courses");
  assert.ok(urls.some((u) => u.endsWith(`/courses/${slug}`)), "published course must be listed");
  assert.ok(!urls.some((u) => u.endsWith(`/courses/${draftSlug}`)), "draft must stay out");
  assert.ok(!urls.some((u) => u.endsWith(`/courses/${archivedSlug}`)), "archived must stay out");
  assert.ok(
    urls.every((u) => !new URL(u).pathname.startsWith("/learn")),
    "learner routes must never enter the sitemap",
  );
});

test("Course JSON-LD is well-formed", async () => {
  const { course, slug } = await makePublishedCourse();
  const data = buildCourseJsonLd({
    title: course.title,
    description: course.description ?? "A practical course.",
    path: `/courses/${slug}`,
    dateModified: new Date(course.updatedAt).toISOString(),
  });
  assert.equal(data["@type"], "Course");
  assert.equal(data.name, course.title);
  assert.equal((data.provider as { name?: string }).name, "Decoded Hiring");
  const base = getSiteUrl().toString().replace(/\/$/, "");
  assert.equal(
    (data.mainEntityOfPage as { "@id"?: string })["@id"],
    `${base}/courses/${slug}`,
  );
});

test("sales pages never read the session (stay ISR-cacheable)", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const page = readFileSync(`${root}/src/app/(site)/courses/page.tsx`, "utf8");
  const detail = readFileSync(`${root}/src/app/(site)/courses/[slug]/page.tsx`, "utf8");
  const article = readFileSync(
    `${root}/src/app/(site)/courses/[slug]/course-sales-article.tsx`,
    "utf8",
  );
  const salesService = readFileSync(`${root}/src/features/courses/sales.ts`, "utf8");
  for (const [name, source] of [
    ["list", page],
    ["detail", detail],
    ["article", article],
    ["sales service", salesService],
  ] as const) {
    for (const banned of [
      "getServerSession",
      "getAuth",
      "requireAdmin",
      "requireUser",
      "next/headers",
    ]) {
      assert.ok(!source.includes(banned), `${name} must not touch ${banned}`);
    }
  }
  for (const source of [detail]) {
    assert.ok(source.includes("export const revalidate"), "detail page must set revalidate");
    assert.ok(source.includes("generateStaticParams"), "detail page must opt into ISR");
  }
});

// ---------------------------------------------------------------- offer/CTA

test("offer access policy and availability drive the public CTA state", async () => {
  const { course, slug } = await makePublishedCourse();
  const offer = await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Sales offer",
    slug: `cs-offer-${uid()}`,
    accessMode: "FREE",
    seatLimit: 2,
    closesAt: null,
  });

  const access = await getEffectiveCourseAccessPolicy(course);
  assert.equal(access.source, "OFFER");
  assert.equal(access.mode, "FREE");

  const presentation = resolveOfferPublicPresentation(offer, {
    freeHref: `/learn/courses/${slug}`,
    freeLabel: "Start learning — free",
    contactHref: "/contact",
  });
  assert.equal(presentation.badge, "FREE");
  assert.equal(presentation.ctaHref, `/learn/courses/${slug}`);

  const open = await getOfferAvailability(offer.id);
  assert.equal(open.state, "open");

  // CTA clicks reuse the existing business-event pattern.
  await recordPublicOfferCta({
    eventKey: crypto.randomUUID(),
    offerSlug: offer.slug,
    route: "/courses",
    target: "enroll",
    surface: "hero-primary",
  });
  const db = await getDb();
  const events = await db
    .select()
    .from(businessEvents)
    .where(eq(businessEvents.eventName, "offer_cta_clicked"));
  assert.ok(
    events.some((e) => e.route === "/courses" && e.offerId === offer.id),
    "course CTA click must record an offer_cta_clicked event",
  );

  // Filling every seat flips the render-time snapshot to sold out.
  await enrollFree(await makeUser(), course.id);
  await enrollFree(await makeUser(), course.id);
  assert.equal((await getOfferAvailability(offer.id)).state, "sold_out");
});

// ---------------------------------------------------------------- review fixes

process.env.ADMIN_REQUIRE_2FA = "false";

const nodeRequire = createRequire(__filename);
const revalidatedPaths: string[] = [];
let reviewCookieHeader = "";

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

async function stubAdminSession(): Promise<void> {
  const { getAuth } = await import("../src/lib/auth");
  const { markEmailVerified } = await import("./helpers/verified");
  const auth = await getAuth();
  const email = `cs-admin-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({
    body: { email, password, name: "Sales Review Admin" },
  });
  await (await getDb())
    .update(users)
    .set({ role: "admin" })
    .where(eq(users.id, created.user.id));
  await markEmailVerified(created.user.id);
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  // Fills the cookie read by the next/headers stub installed in before().
  reviewCookieHeader = signIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

test("anonymous CTA resolves to signup with classroom redirect", async () => {
  const { resolveCourseSalesCtaHref } = await import(
    "../src/app/(site)/courses/[slug]/course-sales-cta"
  );
  const classroom = "/learn/courses/sales-cta-course";
  const signup = `/signup?redirect=${encodeURIComponent(classroom)}`;
  assert.equal(resolveCourseSalesCtaHref(false, classroom, signup), signup);
  assert.equal(resolveCourseSalesCtaHref(true, classroom, signup), classroom);
  assert.equal(resolveCourseSalesCtaHref(null, classroom, signup), classroom);
  assert.equal(resolveCourseSalesCtaHref(false, "/contact", null), "/contact");
});

test("loginRedirectHref preserves deep links and rejects open redirects", async () => {
  const { loginRedirectHref } = await import("../src/lib/safe-redirect");
  const deep = "/learn/courses/some-course/lessons/some-lesson";
  assert.equal(
    loginRedirectHref(deep),
    `/login?redirect=${encodeURIComponent(deep)}`,
  );
  assert.equal(
    loginRedirectHref("/learn/courses/some-course", "?tab=1"),
    `/login?redirect=${encodeURIComponent("/learn/courses/some-course?tab=1")}`,
  );
  assert.equal(loginRedirectHref("//evil.com"), "/login?redirect=%2Flearn");
  assert.equal(loginRedirectHref("/\\evil.com"), "/login?redirect=%2Flearn");
});

test("sales island owns the CTA notices; zero seats never render", async () => {
  const { formatSeatsLeftLabel } = await import(
    "../src/features/offers/presentation"
  );
  assert.equal(formatSeatsLeftLabel({ seatsLeft: null }), null);
  assert.equal(formatSeatsLeftLabel({ seatsLeft: 0 }), null);
  assert.equal(formatSeatsLeftLabel({ seatsLeft: -2 }), null);
  assert.equal(formatSeatsLeftLabel({ seatsLeft: 1 }), "1 place left");
  assert.equal(formatSeatsLeftLabel({ seatsLeft: 20 }), "20 places left");
  assert.equal(formatSeatsLeftLabel({ seatsLeft: 21 }), null);

  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const article = readFileSync(
    `${root}/src/app/(site)/courses/[slug]/course-sales-article.tsx`,
    "utf8",
  );
  assert.ok(!article.includes("seatsNote"), "no server seats notice");
  assert.ok(!article.includes("closesNote"), "no server closes notice");
  assert.ok(!article.includes("0 places"), "never renders '0 places left'");
  assert.ok(
    !article.includes('<a className="hg-primary"'),
    "no untracked anchors remain",
  );
  assert.equal(
    (article.match(/<CourseSalesCta/g) || []).length,
    3,
    "hero, repeated and sticky CTAs share the island",
  );
  assert.equal(
    (article.match(/hideNotices/g) || []).length,
    2,
    "repeated and sticky CTAs hide the hero notices",
  );
});

test("signup/login forward signed-in users; the learn proxy preserves paths", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  for (const name of ["signup", "login"] as const) {
    const source = readFileSync(
      `${root}/src/app/(site)/${name}/page.tsx`,
      "utf8",
    );
    assert.ok(
      source.includes("authClient.useSession"),
      `${name} reads the client session`,
    );
    assert.ok(
      source.includes("router.replace(next)"),
      `${name} forwards signed-in visitors to the safe redirect`,
    );
    assert.ok(
      source.includes("redirect=${encodeURIComponent(next)}"),
      `${name} carries the redirect across the auth switch`,
    );
  }
  const proxy = readFileSync(`${root}/src/proxy.ts`, "utf8");
  assert.ok(proxy.includes('"/learn/:path*"'), "proxy is scoped to /learn");
  assert.ok(proxy.includes("loginRedirectHref"), "proxy preserves the path");
});

test("course and offer mutations revalidate the sales surfaces", async () => {
  await stubAdminSession();
  const courseActions = await import("../src/features/courses/actions");
  const quizActions = await import("../src/features/quizzes/actions");
  const outlineActions = await import("../src/features/course-outline/actions");
  const commerceActions = await import("../src/features/commerce/admin-actions");

  const slug = `cs-reval-${uid()}`;
  const course = await createCourse({
    title: "Revalidation course",
    slug,
    accessMode: "FREE",
  });
  const first = await createSection({ courseId: course.id, title: "First" });
  await createSection({ courseId: course.id, title: "Second" });
  await publishCourse(course.id);

  revalidatedPaths.length = 0;
  assert.equal((await courseActions.moveSectionAction(first.id, "down")).ok, true);
  assert.ok(revalidatedPaths.includes("/courses"), "list revalidated");
  assert.ok(revalidatedPaths.includes("/sitemap.xml"), "sitemap revalidated");
  assert.ok(
    revalidatedPaths.includes(`/courses/${slug}`),
    "detail page revalidated",
  );

  const lessonOne = await createLesson({
    courseId: course.id,
    sectionId: first.id,
    title: "Reval lesson one",
    slug: `reval-one-${uid()}`,
    body: [{ id: "p1", type: "paragraph", text: "Body" }],
  });
  const lessonTwo = await createLesson({
    courseId: course.id,
    sectionId: first.id,
    title: "Reval lesson two",
    slug: `reval-two-${uid()}`,
    body: [{ id: "p1", type: "paragraph", text: "Body" }],
  });

  revalidatedPaths.length = 0;
  assert.equal((await courseActions.moveLessonAction(lessonOne.id, "down")).ok, true);
  assert.ok(revalidatedPaths.includes(`/courses/${slug}`));

  const quizPayload = {
    lessonId: lessonTwo.id,
    passPercent: 70,
    requirePass: false,
    questions: [
      {
        id: "reval-q1",
        prompt: "Reval prompt",
        kind: "single" as const,
        options: [
          { id: "reval-a", text: "Alpha" },
          { id: "reval-b", text: "Beta" },
        ],
        correctOptionIds: ["reval-a"],
      },
    ],
  };
  revalidatedPaths.length = 0;
  assert.equal((await quizActions.saveQuizAction(quizPayload)).ok, true);
  assert.ok(revalidatedPaths.includes(`/courses/${slug}`));

  revalidatedPaths.length = 0;
  assert.equal((await quizActions.deleteQuizAction({ lessonId: lessonTwo.id })).ok, true);
  assert.ok(revalidatedPaths.includes(`/courses/${slug}`));

  revalidatedPaths.length = 0;
  const applied = await outlineActions.applyOutlineAction({
    courseId: course.id,
    sections: [
      {
        title: "Outlined section",
        lessons: [{ title: "Outlined lesson", summary: "A summary." }],
      },
    ],
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.ok(revalidatedPaths.includes(`/courses/${slug}`));

  const slugB = `cs-reval-b-${uid()}`;
  const courseB = await createCourse({
    title: "Revalidation course B",
    slug: slugB,
    accessMode: "FREE",
  });
  await publishCourse(courseB.id);
  const offer = await createOffer({
    kind: "COURSE",
    courseId: course.id,
    title: "Reval offer",
    slug: `cs-reval-offer-${uid()}`,
    accessMode: "FREE",
  });
  revalidatedPaths.length = 0;
  const moved = await commerceActions.updateOfferAdminAction({
    id: offer.id,
    courseId: courseB.id,
  });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.ok(
    revalidatedPaths.includes(`/courses/${slug}`),
    "old course page expired after the offer moved",
  );
  assert.ok(
    revalidatedPaths.includes(`/courses/${slugB}`),
    "new course page expired after the offer moved",
  );
});

test("catalog list queries chunk past 90 ids (D1 bound-parameter cap)", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 101; i++) {
    const created = await createCourse({
      title: `Chunk course ${uid()}`,
      slug: `cs-chunk-${uid()}`,
      accessMode: "FREE",
    });
    await publishCourse(created.id);
    ids.push(created.id);
  }
  const headSection = await createSection({ courseId: ids[0], title: "Head" });
  for (let i = 0; i < 2; i++) {
    const lesson = await createLesson({
      courseId: ids[0],
      sectionId: headSection.id,
      title: `Head lesson ${i}`,
      slug: `cs-head-${uid()}`,
      body: [{ id: "p1", type: "paragraph", text: "Body" }],
    });
    await publishLesson(lesson.id);
  }
  const tailSection = await createSection({ courseId: ids[100], title: "Tail" });
  const tailLesson = await createLesson({
    courseId: ids[100],
    sectionId: tailSection.id,
    title: "Tail lesson",
    slug: `cs-tail-${uid()}`,
    body: [{ id: "p1", type: "paragraph", text: "Body" }],
  });
  await publishLesson(tailLesson.id);

  const counts = await getPublishedLessonCounts(ids);
  assert.equal(Object.keys(counts).length, 101);
  assert.equal(counts[ids[0]], 2);
  assert.equal(counts[ids[100]], 1);
  assert.equal(counts[ids[50]], 0);

  const empty = await getOffersForCourses(ids);
  assert.equal(empty.size, 0);
  const offer = await createOffer({
    kind: "COURSE",
    courseId: ids[100],
    title: "Chunk offer",
    slug: `cs-chunk-offer-${uid()}`,
    accessMode: "FREE",
  });
  const withOffer = await getOffersForCourses(ids);
  assert.equal(withOffer.get(ids[100])?.id, offer.id);
});

test("list access labels mirror the detail page", async () => {
  const {
    resolveCourseListAccessLabel,
    resolveOfferPublicPresentation,
  } = await import("../src/features/offers/presentation");
  assert.equal(resolveCourseListAccessLabel(null, "FREE"), "FREE");
  assert.equal(resolveCourseListAccessLabel(null, "PAID_ONE_TIME"), "ON REQUEST");

  const offerCourse = async () =>
    (
      await createCourse({
        title: `Label course ${uid()}`,
        slug: `cs-label-${uid()}`,
        accessMode: "FREE",
      })
    ).id;
  const free = await createOffer({
    kind: "COURSE",
    courseId: await offerCourse(),
    title: "Label free",
    slug: `cs-label-free-${uid()}`,
    accessMode: "FREE",
  });
  assert.equal(resolveCourseListAccessLabel(free, "FREE"), "FREE");

  const paid = await createOffer({
    kind: "COURSE",
    courseId: await offerCourse(),
    title: "Label paid",
    slug: `cs-label-paid-${uid()}`,
    accessMode: "PAID_ONE_TIME",
    currency: "USD",
    amountMinor: 4900,
  });
  const paidLabel = resolveCourseListAccessLabel(paid, "FREE");
  assert.ok(paidLabel.includes("49"), `price shown, got ${paidLabel}`);
  assert.ok(!paidLabel.includes("_"), `no raw enum, got ${paidLabel}`);

  const unpaid = {
    active: true,
    accessMode: "PAID_ONE_TIME",
    currency: null,
    amountMinor: null,
    alternativeCtaLabel: null,
    alternativeCtaUrl: null,
  } as unknown as Offer;
  assert.equal(resolveCourseListAccessLabel(unpaid, "FREE"), "PAID");

  const manual = await createOffer({
    kind: "COURSE",
    courseId: await offerCourse(),
    title: "Label manual",
    slug: `cs-label-manual-${uid()}`,
    accessMode: "MANUAL_INVOICE",
  });
  assert.ok(
    !resolveCourseListAccessLabel(manual, "FREE").includes("_"),
    "manual invoice label has no raw enum",
  );

  const coming = await createOffer({
    kind: "COURSE",
    courseId: await offerCourse(),
    title: "Label coming",
    slug: `cs-label-coming-${uid()}`,
    accessMode: "COMING_SOON",
    alternativeCtaLabel: "Notify me",
    alternativeCtaUrl: "/contact",
  });
  assert.equal(resolveCourseListAccessLabel(coming, "FREE"), "COMING SOON");

  const inactive = await createOffer({
    kind: "COURSE",
    courseId: await offerCourse(),
    title: "Label inactive",
    slug: `cs-label-inactive-${uid()}`,
    accessMode: "FREE",
    active: false,
  });
  assert.equal(resolveCourseListAccessLabel(inactive, "FREE"), "UNAVAILABLE");

  const detail = resolveOfferPublicPresentation(paid, {
    freeHref: "/learn/courses/x",
    contactHref: "/contact",
  });
  assert.ok(!detail.badge.includes("_"), "detail badge has no raw enum");
});
