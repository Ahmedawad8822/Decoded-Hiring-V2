// ====================================================================
// SLOT HOLD MANAGEMENT (Mission 08.1)
// ----------------------------------------------------------------------------
// Concurrency-safe slot hold lease with atomic CAS boundaries.
//
// Invariants:
//   - UNIQUE(slotKey) is the authoritative DB backstop: exactly one row
//     represents ownership of any canonical slot at any time.
//   - Expired/released holds are reclaimed by UPDATE (not INSERT), so the
//     row is replaced rather than stacked.
//   - All write mutations use CAS conditions (ownerToken + status + expiresAt)
//     so a stale owner cannot mutate a newer lease.
//
// SECURITY MODEL (Mission 08.1 remediation):
//   - The ownership secret (ownerToken) is ALWAYS server-generated
//     (generateOwnerToken). Browser input never chooses the authoritative
//     lease token.
//   - The `hold` exposed in every result is a SafeHoldView: it NEVER carries
//     ownerToken. ownerToken is returned to the caller ONLY on a successful
//     acquisition, and only so the winner can later release/consume its own
//     lease. A losing caller never observes another owner's token.
//   - Acquisition is authoritative: startAt/endAt/slotKey are derived from the
//     booking type's policy server-side; caller-supplied wall-clock values are
//     validated against the canonical slot set rather than trusted.
//
// ACQUISITION IDEMPOTENCY (Mission 08.1 remediation §1):
//   - `acquisitionKey` is a high-entropy identity (UUID) for a LOGICAL booking
//     attempt. It is separate from — and NOT interchangeable with — the lease
//     ownerToken. A caller generates one per booking attempt and re-sends it
//     on retry so a lost successful response can be recovered idempotently.
//   - SAME acquisitionKey + same canonical slot + HELD + unexpired → returns
//     the existing lease (same ownerToken, NO TTL extension).
//   - DIFFERENT acquisitionKey → TAKEN (no token leak).
//   - CONSUMED remains terminal even for the same acquisitionKey.
//   - The ownerToken remains server-generated and is never derived from or
//     replaceable by the acquisitionKey.
//
// ERROR BOUNDARY (Mission 08.1 remediation §3):
//   - Domain-state errors (HOLD_NOT_FOUND, NOT_OWNER, WRONG_STATE, EXPIRED,
//     CONCURRENT_MODIFICATION) throw SchedulingDomainError.
//   - Provider adapter failures (payment/calendar/etc.) throw SchedulingProviderError.
//   - Core hold modules depend ONLY on SchedulingDomainError, never on the
//     provider module.
// ====================================================================

import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { slotHolds } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { buildSlotKey, generateCandidateSlots } from "./availability";
import { getBookingTypeById, getBookingTypeWindows } from "./policy";
import { SchedulingDomainError } from "./errors";
import type { SchedulingDomainErrorCode } from "./errors";
import { acquireSlotHoldSchema, mutateSlotHoldSchema } from "./schemas";
import type { AcquireSlotHoldInput } from "./schemas";
import type {
  SlotHold,
  SlotHoldLike,
  SafeHoldView,
  AcquireHoldResult,
  CanonicalSlot,
} from "./types";
import type { BookingType, BookingAvailabilityWindow } from "@/lib/db";

const MS_PER_MINUTE = 60_000;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * Generate a server-side, cryptographically-random ownership token for a slot
 * lease. Uses the platform CSPRNG via `crypto.randomUUID()` (UUID v4, ~122 bits
 * of entropy) prefixed with a domain marker.
 *
 * The token is NOT derived from the booking type, the caller, a timestamp, or
 * the slot key — it is opaque and unguessable, which is what makes it a sound
 * lease identity.
 *
 * FUTURE PUBLIC-ACTION RULE: browser input must never choose or influence the
 * authoritative lease token. Acquisition always calls this server-side and
 * delivers the resulting secret ONLY to the winning acquirer. A browser may
 * only PRESENT a previously-issued token to release/consume its own lease.
 */
export function generateOwnerToken(): string {
  return `hold_${crypto.randomUUID()}`;
}

/**
 * Generate a high-entropy acquisition/idempotency key for a logical booking
 * attempt. The caller creates one before each booking attempt and re-sends it
 * on retry so a lost successful response can be recovered idempotently.
 *
 * This is NOT a lease token — it is an idempotency identity only. It can never
 * become the authoritative ownerToken, and it is safe to transmit in requests.
 */
