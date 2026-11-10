"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { toActionResult } from "@/lib/action-result";
import { claimCertificate, mutateCertificate } from "./service";
import { claimCertificateSchema } from "./types";

export async function claimCertificateAction(input: unknown) {
  return toActionResult(async () => {
    const session = await requireUser();
    const parsed = claimCertificateSchema.parse(input);
    const certificate = await claimCertificate(session.user.id, parsed.courseSlug, parsed.recipientName);
    revalidatePath(`/learn/courses/${parsed.courseSlug}/complete`);
    revalidatePath(`/learn/courses/${parsed.courseSlug}`);
    revalidatePath("/learn");
    return { id: certificate.id };
  }, "Could not issue your certificate");
}

export async function mutateCertificateAction(input: unknown) {
  return toActionResult(async () => {
    const result = await mutateCertificate(input);
    revalidatePath(`/admin/courses/${result.courseId}/certificates`);
    revalidatePath(`/certificates/${result.id}`);
    revalidatePath("/learn");
    return result;
  }, "Could not update the certificate");
}
