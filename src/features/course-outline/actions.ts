// ============================================================================
// AI COURSE OUTLINE — SERVER ACTIONS
// ----------------------------------------------------------------------------
// Admin-only (requireAdmin enforces the role + 2FA gate). Results use
// ActionResult via toActionResult — actions return, never throw.
// ============================================================================

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { toActionResult } from "@/lib/action-result";
import { revalidateCourseSales } from "@/features/courses/actions";
import { applyCourseOutline, draftCourseOutline } from "./service";
import { applyOutlineSchema, outlineBriefSchema } from "./types";

export async function draftOutlineAction(input: unknown) {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const brief = outlineBriefSchema.parse(input);
    // EXPLICIT TEST-ONLY (mirrors editorial-ai drafts/actions.ts): when
    // EDITORIAL_FORCE_FAKE_PROVIDER=1 is set outside production, inject the
    // FakeProvider so Studio and E2E exercise generation without real
    // credentials. There is NEVER a silent FakeProvider fallback in
    // production — without a key the service fails closed with a clear error.
    if (
      process.env.EDITORIAL_FORCE_FAKE_PROVIDER === "1" &&
      process.env.NODE_ENV !== "production"
    ) {
      const { FakeProvider } = await import("../editorial-ai/providers/fake");
      return draftCourseOutline(brief, session.user.id, {
        provider: new FakeProvider(),
      });
    }
    // Generation writes no curriculum rows, so nothing to revalidate here.
    return draftCourseOutline(brief, session.user.id);
  }, "Failed to draft outline");
}

export async function applyOutlineAction(input: unknown) {
  return toActionResult(async () => {
    const session = await requireAdmin();
    const parsed = applyOutlineSchema.parse(input);
    const result = await applyCourseOutline(parsed, session.user.id);
    revalidatePath(`/admin/courses/${parsed.courseId}/curriculum`);
    // Outlines insert sections/lessons into a possibly published course whose
    // sales page renders them immediately.
    await revalidateCourseSales(parsed.courseId);
    return result;
  }, "Failed to add outline to curriculum");
}
