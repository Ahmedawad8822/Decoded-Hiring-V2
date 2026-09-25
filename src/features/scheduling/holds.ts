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
// ============================================================================

import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { slotHolds } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { buildSlotKey } from "./availability";
import type { SlotHold, SlotHoldLike, AcquireHoldResult } from "./types";
import type { AcquireSlotHoldInput } from "./schemas";

const MS_PER_MINUTE = 60_000;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * Acquire (or re-acquire) a lease on a canonical slot.
 *
 * CASE A — slot does not exist → INSERT a new HELD row (owner wins).
 *   On UNIQUE race (two callers INSERT simultaneously): the loser re-reads
 *   and returns the winner's hold as unavailable.
 *
 * CASE B — HELD + unexpired + SAME owner → idempotent return (no TTL extend).
 *
 * CASE C — HELD + unexpired + DIFFERENT owner → reject (TAKEN).
 *
 * CASE D — HELD + expired → atomic reclaim via CAS UPDATE.
 *
 * CASE E — RELEASED → atomic re-acquire via CAS UPDATE.
 *
 * CASE F — CONSUMED → reject (CONSUMED).
 */
export async function acquireSlotHold(
  input: AcquireSlotHoldInput,
): Promise<AcquireHoldResult> {
  const { bookingTypeId, startAt, endAt, ownerToken, now, ttlMinutes } = input;
  const db = await getDb();
  const slotKey = buildSlotKey(bookingTypeId, startAt);
  const expiresAt = new Date(now.getTime() + ttlMinutes * MS_PER_MINUTE);

  // 1. Read existing hold for this slot key (if any).
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
        startAt,
        endAt,
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
          return {
            success: false,
            hold: toHoldLike(winner),
            reason: classifyUnavailable(winner),
          };
        }
        throw new Error("Slot hold unique constraint violation but row not found on re-read.");
      }
      throw error;
    }
    const created = await db
      .select()
      .from(slotHolds)
      .where(eq(slotHolds.slotKey, slotKey))
      .get();
    return { success: true, hold: toHoldLike(created!) };
  }

  // Existing hold — classify by state.
  const isHeldUnexpired = existing.status === "HELD" && existing.expiresAt > now;

  // CASE F — consumed: terminal state, cannot be acquired.
  if (existing.status === "CONSUMED") {
    return { success: false, hold: toHoldLike(existing), reason: "CONSUMED" };
  }

  // CASE B — HELD + unexpired + SAME owner → idempotent return (no TTL extend).
  if (existing.status === "HELD" && isHeldUnexpired && existing.ownerToken === ownerToken) {
    return { success: true, hold: toHoldLike(existing) };
  }

  // CASE B (expired, same owner) — same owner reclaiming their own expired lease.
  if (existing.status === "HELD" && !isHeldUnexpired && existing.ownerToken === ownerToken) {
    return reclaimSlot(existing, ownerToken, bookingTypeId, slotKey, startAt, endAt, expiresAt, now, db);
  }

  // CASE C — HELD + unexpired + DIFFERENT owner → reject.
  if (isHeldUnexpired) {
    return { success: false, hold: toHoldLike(existing), reason: "TAKEN" };
  }

  // CASE D (expired, different owner) or CASE E (RELEASED) — reclaim via CAS.
  return reclaimSlot(existing, ownerToken, bookingTypeId, slotKey, startAt, endAt, expiresAt, now, db);
}

/**
 * Atomically reclaim a slot via CAS UPDATE.
 *
 * The WHERE clause locks on (slotKey, ownerToken, status, expiresAt) so that
 * if any of those changed since the read (e.g. another caller won a race,
 * or the owner already re-acquired), the UPDATE affects 0 rows and we fall
 * back to a re-read + classify.
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
    return { success: true, hold: toHoldLike(updated) };
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
          return {
            success: false,
            hold: toHoldLike(winner),
            reason: classifyUnavailable(winner),
          };
        }
        throw new Error("Slot hold unique constraint violation but row not found on re-read.");
      }
      throw error;
    }
    const created = await db
      .select()
      .from(slotHolds)
      .where(eq(slotHolds.slotKey, slotKey))
      .get();
    return { success: true, hold: toHoldLike(created!) };
  }

  return classifyHoldForAcquire(reread, newOwnerToken, now);
}

/**
 * Classify an existing hold during acquire, given the requester's ownerToken.
 */
function classifyHoldForAcquire(
  hold: SlotHold,
  ownerToken: string,
  now: Date,
): AcquireHoldResult {
  if (hold.status === "CONSUMED") {
    return { success: false, hold: toHoldLike(hold), reason: "CONSUMED" };
  }
  if (hold.status === "HELD" && hold.expiresAt > now) {
    if (hold.ownerToken === ownerToken) {
      return { success: true, hold: toHoldLike(hold) };
    }
    return { success: false, hold: toHoldLike(hold), reason: "TAKEN" };
  }
  // expired HELD or RELEASED by this point — CAS should have succeeded;
  // if we're here via reclassify, treat as TAKEN (safe fallback).
  return { success: false, hold: toHoldLike(hold), reason: "TAKEN" };
}

