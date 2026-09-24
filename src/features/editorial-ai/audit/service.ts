// ============================================================================
// EDITORIAL AI — AUDIT TRAIL SERVICE
// ----------------------------------------------------------------------------
// Narrow domain auditability (Mission 07). Records key editorial actions:
//   knowledge ingestion, draft generation, submit, approve, reject, publish.
// NOT a generic event platform — this is domain auditability, not analytics.
// ============================================================================

import { getDb, editorial_audit_log } from "@/lib/db";
import { and, eq } from "drizzle-orm";

export type AuditEntityType =
  | "knowledge_source"
  | "knowledge_chunk"
  | "editorial_draft"
  | "editorial_memory"
  | "guide"
  | "field_note";

export interface AuditEntryInput {
  actor: string; // user id (admin who performed the action)
  entityType: AuditEntityType;
  entityId: string;
  action: string; // EditorialAuditAction
  detail?: Record<string, unknown> | null;
}

export interface AuditLogEntry {
  id: string;
  actor: string;
  entityType: string;
  entityId: string;
  action: string;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * Append a single audit log entry. Failures are logged to console but never
 * thrown — audit is best-effort and must never block the primary operation.
 */
export async function logAudit(input: AuditEntryInput): Promise<void> {
  const db = await getDb();
  try {
    await db.insert(editorial_audit_log).values({
      id: `eal_${crypto.randomUUID().slice(0, 12)}`,
      actor: input.actor,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      detail: input.detail ? JSON.stringify(input.detail) : null,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("[editorial-ai audit] failed to log:", (err as Error).message);
  }
}

/**
 * Query audit entries for a specific entity (admin-only, server-side).
 */
export async function getAuditForEntity(
  entityType: string,
  entityId: string
): Promise<AuditLogEntry[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(editorial_audit_log)
    .where(
      and(
        eq(editorial_audit_log.entityType, entityType),
        eq(editorial_audit_log.entityId, entityId)
      )
    )
    .orderBy(editorial_audit_log.createdAt);

  return rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    entityType: r.entityType,
    entityId: r.entityId,
    action: r.action,
    detail: r.detail ? parseDetail(r.detail) : null,
    createdAt: r.createdAt,
  }));
}

function parseDetail(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
