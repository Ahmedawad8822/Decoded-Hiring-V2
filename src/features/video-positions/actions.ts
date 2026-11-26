"use server";

import { requireUser } from "@/lib/auth";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { saveMyVideoPosition } from "./service";
import { saveVideoPositionSchema } from "./types";

// ============================================================================
// VIDEO POSITION ACTIONS (learner polish)
// ----------------------------------------------------------------------------
// New actions return ActionResult via toActionResult. Enrolled-only: the
// service scopes every write to the signed-in learner's own row on an
// unlocked lesson of an enrolled course. No revalidation: nothing else on
// the page reads the position except the initial server load.
// ============================================================================

export async function saveVideoPositionAction(
  input: unknown,
): Promise<ActionResult<{ positionSeconds: number; durationSeconds: number | null }>> {
  return toActionResult(async () => {
    const session = await requireUser();
    // Zod failures are flattened to messages by toActionResult.
    const parsed = saveVideoPositionSchema.parse(input);
    const row = await saveMyVideoPosition(session.user.id, {
      courseSlug: parsed.courseSlug,
      lessonSlug: parsed.lessonSlug,
      positionSeconds: parsed.positionSeconds,
      durationSeconds: parsed.durationSeconds ?? null,
    });
    return { positionSeconds: row.positionSeconds, durationSeconds: row.durationSeconds };
  }, "Could not save the video position");
}
