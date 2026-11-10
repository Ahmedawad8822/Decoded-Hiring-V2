import { and, desc, eq } from "drizzle-orm";
import { certificates, getDb } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { AppError } from "@/lib/errors";
import { requireAdmin } from "@/lib/auth";
import { recordAdminAudit } from "@/features/audit/service";
import { getCourseCompletionState } from "@/features/progress/completion";
import { certificateMutationSchema, generateCertificateId, isCertificateId, recipientNameSchema } from "./types";

export async function getLearnerCertificate(userId: string, courseId: string) {
  const db = await getDb();
  return await db.select().from(certificates).where(and(
    eq(certificates.userId, userId), eq(certificates.courseId, courseId),
  )).get() ?? null;
}

/** userId is supplied only by the authenticated action, never by form data. */
export async function claimCertificate(userId: string, courseSlug: string, name: unknown) {
  if (!userId) throw new AppError("unauthorized", "Sign in to claim a certificate");
  const recipientName = recipientNameSchema.parse(name);
  const state = await getCourseCompletionState(userId, courseSlug);
  if (state.kind !== "complete") throw new AppError("forbidden", "Complete this course with an active enrollment first");
  // An already-issued certificate stays claimable after the course toggle is turned off.
  const existing = await getLearnerCertificate(userId, state.course.id);
  if (existing) return existing;
  if (!state.course.certificateEnabled) throw new AppError("forbidden", "Certificates are not enabled for this course");
  const db = await getDb();
  try {
    return await db.insert(certificates).values({
      id: generateCertificateId(), userId, courseId: state.course.id,
      enrollmentId: state.enrollment.id, recipientName,
      courseTitle: state.course.title, issuedAt: new Date(),
    }).returning().get();
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // Confirm the business-key conflict; an unrelated unique failure propagates.
    const winner = await getLearnerCertificate(userId, state.course.id);
    if (!winner) throw error;
    return winner;
  }
}

// This projection is also the only data serialized into the public page's RSC.
export async function getPublicCertificate(id: string) {
  if (!isCertificateId(id)) return null;
  const db = await getDb();
  return await db.select({
    id: certificates.id, recipientName: certificates.recipientName,
    courseTitle: certificates.courseTitle, issuedAt: certificates.issuedAt,
    revokedAt: certificates.revokedAt, revokedReason: certificates.revokedReason,
  }).from(certificates).where(eq(certificates.id, id)).get() ?? null;
}

/** One indexed query, no course joins or per-certificate lookups. */
export async function listLearnerCertificates(userId: string) {
  const db = await getDb();
  return db.select({ id: certificates.id, courseTitle: certificates.courseTitle, revokedAt: certificates.revokedAt })
    .from(certificates).where(eq(certificates.userId, userId))
    .orderBy(desc(certificates.issuedAt), desc(certificates.id));
}

export const CERTIFICATES_PAGE_SIZE = 25;
export type AdminCertificateRow = Awaited<ReturnType<typeof listCourseCertificates>>[number];
export async function listCourseCertificates(courseId: string, page: number) {
  await requireAdmin();
  const db = await getDb();
  return db.select({
    id: certificates.id, recipientName: certificates.recipientName, issuedAt: certificates.issuedAt,
    revokedAt: certificates.revokedAt, revokedReason: certificates.revokedReason,
  }).from(certificates).where(eq(certificates.courseId, courseId))
    .orderBy(desc(certificates.issuedAt), desc(certificates.id))
    .limit(CERTIFICATES_PAGE_SIZE + 1).offset((page - 1) * CERTIFICATES_PAGE_SIZE);
}

export async function mutateCertificate(input: unknown) {
  const session = await requireAdmin();
  const parsed = certificateMutationSchema.parse(input);
  const db = await getDb();
  const patch = parsed.operation === "revoke"
    ? { revokedAt: new Date(), revokedReason: parsed.reason }
    : parsed.operation === "restore"
      ? { revokedAt: null, revokedReason: null }
      : { recipientName: parsed.recipientName };
  const updated = await db.update(certificates).set(patch).where(eq(certificates.id, parsed.id)).returning().get();
  if (!updated) throw new AppError("not_found", "Certificate not found");
  await recordAdminAudit({
    actorId: session.user.id, action: `certificate.${parsed.operation}`,
    entityType: "certificate", entityId: updated.id,
    details: { courseId: updated.courseId },
  });
  return { id: updated.id, courseId: updated.courseId };
}
