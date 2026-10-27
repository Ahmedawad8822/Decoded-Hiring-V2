"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { reconcileDurableBusinessEvents } from "@/features/analytics/service";
import { requireAdmin } from "@/lib/auth";
import { createCommerceAdminOperations } from "./admin-operations";
import {
  getBookingAuditForAdmin,
  getOrderAuditForAdmin,
} from "./admin";
import type {
  CommerceAdminBookingAudit,
  CommerceAdminOrderAudit,
} from "./admin-model";

const operations = createCommerceAdminOperations(requireAdmin);

function refreshCommerce() {
  revalidatePath("/admin/commerce");
  revalidatePath("/coaching");
  revalidatePath("/workshop");
  // ISR offer pages (offer row is their only data source).
  revalidatePath("/mission-01");
  revalidatePath("/ai-recruiter-os");
  revalidatePath("/admin/courses");
}

async function runMutation<T>(
  operation: () => Promise<{ ok: boolean; data?: T; error?: string }>,
) {
  const result = await operation();
  if (result.ok) refreshCommerce();
  return result;
}

export async function createOfferAdminAction(input: unknown) {
  return runMutation(() => operations.createOffer(input));
}

export async function updateOfferAdminAction(input: unknown) {
  return runMutation(() => operations.updateOffer(input));
}

export async function createBookingTypeAdminAction(input: unknown) {
  return runMutation(() => operations.createBookingType(input));
}

export async function updateBookingTypeAdminAction(input: unknown) {
  return runMutation(() => operations.updateBookingType(input));
}

export async function createAvailabilityWindowAdminAction(input: unknown) {
  return runMutation(() => operations.createAvailabilityWindow(input));
}

export async function deleteAvailabilityWindowAdminAction(id: string) {
  return runMutation(() => operations.deleteAvailabilityWindow(id));
}

export async function bookingDecisionAdminAction(input: unknown) {
  return runMutation(() => operations.bookingDecision(input));
}

export async function recordManualPaymentAdminAction(input: unknown) {
  return runMutation(() => operations.recordManualPayment(input));
}

export async function getBookingAuditAdminAction(
  bookingId: unknown,
): Promise<{ ok: true; data: CommerceAdminBookingAudit } | { ok: false; error: string }> {
  try {
    const safeId = z.string().trim().min(1).parse(bookingId);
    return { ok: true, data: await getBookingAuditForAdmin(safeId) };
  } catch {
    return { ok: false, error: "Could not load booking audit history." };
  }
}

export async function getOrderAuditAdminAction(
  orderId: unknown,
): Promise<{ ok: true; data: CommerceAdminOrderAudit } | { ok: false; error: string }> {
  try {
    const safeId = z.string().trim().min(1).parse(orderId);
    return { ok: true, data: await getOrderAuditForAdmin(safeId) };
  } catch {
    return { ok: false, error: "Could not load Order audit history." };
  }
}

/**
 * Explicit admin recovery: re-derives missing business events from the
 * booking/order histories. Idempotent (shared dedupe keys). The Studio
 * summary read never does this itself.
 */
export async function reconcileBusinessEventsAdminAction(windowDays?: unknown) {
  try {
    await requireAdmin();
    const days = z.coerce.number().int().min(1).max(365).catch(30).parse(windowDays);
    await reconcileDurableBusinessEvents({
      since: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
    });
    revalidatePath("/admin/commerce");
    return { ok: true as const };
  } catch {
    return { ok: false as const, error: "Could not reconcile business events." };
  }
}
