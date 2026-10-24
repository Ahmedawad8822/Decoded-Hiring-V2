import { z } from "zod";

import { createOffer, updateOffer } from "@/features/offers/service";
import { createOfferSchema, updateOfferSchema } from "@/features/offers/types";
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
import { deleteAvailabilityWindow } from "@/features/scheduling/policy";
import { SchedulingDomainError } from "@/features/scheduling/errors";
import {
  CommerceDomainError,
  manualPaymentSchema,
  recordManualPaymentForAdmin,
} from "@/features/commerce";

export type CommerceAdminActionState<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export type CommerceAdminGuard = () => Promise<unknown>;

type AdminOperationDependencies = {
  approveBooking: typeof approveBooking;
  declineBooking: typeof declineBooking;
  cancelBooking: typeof cancelBooking;
  completeBooking: typeof completeBooking;
  recordManualPayment: typeof recordManualPaymentForAdmin;
};

const productionDependencies: AdminOperationDependencies = {
  approveBooking,
  declineBooking,
  cancelBooking,
  completeBooking,
  recordManualPayment: recordManualPaymentForAdmin,
};

const SAFE_BUSINESS_ERROR =
  /^(An offer|This course|This booking type|Linked course|Linked booking type|COURSE offers|COACHING offers|WORKSHOP offers|Standalone PRODUCT offers|PAID_|An offer with an amount|FREE offers|Alternative CTA|PAYMENT_DISABLED|COMING_SOON|Offer not found|Booking access is owned by linked Offer)/i;

function fail(
  error: unknown,
  fallback: string,
): CommerceAdminActionState<never> {
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      error: error.issues.map((issue) => issue.message).join(", "),
    };
  }
  if (
    error instanceof SchedulingDomainError ||
    error instanceof CommerceDomainError
  ) {
    return { ok: false, error: error.message };
  }
  if (error instanceof Error && SAFE_BUSINESS_ERROR.test(error.message)) {
    return { ok: false, error: error.message };
  }
  return { ok: false, error: fallback };
}

const bookingDecisionActionSchema = z.object({
  action: z.enum(["approve", "decline", "cancel", "complete"]),
  bookingId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(2000).optional().nullable(),
});

const manualPaymentActionSchema = manualPaymentSchema
  .omit({ now: true })
  .extend({
    orderId: z.string().trim().min(1),
    expectedVersion: z.number().int().positive(),
    note: z
      .string()
      .trim()
      .min(5, "Add a payment reference or evidence note.")
      .max(2000),
  });

export function createCommerceAdminOperations(
  guard: CommerceAdminGuard,
  clock: () => Date = () => new Date(),
  dependencies: AdminOperationDependencies = productionDependencies,
) {
  return {
    async createOffer(
      input: unknown,
    ): Promise<CommerceAdminActionState<{ id: string }>> {
      try {
        await guard();
        const parsed = createOfferSchema.parse(input);
        const created = await createOffer(parsed);
        return { ok: true, data: { id: created.id } };
      } catch (error: unknown) {
        return fail(error, "Failed to create Offer.");
      }
    },

    async updateOffer(
      input: unknown,
    ): Promise<CommerceAdminActionState<{ id: string }>> {
      try {
        await guard();
        const parsed = updateOfferSchema.parse(input);
        const updated = await updateOffer(parsed);
        return { ok: true, data: { id: updated.id } };
      } catch (error: unknown) {
        return fail(error, "Failed to update Offer.");
      }
    },

    async createBookingType(
      input: unknown,
    ): Promise<CommerceAdminActionState<{ id: string }>> {
      try {
        await guard();
        const parsed = createBookingTypeSchema.parse(input);
        const created = await createBookingType(parsed);
        return { ok: true, data: { id: created.id } };
      } catch (error: unknown) {
        return fail(error, "Failed to create booking type.");
      }
    },

    async updateBookingType(
      input: unknown,
    ): Promise<CommerceAdminActionState<{ id: string }>> {
      try {
        await guard();
        const parsed = updateBookingTypeSchema.parse(input);
        const updated = await updateBookingType(parsed);
        return { ok: true, data: { id: updated.id } };
      } catch (error: unknown) {
        return fail(error, "Failed to update booking type.");
      }
    },

    async createAvailabilityWindow(
      input: unknown,
    ): Promise<CommerceAdminActionState<{ id: string }>> {
      try {
        await guard();
        const parsed = createAvailabilityWindowSchema.parse(input);
        const created = await createAvailabilityWindow(parsed);
        return { ok: true, data: { id: created.id } };
      } catch (error: unknown) {
        return fail(error, "Failed to create availability window.");
      }
    },

    async deleteAvailabilityWindow(
      id: unknown,
    ): Promise<CommerceAdminActionState<{ deleted: boolean }>> {
      try {
        await guard();
        const safeId = z.string().trim().min(1).parse(id);
        const deleted = await deleteAvailabilityWindow(safeId);
        return { ok: true, data: { deleted } };
      } catch (error: unknown) {
        return fail(error, "Failed to remove availability window.");
      }
    },

    async bookingDecision(
      input: unknown,
    ): Promise<
      CommerceAdminActionState<{ id: string; status: string }>
    > {
      try {
        await guard();
        const parsed = bookingDecisionActionSchema.parse(input);
        if (
          (parsed.action === "decline" || parsed.action === "cancel") &&
          !parsed.reason
        ) {
          return {
            ok: false,
            error: "Add a reason before declining or cancelling a booking.",
          };
        }

        const now = clock();
        const booking =
          parsed.action === "approve"
            ? await dependencies.approveBooking({
                bookingId: parsed.bookingId,
                expectedVersion: parsed.expectedVersion,
                now,
              })
            : parsed.action === "decline"
              ? await dependencies.declineBooking({
                  bookingId: parsed.bookingId,
                  expectedVersion: parsed.expectedVersion,
                  reason: parsed.reason ?? null,
                  now,
                })
              : parsed.action === "cancel"
                ? await dependencies.cancelBooking({
                    bookingId: parsed.bookingId,
                    expectedVersion: parsed.expectedVersion,
                    reason: parsed.reason ?? null,
                    now,
                  })
                : await dependencies.completeBooking({
                    bookingId: parsed.bookingId,
                    expectedVersion: parsed.expectedVersion,
                    now,
                  });

        return {
          ok: true,
          data: { id: booking.id, status: booking.status },
        };
      } catch (error: unknown) {
        return fail(error, "Failed to update booking.");
      }
    },

    async recordManualPayment(
      input: unknown,
    ): Promise<
      CommerceAdminActionState<{ id: string; status: string }>
    > {
      try {
        await guard();
        const parsed = manualPaymentActionSchema.parse(input);
        const order = await dependencies.recordManualPayment({
          ...parsed,
          now: clock(),
        });
        return {
          ok: true,
          data: { id: order.id, status: order.status },
        };
      } catch (error: unknown) {
        return fail(error, "Failed to record manual payment.");
      }
    },
  };
}