export function generateAcquisitionKey(): string {
  return crypto.randomUUID();
}

/** Convert a DB row into the public, token-free safe view. */
export function safeView(hold: SlotHold): SafeHoldView {
  return {
    id: hold.id,
    bookingTypeId: hold.bookingTypeId,
    slotKey: hold.slotKey,
    startAt: hold.startAt,
    endAt: hold.endAt,
    status: hold.status,
    expiresAt: hold.expiresAt,
    consumedAt: hold.consumedAt,
    releasedAt: hold.releasedAt,
  };
}

/**
 * Resolve a requested startAt into the canonical slot it corresponds to under
 * the booking type's policy. generateCandidateSlots is the single source of
 * truth for "what is a valid slot" (within-window, duration-aligned, within
 * notice/horizon, correct local weekday, DST-safe). We then require an exact
 * match between the requested startAt and a generated candidate.
 *
 * Returns the canonical { startAt, endAt, slotKey } — with endAt derived from
 * the booking type's duration (caller cannot influence endAt) — or null if the
 * requested startAt is not a valid canonical slot.
 */
async function resolveCanonicalSlot(
  bookingType: BookingType,
  windows: BookingAvailabilityWindow[],
  requestedStartAt: Date,
  now: Date,
): Promise<CanonicalSlot | null> {
  const rangeStart = new Date(requestedStartAt);
  const rangeEnd = new Date(
    requestedStartAt.getTime() + bookingType.durationMinutes * MS_PER_MINUTE,
  );
  const candidates = generateCandidateSlots({
    bookingType,
    windows,
    rangeStart,
    rangeEnd,
    now,
  });
  return (
    candidates.find(
      (c) => c.startAt.getTime() === requestedStartAt.getTime(),
    ) ?? null
  );
}

/**
 * Acquire (or re-acquire) a lease on a canonical slot.
 *
 * CASE A — slot does not exist -> INSERT a new HELD row (owner wins).
 *   On UNIQUE(slotKey) race (two callers INSERT simultaneously): the loser
 *   re-reads and returns the winner's hold as unavailable.
 *
 * CASE A-IDEM — idempotent retry: if the caller supplies an `acquisitionKey`
 *   that matches an existing HELD + unexpired hold for the same slot, return
 *   that hold's ownerToken WITHOUT inserting a new row or extending TTL.
 *   This recovers a lost successful response securely.
 *
 * CASE B — HELD + unexpired + DIFFERENT acquisition key -> reject (TAKEN).
 *   The caller receives a safe view only — never the winner's ownerToken.
 *
 * CASE C — HELD + expired -> atomic reclaim via CAS UPDATE (new owner).
 * CASE D — RELEASED -> atomic re-acquire via CAS UPDATE (new owner).
 * CASE E — CONSUMED -> reject (CONSUMED). Terminal even for same acquisitionKey.
 *
 * The returned `hold` is a SafeHoldView (never carries ownerToken). The
 * server-generated `ownerToken` is returned ONLY when success === true.
 * The `acquisitionKey` is echoed back on success so the caller can retry
 * idempotently if the response is lost.
 */
