/**
 * STUDIO LEADS INBOX
 * Service (list/filter/pagination, transitions, conditional-UPDATE conflict)
 * and the real server actions as a signed-in admin (audit row, no PII).
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.
process.env.ADMIN_REQUIRE_2FA = "false";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import { adminAuditLog, getDb, leadSubmissions, users } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import { AppError } from "../src/lib/errors";
import type { LeadSubmissionKind, LeadSubmissionStatus } from "../src/features/leads/types";

const nodeRequire = createRequire(__filename);
let cookieHeader = "";

function stubModule(id: string, exports: Record<string, unknown>) {
  const resolved = nodeRequire.resolve(id);
  nodeRequire.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
}

const uid = () => crypto.randomUUID().slice(0, 8);
const PII_EMAIL_MARK = `pii-${uid()}`;

type Mods = {
  admin: typeof import("../src/features/leads/admin");
  actions: typeof import("../src/features/leads/admin-actions");
};
let m: Mods;
let adminId = "";
let seq = 0;

async function seedLead(
  status: LeadSubmissionStatus,
  kind: LeadSubmissionKind = "contact",
  createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq))
) {
  const db = await getDb();
  const id = `lead_${uid()}_${seq}`;
  await db.insert(leadSubmissions).values({
    id,
    idempotencyKey: `idem-${id}`,
    kind,
    status,
    fullName: `Name ${PII_EMAIL_MARK}`,
    email: `${PII_EMAIL_MARK}-${seq}@example.com`,
    countryCode: "US",
    sourceRoute: "/contact",
    privacyAcknowledged: true,
    createdAt,
    updatedAt: createdAt,
  });
  return id;
}

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", {
    revalidatePath: () => {},
    revalidateTag: () => {},
    unstable_cache: <T>(fn: T) => fn,
  });

  const auth = await getAuth();
  const email = `leads-admin-${uid()}@example.com`;
  const password = "LeadsAdminPass123!";
  const created = await auth.api.signUpEmail({ body: { email, password, name: "Leads Admin" } });
  adminId = created.user.id;
  const db = await getDb();
  await db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  cookieHeader = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookieHeader);

  m = {
    admin: await import("../src/features/leads/admin"),
    actions: await import("../src/features/leads/admin-actions"),
  };
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("list: filters by status and kind, newest first, paginates at 25", async () => {
  const db = await getDb();
  await db.delete(leadSubmissions);
  const ids: string[] = [];
  for (let i = 0; i < 27; i++) ids.push(await seedLead("NEW", "coaching"));
  const reviewed = await seedLead("REVIEWED", "workshop");
  await seedLead("CLOSED", "workshop");

  const p1 = await m.admin.listLeads({ status: "NEW" });
  assert.equal(p1.total, 27);
  assert.equal(p1.pageCount, 2);
  assert.equal(p1.leads.length, 25);
  assert.equal(p1.leads[0].id, ids[26], "newest first");
  const p2 = await m.admin.listLeads({ status: "NEW", page: 2 });
  assert.equal(p2.leads.length, 2);
  assert.equal(p2.leads[1].id, ids[0]);
  assert.equal((await m.admin.listLeads({ status: "NEW", page: 99 })).page, 2, "page clamps");

  const byKind = await m.admin.listLeads({ status: "REVIEWED", kind: "workshop" });
  assert.deepEqual(byKind.leads.map((l) => l.id), [reviewed]);
  assert.equal((await m.admin.listLeads({ status: "NEW", kind: "workshop" })).total, 0);
  assert.equal((await m.admin.listLeads({})).total, 29, "no filter returns all statuses");
  assert.equal((await m.admin.listLeads({ status: "bogus" })).total, 29, "invalid status ignored");
});

test("transitionLead: every allowed transition succeeds", async () => {
  const allowed: Array<[LeadSubmissionStatus, LeadSubmissionStatus]> = [
    ["NEW", "REVIEWED"],
    ["NEW", "CLOSED"],
    ["REVIEWED", "CLOSED"],
    ["REVIEWED", "NEW"],
    ["CLOSED", "NEW"],
  ];
  for (const [from, to] of allowed) {
    const id = await seedLead(from);
    await m.admin.transitionLead({ id, from, to });
    assert.equal((await m.admin.getLead(id))?.status, to, `${from} -> ${to}`);
  }
});

test("transitionLead: disallowed transitions are 'invalid' and change nothing", async () => {
  const disallowed: Array<[LeadSubmissionStatus, LeadSubmissionStatus]> = [
    ["REVIEWED", "REVIEWED"],
    ["CLOSED", "REVIEWED"],
    ["CLOSED", "CLOSED"],
    ["NEW", "NEW"],
  ];
  for (const [from, to] of disallowed) {
    const id = await seedLead(from);
    await assert.rejects(
      m.admin.transitionLead({ id, from, to }),
      (e: unknown) => e instanceof AppError && e.kind === "invalid"
    );
    assert.equal((await m.admin.getLead(id))?.status, from);
  }
});

test("transitionLead: stale expectation is a 'conflict', missing lead 'not_found'", async () => {
  const id = await seedLead("NEW");
  await m.admin.transitionLead({ id, from: "NEW", to: "REVIEWED" });
  // A second admin still thinks it is NEW and tries NEW -> CLOSED: must not skip REVIEWED.
  await assert.rejects(
    m.admin.transitionLead({ id, from: "NEW", to: "CLOSED" }),
    (e: unknown) => e instanceof AppError && e.kind === "conflict"
  );
  assert.equal((await m.admin.getLead(id))?.status, "REVIEWED");

  await assert.rejects(
    m.admin.transitionLead({ id: "missing", from: "NEW", to: "REVIEWED" }),
    (e: unknown) => e instanceof AppError && e.kind === "not_found"
  );
});

test("actions: review/close/reopen write PII-free audit rows; failures return results", async () => {
  const id = await seedLead("NEW");
  const reviewed = await m.actions.reviewLeadAction(id, "NEW");
  assert.deepEqual(reviewed, { ok: true, data: { id, status: "REVIEWED" } });
  const closed = await m.actions.closeLeadAction(id, "REVIEWED");
  assert.equal(closed.ok, true);
  const reopened = await m.actions.reopenLeadAction(id, "CLOSED");
  assert.equal(reopened.ok, true);

  const db = await getDb();
  const rows = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityType, "lead"), eq(adminAuditLog.entityId, id)));
  assert.deepEqual(rows.map((r) => r.action).sort(), ["lead.close", "lead.reopen", "lead.review"]);
  for (const r of rows) {
    assert.equal(r.actorId, adminId);
    assert.ok(!JSON.stringify(r).includes(PII_EMAIL_MARK), "no PII in audit row");
    const d = JSON.parse(r.details ?? "{}");
    assert.deepEqual(Object.keys(d).sort(), ["from", "to"]);
  }
  const review = rows.find((r) => r.action === "lead.review");
  assert.deepEqual(JSON.parse(review!.details!), { from: "NEW", to: "REVIEWED" });

  const stale = await m.actions.reviewLeadAction(id, "CLOSED");
  assert.equal(stale.ok, false);
  const bad = await m.actions.closeLeadAction(id, "NEW"); // lead is NEW now; NEW -> CLOSED allowed
  assert.equal(bad.ok, true);
  const invalid = await m.actions.reviewLeadAction(id, "CLOSED"); // stale AND invalid transition
  assert.equal(invalid.ok, false);
  const after = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityType, "lead"), eq(adminAuditLog.entityId, id)));
  assert.equal(after.length, 4, "failed actions write no audit row");
});

test("actions: reject callers that are not admins", async () => {
  const saved = cookieHeader;
  cookieHeader = "";
  try {
    const id = await seedLead("NEW");
    const r = await m.actions.reviewLeadAction(id, "NEW");
    assert.equal(r.ok, false);
    assert.equal((await m.admin.getLead(id))?.status, "NEW");
  } finally {
    cookieHeader = saved;
  }
});
