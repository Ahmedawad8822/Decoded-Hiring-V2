"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

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
