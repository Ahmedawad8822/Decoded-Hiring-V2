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
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import { eq } from "drizzle-orm";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getDb, users, businessEvents, courses } from "@/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  archiveCourse,
  createCourse,
  createLesson,
  createSection,
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
import { getEffectiveCourseAccessPolicy } from "@/features/offers/service";
import { getOfferAvailability } from "@/features/offers/availability";
import { resolveOfferPublicPresentation } from "@/features/offers/presentation";
import { createOffer } from "@/features/offers/service";
import { enrollFree } from "@/features/enrollments/service";
import { recordPublicOfferCta } from "@/features/analytics/public-actions";
import { buildSitemapEntries } from "@/lib/sitemap-entries";
import { buildCourseJsonLd, getSiteUrl } from "@/lib/seo";

before(async () => {
  await migrateLocalDb();
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
