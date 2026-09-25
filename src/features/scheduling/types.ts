// ============================================================================
// SCHEDULING DOMAIN TYPES (Mission 08.1)
// ----------------------------------------------------------------------------
// Runtime-independent types shared across the scheduling domain. Enum types
// mirror the Zod schemas in schemas.ts; canonical interfaces describe the
// pure-data structures used by slot generation and hold management.
// ============================================================================

export type ConfirmationPolicy = "AUTO_CONFIRM" | "AHMED_APPROVAL" | "REQUEST_ONLY";
export type BookingAccessMode = "FREE" | "PAID_SESSION" | "MANUAL_INVOICE" | "PAYMENT_DISABLED";
export type MeetingMethod = "GOOGLE_MEET" | "EXTERNAL_LINK" | "PHONE" | "IN_PERSON" | "TO_BE_CONFIRMED";
export type SlotHoldStatus = "HELD" | "CONSUMED" | "RELEASED";

// A canonical, policy-derived availability slot. startAt and endAt are UTC
// instants. slotKey is the deterministic business identity of the slot.
export interface CanonicalSlot {
  startAt: Date;
  endAt: Date;
  slotKey: string;
}

// Outcome of an acquireSlotHold call.
export interface AcquireHoldResult {
  success: boolean;
  hold?: SlotHoldLike;
  reason?: "TAKEN" | "CONSUMED";
}

// A minimal view of a slot hold, decoupled from the DB row type so the holds
// module can reason about ownership without importing the full schema.
export interface SlotHoldLike {
  id: string;
  bookingTypeId: string;
  slotKey: string;
  startAt: Date;
  endAt: Date;
  ownerToken: string;
  status: SlotHoldStatus;
  expiresAt: Date;
  consumedAt?: Date | null;
  releasedAt?: Date | null;
}

// Re-exported table types for consumers that need the full DB row shape.
export type { BookingType, BookingAvailabilityWindow, SlotHold } from "@/lib/db";
