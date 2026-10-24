// ============================================================================
// DRAFTS — SERVER ACTIONS
// ----------------------------------------------------------------------------
// Server Actions for the editorial draft lifecycle:
//   generate → update → submit → approve/reject → publish
// Each action validates auth, calls the service, and revalidates the relevant
// admin paths.
// ============================================================================

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  generateDraft,
  updateDraft,
  submitForReview,
  sendBack,
  approve,
  rejectDraft,
  recoverRejected,
  publishDraft,
} from "./service";
import type { GenerateDraftInput, UpdateDraftInput, ReviewNoteInput } from "./types";
import { generateDraftSchema, updateDraftSchema, reviewNoteSchema } from "./types";

export async function generateDraftAction(input: GenerateDraftInput) {
  const session = await requireAdmin();
  const parsedInput = generateDraftSchema.parse(input);
  // EXPLICIT TEST-ONLY (Mission 07 §2): when EDITORIAL_FORCE_FAKE_PROVIDER=1
  // is set, inject FakeProvider so the E2E suite exercises the full generation
  // pipeline without real API credentials. Opt-in via env-var gate — there is
  // NEVER a silent FakeProvider fallback in production code.
  if (
    process.env.EDITORIAL_FORCE_FAKE_PROVIDER === "1" &&
    process.env.NODE_ENV !== "production"
  ) {
    const { FakeProvider } = await import("../providers/fake");
    const draft = await generateDraft(parsedInput, session.user.id, { provider: new FakeProvider() });
    revalidatePath("/admin/editorial");
    return draft;
  }
  const draft = await generateDraft(parsedInput, session.user.id);
  revalidatePath("/admin/editorial");
  return draft;
}

export async function updateDraftAction(id: string, input: UpdateDraftInput) {
  const session = await requireAdmin();
  const parsedInput = updateDraftSchema.parse(input);
  const draft = await updateDraft(id, parsedInput, session.user.id);
  revalidatePath(`/admin/editorial/${id}`);
  revalidatePath("/admin/editorial");
  return draft;
}

export async function submitForReviewAction(id: string) {
  const session = await requireAdmin();
  const draft = await submitForReview(id, session.user.id);
  revalidatePath(`/admin/editorial/${id}`);
  revalidatePath("/admin/editorial");
  return draft;
}

export async function sendBackAction(id: string, input?: ReviewNoteInput) {
  const session = await requireAdmin();
  const parsedInput = reviewNoteSchema.parse(input ?? {});
  const draft = await sendBack(id, session.user.id, parsedInput.note);
  revalidatePath(`/admin/editorial/${id}`);
  revalidatePath("/admin/editorial");
  return draft;
}

export async function approveAction(id: string) {
  const session = await requireAdmin();
  const draft = await approve(id, session.user.id);
  revalidatePath(`/admin/editorial/${id}`);
  revalidatePath("/admin/editorial");
  revalidatePath("/admin/content");
  return draft;
}

export async function rejectDraftAction(id: string, input?: ReviewNoteInput) {
  const session = await requireAdmin();
  const parsedInput = reviewNoteSchema.parse(input ?? {});
  const draft = await rejectDraft(id, session.user.id, parsedInput.note);
  revalidatePath(`/admin/editorial/${id}`);
  revalidatePath("/admin/editorial");
  return draft;
}

export async function recoverRejectedAction(id: string, input?: ReviewNoteInput) {
  const session = await requireAdmin();
  const parsedInput = reviewNoteSchema.parse(input ?? {});
  const draft = await recoverRejected(id, session.user.id, parsedInput.note);
  revalidatePath(`/admin/editorial/${id}`);
  revalidatePath("/admin/editorial");
  return draft;
}

export async function publishDraftAction(id: string) {
  const session = await requireAdmin();
  const result = await publishDraft(id, session.user.id);
  revalidatePath(`/admin/editorial/${id}`);
  revalidatePath("/admin/editorial");
  revalidatePath("/admin/content");
  return { ...result, success: true };
}
