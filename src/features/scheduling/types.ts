// ============================================================================\
// SCHEDULING DOMAIN TYPES (Mission 08.1)
// ----------------------------------------------------------------------------
// Runtime-independent types shared across the scheduling domain. Enum types
// mirror the Zod schemas in schemas.ts; canonical interfaces describe the
// pure-data structures used by slot generation and hold management.
// ====================================================================

export type ConfirmationPolicy = "AUTO_CONFIRM" | "AHMED_APPROVAL" | "REQUEST_ONLY";
export type BookingAccessMode = "FREE" | "PAID_SESSION" | "MANUAL_INVOICE" | "PAYMENT_DISABLED";
export type MeetingMethod = "GOOGLE_MEET" | "EXTERNAL_LINK" | "PHONE" | "IN_PERSON" | "TO_BE_CONFIRMED";
export type SlotHoldStatus = "HELD" | "CONSUMED" | "RELEASED";

/** A canonical, policy-derived availability slot. startAt and endAt are UTC
 *  instants. slotKey is the deterministic business identity of the slot. */
export interface CanonicalSlot {
  startAt: Date;
  endAt: Date;
  slotKey: string;
}

/** The authoritative reason a hold acquisition was not granted. */
export type HoldRejectionReason =
  | "TAKEN"            // slot already held by a different owner
  | "CONSUMED"         // slot already booked/consumed
  | "UNAVAILABLE"      // booking type not found / inactive
  | "POLICY";          // requested start is not a valid canonical slot

/** INTERNAL representation: a slot hold WITH its ownership secret.
 *  This type is confined to the holds module. It MUST NEVER appear in a
 *  response to a caller who is not the legitimate owner of the lease. */
export interface SlotHoldLike {
  id: string;
  bookingTypeId: string;
  slotKey: string;
  startAt: Date;
  endAt: Date;
  ownerToken: string;
  /**
   * Server-issued idempotency identity for the logical booking attempt that
   * currently owns the lease.  Nullable: legacy holds created before this
   * column was introduced have no acquisition key and are treated as unique
   * logical attempts (different key every future acquire), preserving
   * backward compatibility.
   */
  acquisitionKey?: string | null;
  status: SlotHoldStatus;
  expiresAt: Date;
  consumedAt?: Date | null;
  releasedAt?: Date | null;
}

/** PUBLIC, safe view of a slot hold. Deliberately excludes `ownerToken` AND
 *  `acquisitionKey` — both are lease-internal. Safe to expose to ANY caller
 *  (winners and losers alike). */
export interface SafeHoldView {
  id: string;
  bookingTypeId: string;
  slotKey: string;
  startAt: Date;
  endAt: Date;
  status: SlotHoldStatus;
  expiresAt: Date;
  consumedAt?: Date | null;
  releasedAt?: Date | null;
}

// ---------------------------------------------------------------------------
// AcquireHoldResult — discriminated union on `success`
// ----------------------------------------------------------------------------
// The discriminated union enforces the secrecy/result contract at the type
// level:
//   - success === true  → hold, ownerToken, and acquisitionKey are REQUIRED.
//   - success === false → ownerToken and acquisitionKey are impossible (typed
//     as `undefined`), while `reason` is REQUIRED.
//
// `ownerToken` is server-generated (see generateOwnerToken in holds.ts) and is
// present ONLY when success === true, i.e. only delivered to the winning
// acquirer who is the legitimate owner of the lease. A losing caller never
// receives the current owner's token.
// ---------------------------------------------------------------------------

export interface AcquireHoldSuccess {
  success: true;
  hold: SafeHoldView;
  ownerToken: string;
  acquisitionKey: string;
}

export interface AcquireHoldFailure {
  success: false;
  hold?: SafeHoldView;
  // impossible / absent on failure — forces callers to check `success` first
  ownerToken?: undefined;
  acquisitionKey?: undefined;
  reason: HoldRejectionReason;
  error?: string;
}

export type AcquireHoldResult = AcquireHoldSuccess | AcquireHoldFailure;

/** A hold that has been released or consumed. */
export type MutateHoldResult = SafeHoldView;

/** Re-exported table types for consumers that need the full DB row shape. */
export type { BookingType, BookingAvailabilityWindow, SlotHold } from "@/lib/db";
