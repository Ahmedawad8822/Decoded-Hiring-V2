// ============================================================================
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
// ====================================================================

import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { slotHolds } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { buildSlotKey, generateCandidateSlots } from "./availability";
import { getBookingTypeById, getBookingTypeWindows } from "./policy";
import { SchedulingProviderError } from "./providers";
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
 * CASE B was removed: idempotency for the same owner required the browser to
 *   identify itself, which conflicts with the "server generates the lease
 *   token" rule. A caller without the server-issued token is treated as a
 *   different owner; the legitimate owner instead uses the token returned at
 *   acquisition to release/consume.
 *
 * CASE C — HELD + unexpired + different owner -> reject (TAKEN).
 * CASE D — HELD + expired -> atomic reclaim via CAS UPDATE.
 * CASE E — RELEASED -> atomic re-acquire via CAS UPDATE.
 * CASE F — CONSUMED -> reject (CONSUMED).
 *
 * The returned `hold` is a SafeHoldView (never carries ownerToken). The
 * server-generated `ownerToken` is returned ONLY when success === true.
 */
export async function acquireSlotHold(
  input: AcquireSlotHoldInput,
): Promise<AcquireHoldResult> {
  // (C) Runtime validation at the boundary.
  const parsed = acquireSlotHoldSchema.parse(input);
  const { bookingTypeId, startAt, now, ttlMinutes } = parsed;

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
    return { success: true, hold: safeView(created!), ownerToken }; // token only to winner
  }

  // Existing hold — classify by state.
  if (existing.status === "CONSUMED") {
    return classifyUnavailableHold(existing);
  }
  const isHeldUnexpired = existing.status === "HELD" && existing.expiresAt > now;
  if (isHeldUnexpired) {
    // CASE C — held + unexpired + unknown/different owner -> reject.
    return classifyUnavailableHold(existing);
  }
  // CASE D (expired HELD) or CASE E (RELEASED) — reclaim via CAS UPDATE.
  // Any caller may reclaim an expired or released lease.
  return reclaimSlot(
    existing,
    ownerToken,
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
  existing: SlotHold,
  newOwnerToken: string,
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
    return { success: true, hold: safeView(updated), ownerToken: newOwnerToken };
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
    return { success: true, hold: safeView(created!), ownerToken: newOwnerToken };
  }

  return classifyUnavailableHold(reread);
}

/**
 * Release a hold lease. Only the current owner of an unconsumed, unexpired
 * HELD lease may release it.
 *
 * CAS boundary: (slotKey, ownerToken, status='HELD', expiresAt=current).
 * A stale owner (whose token no longer matches) gets 0 rows updated.
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
    throw new SchedulingProviderError("Slot hold not found.", "HOLD_NOT_FOUND");
  }
  if (existing.ownerToken !== parsed.ownerToken) {
    throw new SchedulingProviderError(
      "Only the current owner can release this hold.",
      "NOT_OWNER",
    );
  }
  if (existing.status !== "HELD") {
    throw new SchedulingProviderError(
      `Cannot release a ${existing.status} hold.`,
      "WRONG_STATE",
    );
  }
  if (existing.expiresAt <= parsed.now) {
    throw new SchedulingProviderError(
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
      throw new SchedulingProviderError("Slot hold was deleted before release could complete.", "HOLD_NOT_FOUND");
    }
    if (reread.ownerToken !== parsed.ownerToken) {
      throw new SchedulingProviderError("Only the current owner can release this hold.", "NOT_OWNER");
    }
    if (reread.status !== "HELD") {
      throw new SchedulingProviderError(`Cannot release a ${reread.status} hold.`, "WRONG_STATE");
    }
    if (reread.expiresAt <= parsed.now) {
      throw new SchedulingProviderError("Hold has expired; cannot release an expired lease.", "EXPIRED");
    }
    throw new SchedulingProviderError("Release failed: concurrent modification detected.", "CONCURRENT_MODIFICATION");
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
    throw new SchedulingProviderError("Slot hold not found.", "HOLD_NOT_FOUND");
  }
  if (existing.ownerToken !== parsed.ownerToken) {
    throw new SchedulingProviderError(
      "Only the current owner can consume this hold.",
      "NOT_OWNER",
    );
  }
  if (existing.status === "RELEASED") {
    throw new SchedulingProviderError("Cannot consume a RELEASED hold.", "WRONG_STATE");
  }
  if (existing.status === "CONSUMED") {
    // Idempotent re-consume by the same owner.
    return safeView(existing);
  }
  if (existing.expiresAt <= parsed.now) {
    throw new SchedulingProviderError(
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
    throw new SchedulingProviderError("Slot hold was deleted before consume could complete.", "HOLD_NOT_FOUND");
  }
  if (reread.ownerToken !== parsed.ownerToken) {
    throw new SchedulingProviderError("Only the current owner can consume this hold.", "NOT_OWNER");
  }
  if (reread.status === "RELEASED") {
    throw new SchedulingProviderError("Cannot consume a RELEASED hold.", "WRONG_STATE");
  }
  if (reread.status === "CONSUMED") {
    return safeView(reread);
  }
  if (reread.expiresAt <= parsed.now) {
    throw new SchedulingProviderError("Hold has expired; cannot consume an expired lease.", "EXPIRED");
  }
  throw new SchedulingProviderError("Consume failed: concurrent modification detected.", "CONCURRENT_MODIFICATION");
}

// Re-exported for tests/seams: the token generator that acquisition relies on.
export { type SlotHoldLike };