export async function acquireSlotHold(
  input: AcquireSlotHoldInput,
): Promise<AcquireHoldResult> {
  // (C) Runtime validation at the boundary.
  const parsed = acquireSlotHoldSchema.parse(input);
  const { bookingTypeId, startAt, now, ttlMinutes, acquisitionKey } = parsed;

  // If the caller supplied an acquisitionKey, use it; otherwise generate one.
  const effectiveAcquisitionKey = acquisitionKey ?? generateAcquisitionKey();

  const db = await getDb();

  // (D) Authoritative acquisition: enforce scheduling policy server-side.
  const bookingType = await getBookingTypeById(bookingTypeId);
  if (!bookingType) {
    return {
      success: false,
      reason: "UNAVAILABLE",
      error: `Booking type not found: ${bookingTypeId}.`,
    };
  }
  if (!bookingType.active) {
    return {
      success: false,
      reason: "POLICY",
      error: "Booking type is inactive; slots cannot be acquired.",
    };
  }

  const windows = await getBookingTypeWindows(bookingTypeId);
  const canonical = await resolveCanonicalSlot(bookingType, windows, startAt, now);
  if (!canonical) {
    return {
      success: false,
      reason: "POLICY",
      error:
        "Requested startAt is not a valid canonical slot under this booking type's availability policy (off-hours, non-aligned time, or outside notice/horizon).",
    };
  }

  const { startAt: canonicalStart, endAt: canonicalEnd, slotKey } = canonical;
  // (B) Server-generated ownership secret — never sourced from caller input.
  const ownerToken = generateOwnerToken();
  const expiresAt = new Date(now.getTime() + ttlMinutes * MS_PER_MINUTE);

  // CASE A / race / CAS — keyed on the canonical slot.
  const existing = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey))
    .get();

  if (!existing) {
    // CASE A — no existing hold. INSERT.
    const id = newId("sh");
    try {
      await db.insert(slotHolds).values({
        id,
        bookingTypeId,
        slotKey,
        startAt: canonicalStart,
        endAt: canonicalEnd,
        ownerToken,
        acquisitionKey: effectiveAcquisitionKey,
        status: "HELD" as const,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error: unknown) {
      // CASE A race lost — another caller inserted first.
      if (isUniqueConstraintError(error)) {
        const winner = await db
          .select()
          .from(slotHolds)
          .where(eq(slotHolds.slotKey, slotKey))
          .get();
        if (winner) {
          // (A) Loser gets a SAFE view only — never the winner's ownerToken.
          return classifyUnavailableHold(winner);
        }
        throw new Error(
          "Slot hold unique constraint violation but row not found on re-read.",
        );
      }
      throw error;
    }

    const created = await db
      .select()
      .from(slotHolds)
      .where(eq(slotHolds.slotKey, slotKey))
      .get();
    return {
      success: true,
      hold: safeView(created!),
      ownerToken,
      acquisitionKey: effectiveAcquisitionKey,
    };
  }

  // --- Idempotency check (CASE A-IDEM) ---
  // Same acquisitionKey + HELD + unexpired → recover existing lease without
  // inserting a new row or extending TTL. This is the secure idempotency
  // path: the caller proves this is the same logical attempt via the
  // acquisitionKey, and receives back the SAME ownerToken they would have
  // gotten on the first (lost) response.
  if (
    existing.acquisitionKey === effectiveAcquisitionKey &&
    existing.status === "HELD" &&
    existing.expiresAt > now
  ) {
    return {
      success: true,
      hold: safeView(existing),
      ownerToken: existing.ownerToken,
      acquisitionKey: effectiveAcquisitionKey,
    };
  }

  // --- Existing hold: classify by state (CASE B / C / D / E) ---
  // Any acquisitionKey that doesn't match the idempotency above (including
  // a DIFFERENT acquisitionKey, an expired hold for the same key, or a
  // key-less hold) falls through to normal reclaim/classify logic.
  if (existing.status === "CONSUMED") {
    // CASE E — terminal, even for same acquisitionKey.
    return classifyUnavailableHold(existing);
  }
  const isHeldUnexpired = existing.status === "HELD" && existing.expiresAt > now;
  if (isHeldUnexpired) {
    // CASE B — held + unexpired + different acquisition key (or no idempotency
    // match) → reject (TAKEN). Safe view only, never the winner's token.
    return classifyUnavailableHold(existing);
  }
  // CASE C (expired HELD) or CASE D (RELEASED) — reclaim via CAS UPDATE.
  // Any caller may reclaim an expired or released lease.
  return reclaimSlot(
    existing,
    ownerToken,
    effectiveAcquisitionKey,
    bookingTypeId,
    slotKey,
    canonicalStart,
    canonicalEnd,
    expiresAt,
    now,
    db,
  );
}

/**
 * Classify an existing hold during acquire/reclaim-reread as unavailable.
 * ALWAYS returns a SafeHoldView (no ownerToken) so a losing caller can never
 * observe the current owner's lease secret.
 */
function classifyUnavailableHold(hold: SlotHold): AcquireHoldResult {
  const reason: "TAKEN" | "CONSUMED" =
    hold.status === "CONSUMED" ? "CONSUMED" : "TAKEN";
  return {
    success: false,
    hold: safeView(hold),
    reason,
    error:
      reason === "CONSUMED"
        ? "Slot is already consumed and cannot be acquired."
        : "Slot is already held by another owner.",
  };
}

/**
 * Atomically reclaim a slot via CAS UPDATE.
 *
 * The WHERE clause locks on (slotKey, ownerToken, status, expiresAt) so that
 * if any of those changed since the read (e.g. another caller won a race, or
 * the owner already re-acquired), the UPDATE affects 0 rows and we fall back
 * to a re-read + classify.
 */
async function reclaimSlot(
  existing: SlotHoldLike,
  newOwnerToken: string,
  newAcquisitionKey: string,
  bookingTypeId: string,
  slotKey: string,
  startAt: Date,
  endAt: Date,
  expiresAt: Date,
  now: Date,
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<AcquireHoldResult> {
  const updated = await db
    .update(slotHolds)
    .set({
      ownerToken: newOwnerToken,
      acquisitionKey: newAcquisitionKey,
      status: "HELD" as const,
      expiresAt,
      consumedAt: null,
      releasedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(slotHolds.slotKey, slotKey),
        eq(slotHolds.ownerToken, existing.ownerToken),
        eq(slotHolds.status, existing.status),
        eq(slotHolds.expiresAt, existing.expiresAt),
      ),
    )
    .returning()
    .get();

  if (updated) {
    return {
      success: true,
      hold: safeView(updated),
      ownerToken: newOwnerToken,
      acquisitionKey: newAcquisitionKey,
    };
  }

  // CAS lost — re-read and classify the current state.
  const reread = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey))
    .get();

  if (!reread) {
    // Slot was deleted between read and CAS — treat as available, INSERT.
    const id = newId("sh");
    try {
      await db.insert(slotHolds).values({
        id,
        bookingTypeId,
        slotKey,
        startAt,
        endAt,
        ownerToken: newOwnerToken,
        acquisitionKey: newAcquisitionKey,
        status: "HELD",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        const winner = await db
          .select()
          .from(slotHolds)
          .where(eq(slotHolds.slotKey, slotKey))
          .get();
        if (winner) {
          return classifyUnavailableHold(winner);
        }
        throw new Error(
          "Slot hold unique constraint violation but row not found on re-read.",
        );
      }
      throw error;
    }
    const created = await db
      .select()
      .from(slotHolds)
      .where(eq(slotHolds.slotKey, slotKey))
      .get();
    return {
      success: true,
      hold: safeView(created!),
      ownerToken: newOwnerToken,
      acquisitionKey: newAcquisitionKey,
    };
  }

  return classifyUnavailableHold(reread);
}

/**
 * Release a hold lease. Only the current owner of an unconsumed, unexpired
 * HELD lease may release it.
 *
 * CAS boundary: (slotKey, ownerToken, status='HELD', expiresAt=current).
 * A stale owner (whose token no longer matches) gets 0 rows updated.
 *
 * Domain-state errors (HOLD_NOT_FOUND, NOT_OWNER, WRONG_STATE, EXPIRED,
 * CONCURRENT_MODIFICATION) throw SchedulingDomainError — NOT
 * SchedulingProviderError (which is reserved for provider-adapter failures).
 */
export async function releaseSlotHold(
  bookingTypeId: string,
  startAt: Date,
  ownerToken: string,
  now: Date,
): Promise<void> {
  // (C) Runtime validation at the boundary.
  const parsed = mutateSlotHoldSchema.parse({
    bookingTypeId,
    startAt,
    ownerToken,
    now,
  });
  const db = await getDb();
  const slotKey = buildSlotKey(parsed.bookingTypeId, parsed.startAt);

  const existing = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey))
    .get();

  if (!existing) {
    throw new SchedulingDomainError("Slot hold not found.", "HOLD_NOT_FOUND");
  }
  if (existing.ownerToken !== parsed.ownerToken) {
    throw new SchedulingDomainError(
      "Only the current owner can release this hold.",
      "NOT_OWNER",
    );
  }
  if (existing.status !== "HELD") {
    throw new SchedulingDomainError(
      `Cannot release a ${existing.status} hold.`,
      "WRONG_STATE",
    );
  }
  if (existing.expiresAt <= parsed.now) {
    throw new SchedulingDomainError(
      "Hold has expired; cannot release an expired lease.",
      "EXPIRED",
    );
  }

  const updated = await db
    .update(slotHolds)
    .set({
      status: "RELEASED" as const,
      releasedAt: parsed.now,
      updatedAt: parsed.now,
    })
    .where(
      and(
        eq(slotHolds.slotKey, slotKey),
        eq(slotHolds.ownerToken, parsed.ownerToken),
        eq(slotHolds.status, "HELD"),
        gt(slotHolds.expiresAt, parsed.now),
        eq(slotHolds.expiresAt, existing.expiresAt),
      ),
    )
    .returning()
    .get();

  if (!updated) {
    // CAS lost — re-read to give a precise, consistent error.
    const reread = await db
      .select()
      .from(slotHolds)
      .where(eq(slotHolds.slotKey, slotKey))
      .get();
    if (!reread) {
      throw new SchedulingDomainError(
        "Slot hold was deleted before release could complete.",
        "HOLD_NOT_FOUND",
      );
    }
    if (reread.ownerToken !== parsed.ownerToken) {
      throw new SchedulingDomainError(
        "Only the current owner can release this hold.",
        "NOT_OWNER",
      );
    }
    if (reread.status !== "HELD") {
      throw new SchedulingDomainError(
        `Cannot release a ${reread.status} hold.`,
        "WRONG_STATE",
      );
    }
    if (reread.expiresAt <= parsed.now) {
      throw new SchedulingDomainError(
        "Hold has expired; cannot release an expired lease.",
        "EXPIRED",
      );
    }
    throw new SchedulingDomainError(
      "Release failed: concurrent modification detected.",
      "CONCURRENT_MODIFICATION",
    );
  }
}

