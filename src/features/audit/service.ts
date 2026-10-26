import { desc, eq, sql } from "drizzle-orm";
import { adminAuditLog, getDb, users, type AdminAuditLogRow } from "@/lib/db";

// ============================================================================
// ADMIN AUDIT TRAIL (threat-model G4)
//
// WRITE STRATEGY: every admin mutation is performed by a feature service that
// does not know who the actor is (the session is resolved in the server
// action / route handler by `requireAdmin()`). Threading an actor through ~25
// service signatures, several of which already assemble their own D1 batch,
// would be a large, risky refactor. So the audit row is written by the
// caller (action / route) IMMEDIATELY AFTER the mutation succeeded and is
// AWAITED. It is not swallowed silently: a failed audit write is logged with
// console.error (structured, no payload) and does not turn a committed
// mutation into a user-visible failure. Residual risk: a Worker crash between
// the mutation commit and the audit insert loses that row.
// `buildAdminAuditStatement` returns an un-run statement so a service that
// builds a D1 batch can add the audit row to the same atomic batch once an
// actor is available there; prefer it to recordAdminAudit in that case.
// ============================================================================

export const AUDIT_ENTITY_TYPES = [
  "guide",
  "field_note",
  "course",
  "course_section",
  "lesson",
  "lesson_resource",
  "media",
  "offer",
  "booking_type",
  "availability_window",
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export type AdminAuditInput = {
  actorId: string;
  /** "<entity>.<verb>", e.g. "guide.publish". */
  action: string;
  entityType: AuditEntityType;
  entityId: string;
  /** Small, flat, non-sensitive facts (old/new slug, status change). */
  details?: Record<string, string | number | boolean | null | undefined>;
};

const MAX_DETAILS_LENGTH = 1000;

function serializeDetails(details: AdminAuditInput["details"]): string | null {
  if (!details) return null;
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(details)) {
    if (v === undefined) continue;
    clean[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  if (Object.keys(clean).length === 0) return null;
  const json = JSON.stringify(clean);
  return json.length > MAX_DETAILS_LENGTH ? json.slice(0, MAX_DETAILS_LENGTH) : json;
}

function buildRow(input: AdminAuditInput) {
  return {
    id: `aud_${crypto.randomUUID()}`,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    details: serializeDetails(input.details),
    createdAt: new Date(),
  };
}

/** Un-run insert for inclusion in an existing `db.batch([...])`. */
export async function buildAdminAuditStatement(input: AdminAuditInput) {
  const db = await getDb();
  return db.insert(adminAuditLog).values(buildRow(input));
}

/**
 * Record an admin audit row. Never throws: on failure it logs and returns
 * false so a committed mutation is not reported as failed.
 */
export async function recordAdminAudit(input: AdminAuditInput): Promise<boolean> {
  try {
    const db = await getDb();
    await db.insert(adminAuditLog).values(buildRow(input));
    return true;
  } catch (error) {
    console.error("admin_audit_write_failed", {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Actor id from a session-like value (the commerce guard returns `unknown`). */
export function actorIdFromSession(session: unknown): string | null {
  const id = (session as { user?: { id?: unknown } } | null | undefined)?.user?.id;
  return typeof id === "string" && id ? id : null;
}

export const AUDIT_PAGE_SIZE = 25;

export type AdminAuditEntry = AdminAuditLogRow & { actorEmail: string | null };

export async function listAdminAudit(opts: {
  entityType?: string | null;
  page?: number;
  pageSize?: number;
}): Promise<{ entries: AdminAuditEntry[]; total: number; page: number; pageCount: number }> {
  const db = await getDb();
  const pageSize = opts.pageSize ?? AUDIT_PAGE_SIZE;
  const entityType =
    opts.entityType && (AUDIT_ENTITY_TYPES as readonly string[]).includes(opts.entityType)
      ? opts.entityType
      : null;
  const where = entityType ? eq(adminAuditLog.entityType, entityType) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(adminAuditLog)
    .where(where);
  const pageCount = Math.max(1, Math.ceil(Number(total) / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pageCount);

  const rows = await db
    .select({ row: adminAuditLog, actorEmail: users.email })
    .from(adminAuditLog)
    .leftJoin(users, eq(users.id, adminAuditLog.actorId))
    .where(where)
    .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    entries: rows.map((r) => ({ ...r.row, actorEmail: r.actorEmail })),
    total: Number(total),
    page,
    pageCount,
  };
}
