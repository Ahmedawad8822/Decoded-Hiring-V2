"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { AppError } from "@/lib/errors";
import { recordAdminAudit } from "@/features/audit/service";
import { isLeadStatus, transitionLead } from "./admin";
import type { LeadSubmissionStatus } from "./types";

type TransitionData = { id: string; status: LeadSubmissionStatus };

async function runTransition(
  action: string,
  id: unknown,
  expected: unknown,
  to: LeadSubmissionStatus
): Promise<TransitionData> {
  const session = await requireAdmin();
  if (typeof id !== "string" || !id || !isLeadStatus(expected)) {
    throw new AppError("invalid", "Invalid lead request");
  }
  const result = await transitionLead({ id, from: expected, to });
  // Audit details: status change only. Never lead fields (PII).
  await recordAdminAudit({
    actorId: session.user.id,
    action,
    entityType: "lead",
    entityId: id,
    details: { from: result.from, to: result.to },
  });
  revalidatePath("/admin/leads");
  revalidatePath(`/admin/leads/${id}`);
  return { id, status: result.to };
}

export async function reviewLeadAction(
  id: string,
  expectedStatus: string
): Promise<ActionResult<TransitionData>> {
  return toActionResult(
    () => runTransition("lead.review", id, expectedStatus, "REVIEWED"),
    "Could not update the lead"
  );
}

export async function closeLeadAction(
  id: string,
  expectedStatus: string
): Promise<ActionResult<TransitionData>> {
  return toActionResult(
    () => runTransition("lead.close", id, expectedStatus, "CLOSED"),
    "Could not update the lead"
  );
}

export async function reopenLeadAction(
  id: string,
  expectedStatus: string
): Promise<ActionResult<TransitionData>> {
  return toActionResult(
    () => runTransition("lead.reopen", id, expectedStatus, "NEW"),
    "Could not update the lead"
  );
}
