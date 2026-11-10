// Local-only fixture for the built Worker cache checks.
import { eq } from "drizzle-orm";
import { certificates, getDb, users } from "../src/lib/db";
import { createCourse, createSection, createLesson, publishCourse, publishLesson } from "../src/features/courses/service";
import { enrollFree } from "../src/features/enrollments/service";
import { markLessonComplete } from "../src/features/progress/service";
import { claimCertificate } from "../src/features/certificates/service";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { WORKER_ADMIN, WORKER_CERTIFICATE_ID } from "./worker-e2e-setup";

async function main() {
  if (!process.env.DH_LOCAL_STATE_DIR || process.env.WORKER_E2E_CONTROL !== "local-fixture" || process.env.CF_PAGES || process.env.CLOUDFLARE === "1") {
    throw new Error("Certificate fixture requires the disposable local Worker harness");
  }
  const db = await getDb();
  const user = await db.select().from(users).where(eq(users.email, WORKER_ADMIN.email)).get();
  if (!user) throw new Error("Worker fixture admin missing");
  const course = await createCourse({ title: "Worker Certificate Course", slug: "worker-certificate-course", certificateEnabled: true });
  const section = await createSection({ courseId: course.id, title: "Fixture section" });
  const lesson = await createLesson({ courseId: course.id, sectionId: section.id, title: "Fixture lesson", slug: "fixture-lesson" });
  await publishLesson(lesson.id);
  await publishCourse(course.id);
  const enrollment = await enrollFree(user.id, course.id);
  await markLessonComplete(user.id, enrollment.id, lesson.id);
  const certificate = await claimCertificate(user.id, course.slug, "Worker Certificate Learner");
  // Use a stable public id only in this disposable fixture, for HTTP-only tests.
  await db.update(certificates).set({ id: WORKER_CERTIFICATE_ID }).where(eq(certificates.id, certificate.id));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(disposeCloudflareBindings);
