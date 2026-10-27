import { and, desc, eq, sql } from "drizzle-orm";

import { getDb, leadSubmissions, type LeadSubmission } from "@/lib/db";
import { AppError } from "@/lib/errors";
import {
  LEAD_SUBMISSION_KINDS,
  LEAD_SUBMISSION_STATUSES,
  type LeadSubmissionKind,
  type LeadSubmissionStatus,
} from "./types";

// ============================================================================
// STUDIO LEADS INBOX
// ----------------------------------------------------------------------------
// Read + status workflow for `lead_submissions`. Lead fields are PII: nothing
// here logs them, and AppError messages never include them.
// ============================================================================

export const LEAD_PAGE_SIZE = 25;

/** Allowed status transitions. Anything else is rejected as `invalid`. */
export const LEAD_TRANSITIONS: Record<LeadSubmissionStatus, readonly LeadSubmissionStatus[]> = {
  NEW: ["REVIEWED", "CLOSED"],
  REVIEWED: ["CLOSED", "NEW"],
  CLOSED: ["NEW"],
};

export function isLeadStatus(value: unknown): value is LeadSubmissionStatus {
  return (LEAD_SUBMISSION_STATUSES as readonly unknown[]).includes(value);
}

export function isLeadKind(value: unknown): value is LeadSubmissionKind {
  return (LEAD_SUBMISSION_KINDS as readonly unknown[]).includes(value);
}

export async function listLeads(opts: {
  status?: string | null;
  kind?: string | null;
  page?: number;
  pageSize?: number;
}): Promise<{ leads: LeadSubmission[]; total: number; page: number; pageCount: number }> {
  const db = await getDb();
  const pageSize = opts.pageSize ?? LEAD_PAGE_SIZE;
  const conditions = [];
  if (isLeadStatus(opts.status)) conditions.push(eq(leadSubmissions.status, opts.status));
  if (isLeadKind(opts.kind)) conditions.push(eq(leadSubmissions.kind, opts.kind));
  const where = conditions.length ? and(...conditions) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(leadSubmissions)
    .where(where);
  const pageCount = Math.max(1, Math.ceil(Number(total) / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pageCount);

  const leads = await db
    .select()
    .from(leadSubmissions)
    .where(where)
    .orderBy(desc(leadSubmissions.createdAt), desc(leadSubmissions.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { leads, total: Number(total), page, pageCount };
}

export async function getLead(id: string): Promise<LeadSubmission | null> {
  const db = await getDb();
  const [row] = await db.select().from(leadSubmissions).where(eq(leadSubmissions.id, id)).limit(1);
  return row ?? null;
}

/**
 * Move a lead `from` -> `to`. The UPDATE is conditional on the expected
 * current status so a concurrent change can never be overwritten or skipped.
 */
export async function transitionLead(input: {
  id: string;
  from: LeadSubmissionStatus;
  to: LeadSubmissionStatus;
  now?: Date;
}): Promise<{ id: string; from: LeadSubmissionStatus; to: LeadSubmissionStatus }> {
  const { id, from, to } = input;
  if (!isLeadStatus(from) || !isLeadStatus(to) || !LEAD_TRANSITIONS[from].includes(to)) {
    throw new AppError("invalid", `A lead cannot move from ${from} to ${to}`);
  }
  const db = await getDb();
  const updated = await db
    .update(leadSubmissions)
    .set({ status: to, updatedAt: input.now ?? new Date() })
    .where(and(eq(leadSubmissions.id, id), eq(leadSubmissions.status, from)))
    .returning({ id: leadSubmissions.id });
  if (updated.length === 0) {
    const existing = await getLead(id);
    if (!existing) throw new AppError("not_found", "Lead not found");
    throw new AppError("conflict", `This lead is now ${existing.status}; reload and try again`);
  }
  return { id, from, to };
}
