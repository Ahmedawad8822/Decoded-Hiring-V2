"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth";
import {
  createOffer,
  updateOffer,
} from "@/features/offers/service";
import {
  createOfferSchema,
  updateOfferSchema,
} from "@/features/offers/types";
import {
  approveBooking,
  cancelBooking,
  completeBooking,
  createAvailabilityWindow,
  createAvailabilityWindowSchema,
  createBookingType,
  createBookingTypeSchema,
  declineBooking,
  updateBookingType,
  updateBookingTypeSchema,
} from "@/features/scheduling";
import {
  manualPaymentSchema,
  recordManualPaymentForAdmin,
} from "@/features/commerce";
import { deleteAvailabilityWindow } from "@/features/scheduling/policy";

export type CommerceAdminActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

function fail(error: unknown, fallback: string): CommerceAdminActionState<never> {
  return {
    ok: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  };
}

function refreshCommerce() {
  revalidatePath("/admin/commerce");
  revalidatePath("/coaching");
  revalidatePath("/workshop");
  revalidatePath("/admin/courses");
}

export async function createOfferAdminAction(
  input: unknown,
): Promise<CommerceAdminActionState<{ id: string }>> {
  try {
    await requireAdmin();
    const parsed = createOfferSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((issue) => issue.message).join(", "),
      };
    }
    const created = await createOffer(parsed.data);
    refreshCommerce();
    return { ok: true, data: { id: created.id } };
  } catch (error: unknown) {
    return fail(error, "Failed to create Offer.");
  }
}

export async function updateOfferAdminAction(
  input: unknown,
): Promise<CommerceAdminActionState<{ id: string }>> {
  try {
    await requireAdmin();
    const parsed = updateOfferSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((issue) => issue.message).join(", "),
      };
    }
    const updated = await updateOffer(parsed.data);
    refreshCommerce();
    return { ok: true, data: { id: updated.id } };
  } catch (error: unknown) {
    return fail(error, "Failed to update Offer.");
  }
}

export async function createBookingTypeAdminAction(
  input: unknown,
): Promise<CommerceAdminActionState<{ id: string }>> {
  try {
    await requireAdmin();
    const parsed = createBookingTypeSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((issue) => issue.message).join(", "),
      };
    }
    const created = await createBookingType(parsed.data);
    refreshCommerce();
    return { ok: true, data: { id: created.id } };
  } catch (error: unknown) {
    return fail(error, "Failed to create booking type.");
  }
}

export async function updateBookingTypeAdminAction(
  input: unknown,
): Promise<CommerceAdminActionState<{ id: string }>> {
  try {
    await requireAdmin();
    const parsed = updateBookingTypeSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((issue) => issue.message).join(", "),
      };
    }
    const updated = await updateBookingType(parsed.data);
    refreshCommerce();
    return { ok: true, data: { id: updated.id } };
  } catch (error: unknown) {
    return fail(error, "Failed to update booking type.");
  }
}

export async function createAvailabilityWindowAdminAction(
  input: unknown,
): Promise<CommerceAdminActionState<{ id: string }>> {
  try {
    await requireAdmin();
    const parsed = createAvailabilityWindowSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((issue) => issue.message).join(", "),
      };
    }
    const created = await createAvailabilityWindow(parsed.data);
    refreshCommerce();
    return { ok: true, data: { id: created.id } };
  } catch (error: unknown) {
    return fail(error, "Failed to create availability window.");
  }
}

export async function deleteAvailabilityWindowAdminAction(
  id: string,
): Promise<CommerceAdminActionState<{ deleted: boolean }>> {
  try {
    await requireAdmin();
    const safeId = z.string().trim().min(1).parse(id);
    const deleted = await deleteAvailabilityWindow(safeId);
    refreshCommerce();
    return { ok: true, data: { deleted } };
  } catch (error: unknown) {
    return fail(error, "Failed to remove availability window.");
  }
}

const bookingDecisionActionSchema = z.object({
  action: z.enum(["approve", "decline", "cancel", "complete"]),
  bookingId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().max(2000).optional().nullable(),
});

export async function bookingDecisionAdminAction(
  input: unknown,
): Promise<CommerceAdminActionState<{ id: string; status: string }>> {
  try {
    await requireAdmin();
    const parsed = bookingDecisionActionSchema.parse(input);
    const now = new Date();
    const booking =
      parsed.action === "approve"
        ? await approveBooking({
            bookingId: parsed.bookingId,
            expectedVersion: parsed.expectedVersion,
            now,
          })
        : parsed.action === "decline"
          ? await declineBooking({
              bookingId: parsed.bookingId,
              expectedVersion: parsed.expectedVersion,
              reason: parsed.reason ?? null,
              now,
            })
          : parsed.action === "cancel"
            ? await cancelBooking({
                bookingId: parsed.bookingId,
                expectedVersion: parsed.expectedVersion,
                reason: parsed.reason ?? null,
                now,
              })
            : await completeBooking({
                bookingId: parsed.bookingId,
                expectedVersion: parsed.expectedVersion,
                now,
              });

    refreshCommerce();
    return { ok: true, data: { id: booking.id, status: booking.status } };
  } catch (error: unknown) {
    return fail(error, "Failed to update booking.");
  }
}

const manualPaymentActionSchema = manualPaymentSchema
  .omit({ now: true })
  .extend({
    orderId: z.string().trim().min(1),
    expectedVersion: z.number().int().positive(),
  });

export async function recordManualPaymentAdminAction(
  input: unknown,
): Promise<CommerceAdminActionState<{ id: string; status: string }>> {
  try {
    await requireAdmin();
    const parsed = manualPaymentActionSchema.parse(input);
    const order = await recordManualPaymentForAdmin({
      ...parsed,
      now: new Date(),
    });
    refreshCommerce();
    return { ok: true, data: { id: order.id, status: order.status } };
  } catch (error: unknown) {
    return fail(error, "Failed to record manual payment.");
  }
}