/**
 * Consume a hold lease (HELD -> CONSUMED).
 *
 * Rules:
 * - Hold must be unexpired (expiresAt > now).
 * - Exact current owner token required (CAS on ownerToken).
 * - Stale owner cannot consume (CAS fails).
 * - RELEASED cannot be consumed (status check).
 * - CONSUMED by same owner is idempotent (re-CAS succeeds with 0 rows).
 *
 * Domain-state errors throw SchedulingDomainError.
 */
export async function consumeSlotHold(
  bookingTypeId: string,
  startAt: Date,
  ownerToken: string,
  now: Date,
): Promise<SafeHoldView | null> {
  // (C) Runtime validation at the boundary.
  const parsed = mutateSlotHoldSchema.parse({
    bookingTypeId,
    startAt,
    ownerToken,
    now,
  });
  const db = await getDb();
  const slotKey = buildSlotKey(parsed.bookingTypeId, parsed.startAt);

  const existing = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey))
    .get();

  if (!existing) {
    throw new SchedulingDomainError("Slot hold not found.", "HOLD_NOT_FOUND");
  }
  if (existing.ownerToken !== parsed.ownerToken) {
    throw new SchedulingDomainError(
      "Only the current owner can consume this hold.",
      "NOT_OWNER",
    );
  }
  if (existing.status === "RELEASED") {
    throw new SchedulingDomainError(
      "Cannot consume a RELEASED hold.",
      "WRONG_STATE",
    );
  }
  if (existing.status === "CONSUMED") {
    // Idempotent re-consume by the same owner.
    return safeView(existing);
  }
  if (existing.expiresAt <= parsed.now) {
    throw new SchedulingDomainError(
      "Hold has expired; cannot consume an expired lease.",
      "EXPIRED",
    );
  }

  const updated = await db
    .update(slotHolds)
    .set({
      status: "CONSUMED" as const,
      consumedAt: parsed.now,
      updatedAt: parsed.now,
    })
    .where(
      and(
        eq(slotHolds.slotKey, slotKey),
        eq(slotHolds.ownerToken, parsed.ownerToken),
        eq(slotHolds.status, "HELD"),
        gt(slotHolds.expiresAt, parsed.now),
        eq(slotHolds.expiresAt, existing.expiresAt),
      ),
    )
    .returning()
    .get();

  if (updated) {
    return safeView(updated);
  }

  // CAS lost — re-read to classify.
  const reread = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey))
    .get();
  if (!reread) {
    throw new SchedulingDomainError(
      "Slot hold was deleted before consume could complete.",
      "HOLD_NOT_FOUND",
    );
  }
  if (reread.ownerToken !== parsed.ownerToken) {
    throw new SchedulingDomainError(
      "Only the current owner can consume this hold.",
      "NOT_OWNER",
    );
  }
  if (reread.status === "RELEASED") {
    throw new SchedulingDomainError(
      "Cannot consume a RELEASED hold.",
      "WRONG_STATE",
    );
  }
  if (reread.status === "CONSUMED") {
    return safeView(reread);
  }
  if (reread.expiresAt <= parsed.now) {
    throw new SchedulingDomainError(
      "Hold has expired; cannot consume an expired lease.",
      "EXPIRED",
    );
  }
  throw new SchedulingDomainError(
    "Consume failed: concurrent modification detected.",
    "CONCURRENT_MODIFICATION",
  );
}

// Re-exported for consumers that import from the holds module directly.
export type { SlotHoldLike, SchedulingDomainErrorCode };