function classifyUnavailable(hold: SlotHold): "TAKEN" | "CONSUMED" {
  return hold.status === "CONSUMED" ? "CONSUMED" : "TAKEN";
}

function toHoldLike(hold: SlotHold): SlotHoldLike {
  return {
    id: hold.id,
    bookingTypeId: hold.bookingTypeId,
    slotKey: hold.slotKey,
    startAt: hold.startAt,
    endAt: hold.endAt,
    ownerToken: hold.ownerToken,
    status: hold.status,
    expiresAt: hold.expiresAt,
    consumedAt: hold.consumedAt,
    releasedAt: hold.releasedAt,
  };
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
  const db = await getDb();
  const slotKey = buildSlotKey(bookingTypeId, startAt);

  const existing = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey))
    .get();

  if (!existing) {
    throw new Error("Slot hold not found.");
  }
  if (existing.ownerToken !== ownerToken) {
    throw new Error("Only the current owner can release this hold.");
  }
  if (existing.status !== "HELD") {
    throw new Error(`Cannot release a ${existing.status} hold.`);
  }
  if (existing.expiresAt <= now) {
    throw new Error("Hold has expired; cannot release an expired lease.");
  }

  const updated = await db
    .update(slotHolds)
    .set({
      status: "RELEASED" as const,
      releasedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(slotHolds.slotKey, slotKey),
        eq(slotHolds.ownerToken, ownerToken),
        eq(slotHolds.status, "HELD"),
        gt(slotHolds.expiresAt, now),
        eq(slotHolds.expiresAt, existing.expiresAt),
      ),
    )
    .returning()
    .get();

  if (!updated) {
    // CAS lost — re-read to give a precise error.
    const reread = await db
      .select()
      .from(slotHolds)
      .where(eq(slotHolds.slotKey, slotKey))
      .get();
    if (!reread) throw new Error("Slot hold was deleted before release could complete.");
    if (reread.ownerToken !== ownerToken) {
      throw new Error("Only the current owner can release this hold.");
    }
    if (reread.status !== "HELD") {
      throw new Error(`Cannot release a ${reread.status} hold.`);
    }
    if (reread.expiresAt <= now) {
      throw new Error("Hold has expired; cannot release an expired lease.");
    }
    throw new Error("Release failed: concurrent modification detected.");
  }
}

/**
 * Consume a hold lease (transitions HELD → CONSUMED).
 *
 * Rules:
 * - Hold must be unexpired (expiresAt > now).
 * - Exact current owner token required (CAS on ownerToken).
 * - Stale owner cannot consume (CAS fails).
 * - RELEASED cannot be consumed (status check).
 * - CONSUMED by same owner is idempotent (re-CAS succeeds with 0 rows if
 *   already consumed, so we re-read and return success for same owner).
 */
export async function consumeSlotHold(
  bookingTypeId: string,
  startAt: Date,
  ownerToken: string,
  now: Date,
): Promise<SlotHoldLike | null> {
  const db = await getDb();
  const slotKey = buildSlotKey(bookingTypeId, startAt);

  const existing = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey))
    .get();

  if (!existing) {
    throw new Error("Slot hold not found.");
  }
  if (existing.ownerToken !== ownerToken) {
    throw new Error("Only the current owner can consume this hold.");
  }
  if (existing.status === "RELEASED") {
    throw new Error("Cannot consume a RELEASED hold.");
  }
  if (existing.status === "CONSUMED") {
    // Idempotent re-consume by the same owner.
    return toHoldLike(existing);
  }
  if (existing.expiresAt <= now) {
    throw new Error("Hold has expired; cannot consume an expired lease.");
  }

  const updated = await db
    .update(slotHolds)
    .set({
      status: "CONSUMED" as const,
      consumedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(slotHolds.slotKey, slotKey),
        eq(slotHolds.ownerToken, ownerToken),
        eq(slotHolds.status, "HELD"),
        gt(slotHolds.expiresAt, now),
        eq(slotHolds.expiresAt, existing.expiresAt),
      ),
    )
    .returning()
    .get();

  if (updated) {
    return toHoldLike(updated);
  }

  // CAS lost — re-read to classify.
  const reread = await db
    .select()
    .from(slotHolds)
    .where(eq(slotHolds.slotKey, slotKey))
    .get();
  if (!reread) throw new Error("Slot hold was deleted before consume could complete.");
  if (reread.ownerToken !== ownerToken) {
    throw new Error("Only the current owner can consume this hold.");
  }
  if (reread.status === "RELEASED") {
    throw new Error("Cannot consume a RELEASED hold.");
  }
  if (reread.status === "CONSUMED") {
    return toHoldLike(reread);
  }
  if (reread.expiresAt <= now) {
    throw new Error("Hold has expired; cannot consume an expired lease.");
  }
  throw new Error("Consume failed: concurrent modification detected.");
}
