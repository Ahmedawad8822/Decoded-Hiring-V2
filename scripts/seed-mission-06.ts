// ============================================================================
// MISSION 06 LOCAL DEMO SEED — local development ONLY.
// ----------------------------------------------------------------------------
// Seeds ONE clearly-identified demo course so the learning-platform vertical
// slice is reviewable without hand-building curriculum first.
//
// Guarantees:
// - local-only (uses the local D1 proxy via getDb — never runs in prod)
// - deterministic (fixed ids/slugs; no random content)
// - safe to rerun (existence checks before every insert)
// - never auto-executed (only runs when you call `tsx scripts/seed-mission-06.ts`)
// - no fake production customers/students (course only; zero enrollments)
//
// Content is adapted from the Mission 01 / Super Recruiter prototype themes
// (role clarity, scorecard evidence) as reference material.
// ============================================================================

import { getDb, courses, courseSections, lessons } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { eq } from "drizzle-orm";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";

const DEMO_COURSE_ID = "course_m06_demo_01";
const DEMO_COURSE_SLUG = "mission-01-demo";

const PARAGRAPH = (id: string, text: string) => ({ id, type: "paragraph", text });
const HEADING = (id: string, text: string) => ({ id, type: "heading", level: 2, text });

async function main() {
  if (process.env.CF_PAGES || process.env.CLOUDFLARE === "1") {
    throw new Error("seed-mission-06 is local-only and refuses to run in a hosted environment.");
  }

  console.log("🌱 Mission 06 demo seed: running local D1 migrations...");
  await migrateLocalDb();
  const db = await getDb();

  const existingCourse = await db
    .select()
    .from(courses)
    .where(eq(courses.slug, DEMO_COURSE_SLUG))
    .get();

  let courseId = DEMO_COURSE_ID;
  if (existingCourse) {
    console.log(`ℹ️ Demo course already exists (/${existingCourse.slug}) — verifying curriculum...`);
    courseId = existingCourse.id;
  } else {
    const now = new Date();
    await db.insert(courses).values({
      id: DEMO_COURSE_ID,
      title: "Mission 01 · Super Recruiter (Local Demo)",
      slug: DEMO_COURSE_SLUG,
      description:
        "Local development demo course for the Mission 06 learning-platform vertical slice. Free, two sections, required + optional lessons.",
      status: "published",
      accessMode: "FREE",
      coverImage: null,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
    });
    console.log("✅ Demo course created: /learn/courses/mission-01-demo");
  }

  const sectionDefs = [
    { id: "section_m06_demo_01", title: "DECODE THE ROLE", position: 0 },
    { id: "section_m06_demo_02", title: "READ THE MARKET", position: 1 },
  ];
  for (const def of sectionDefs) {
    const existing = await db
      .select()
      .from(courseSections)
      .where(eq(courseSections.id, def.id))
      .get();
    if (!existing) {
      const now = new Date();
      await db.insert(courseSections).values({
        id: def.id,
        courseId,
        title: def.title,
        position: def.position,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`✅ Section created: ${def.title}`);
    }
  }

  const lessonDefs = [
    {
      id: "lesson_m06_demo_01",
      sectionId: "section_m06_demo_01",
      title: "Why role clarity fails",
      slug: "why-role-clarity-fails",
      required: true,
      status: "published" as const,
      position: 0,
      body: [
        HEADING("b-h1", "Most hiring failures are role failures"),
        PARAGRAPH(
          "b-p1",
          "Not every vacancy deserves the same recruitment approach — yet most organisations run every role through roughly the same process. That is where strategy begins to break down."
        ),
        PARAGRAPH(
          "b-p2",
          "This is a **local demo lesson** for the Mission 06 vertical slice. It carries no production meaning."
        ),
      ],
    },
    {
      id: "lesson_m06_demo_02",
      sectionId: "section_m06_demo_01",
      title: "The role brief, piece by piece",
      slug: "the-role-brief-piece-by-piece",
      required: true,
      status: "published" as const,
      position: 1,
      body: [
        HEADING("b-h1", "Write the brief before the search"),
        PARAGRAPH(
          "b-p1",
          "A scorecard that survives challenge converts every requirement into **observable evidence**: what the candidate did, said, or produced."
        ),
      ],
    },
    {
      id: "lesson_m06_demo_03",
      sectionId: "section_m06_demo_02",
      title: "Target universes, not pipelines",
      slug: "target-universes-not-pipelines",
      required: false,
      status: "published" as const,
      position: 0,
      body: [
        HEADING("b-h1", "An optional excursion"),
        PARAGRAPH(
          "b-p1",
          "Optional lessons never count toward progress or completion. This one exists so reviewers can verify that rule."
        ),
      ],
    },
    {
      id: "lesson_m06_demo_04",
      sectionId: "section_m06_demo_02",
      title: "Market signal vs. assumption (draft)",
      slug: "market-signal-vs-assumption",
      required: true,
      status: "draft" as const,
      position: 1,
      body: [PARAGRAPH("b-p1", "Draft — invisible to learners until published.")],
    },
  ];

  for (const def of lessonDefs) {
    const existing = await db.select().from(lessons).where(eq(lessons.id, def.id)).get();
    if (!existing) {
      const now = new Date();
      await db.insert(lessons).values({
        id: def.id,
        courseId,
        sectionId: def.sectionId,
        title: def.title,
        slug: def.slug,
        body: JSON.stringify(def.body),
        videoUrl: null,
        required: def.required,
        position: def.position,
        status: def.status,
        createdAt: now,
        updatedAt: now,
        publishedAt: def.status === "published" ? now : null,
      });
      console.log(`✅ Lesson created [${def.status}]: ${def.title}`);
    }
  }

  console.log("🌱 Mission 06 demo seed complete!");
  await disposeCloudflareBindings();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("❌ Demo seeding failed:", err);
  try {
    await disposeCloudflareBindings();
  } catch {
    // ignore
  }
  process.exit(1);
});
