/**
 * MISSION 08.6 — Durable lead/enquiry fallback
 */

import "./helpers/env";

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getDb, leadSubmissions, publicRateLimits } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { submitLead } from "@/features/leads/actions";

function leadForm(params: {
  idempotencyKey?: string;
  name?: string;
  email?: string;
  problem?: string;
  privacy?: boolean;
  research?: boolean;
  aiUseLevel?: string;
  workflow?: string;
  phone?: string;
  whatsapp?: boolean;
  calls?: boolean;
  website?: string;
} = {}): FormData {
  const form = new FormData();
  form.set("idempotencyKey", params.idempotencyKey ?? crypto.randomUUID());
  form.set("fullName", params.name ?? "Lead Test Person");
  form.set("email", params.email ?? `lead-${crypto.randomUUID()}@example.com`);
  form.set("countryCode", "EG");
  form.set(
    "problemSummary",
    params.problem ?? "We need a clearer hiring decision process for the team.",
  );
  form.set("privacyAcknowledged", params.privacy === false ? "" : "on");
  form.set("researchAccepted", params.research ? "on" : "");
  form.set("emailMarketing", "");
  form.set("whatsapp", params.whatsapp ? "on" : "");
  form.set("calls", params.calls ? "on" : "");
  form.set("website", params.website ?? "");
  if (params.aiUseLevel !== undefined) {
    form.set("aiUseLevel", params.aiUseLevel);
  }
  if (params.workflow !== undefined) {
    form.set("workflowToImprove", params.workflow);
  }
  if (params.phone !== undefined) {
    form.set("phoneE164", params.phone);
  }

  // These values must be ignored: provenance comes from the bound server
  // action arguments, not hidden browser inputs.
  form.set("sourceRoute", "/tampered");
  form.set("audiencePath", "tampered");

  return form;
}

test.before(async () => {
  await migrateLocalDb();
  const db = await getDb();
  await db.delete(leadSubmissions).run();
  await db.delete(publicRateLimits).run();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("LEADS 08.6: public coaching enquiry persists durable D1 truth with server-owned provenance", async () => {
  const key = crypto.randomUUID();
  const state = await submitLead(
    "coaching",
    "/coaching",
    "decision_brief",
    undefined,
    leadForm({ idempotencyKey: key }),
  );

  assert.equal(state?.ok, true);

  const db = await getDb();
  const row = await db
    .select()
    .from(leadSubmissions)
    .where(eq(leadSubmissions.idempotencyKey, key))
    .get();

  assert.ok(row);
  assert.equal(row.kind, "coaching");
  assert.equal(row.status, "NEW");
  assert.equal(row.sourceRoute, "/coaching");
  assert.equal(row.audiencePath, "decision_brief");
  assert.equal(row.privacyAcknowledged, true);
});

test("LEADS 08.6: lost-response retry is idempotent and stores one submission", async () => {
  const key = crypto.randomUUID();
  const email = `retry-${crypto.randomUUID()}@example.com`;
  const formA = leadForm({ idempotencyKey: key, email });
  const formB = leadForm({ idempotencyKey: key, email });

  const first = await submitLead(
    "workshop",
    "/workshop",
    "private_team",
    undefined,
    formA,
  );
  const second = await submitLead(
    "workshop",
    "/workshop",
    "private_team",
    undefined,
    formB,
  );

  assert.equal(first?.ok, true);
  assert.equal(second?.ok, true);

  const db = await getDb();
  const rows = await db
    .select()
    .from(leadSubmissions)
    .where(eq(leadSubmissions.idempotencyKey, key))
    .all();
  assert.equal(rows.length, 1);
});

test("LEADS 08.6: idempotency key cannot silently adopt edited enquiry intent", async () => {
  const key = crypto.randomUUID();
  const email = `edited-${crypto.randomUUID()}@example.com`;

  const first = await submitLead(
    "coaching",
    "/coaching",
    "decision_brief",
    undefined,
    leadForm({ idempotencyKey: key, email, name: "Original Lead" }),
  );
  assert.equal(first?.ok, true);

  const edited = await submitLead(
    "coaching",
    "/coaching",
    "decision_brief",
    undefined,
    leadForm({ idempotencyKey: key, email, name: "Edited Lead" }),
  );
  assert.equal(edited?.ok, false);

  const db = await getDb();
  const row = await db
    .select()
    .from(leadSubmissions)
    .where(eq(leadSubmissions.idempotencyKey, key))
    .get();
  assert.equal(row?.fullName, "Original Lead");
});

test("LEADS 08.6: concurrent same identity with edited intent produces one durable winner", async () => {
  const key = crypto.randomUUID();
  const email = `concurrent-${crypto.randomUUID()}@example.com`;

  const [a, b] = await Promise.all([
    submitLead(
      "contact",
      "/contact",
      "general",
      undefined,
      leadForm({ idempotencyKey: key, email, name: "Concurrent A" }),
    ),
    submitLead(
      "contact",
      "/contact",
      "general",
      undefined,
      leadForm({ idempotencyKey: key, email, name: "Concurrent B" }),
    ),
  ]);

  assert.equal([a, b].filter((state) => state?.ok).length, 1);
  assert.equal([a, b].filter((state) => state && !state.ok).length, 1);

  const db = await getDb();
  const rows = await db
    .select()
    .from(leadSubmissions)
    .where(eq(leadSubmissions.idempotencyKey, key))
    .all();
  assert.equal(rows.length, 1);
});

test("LEADS 08.6: required problem context is enforced server-side", async () => {
  const key = crypto.randomUUID();
  const state = await submitLead(
    "workshop",
    "/workshop",
    "private_team",
    undefined,
    leadForm({ idempotencyKey: key, problem: "too short" }),
  );

  assert.equal(state?.ok, false);
  if (!state || state.ok) return;
  assert.ok(state.fieldErrors?.problemSummary?.length);

  const db = await getDb();
  const row = await db
    .select()
    .from(leadSubmissions)
    .where(eq(leadSubmissions.idempotencyKey, key))
    .get();
  assert.equal(row, undefined);
});

test("LEADS 08.6: AI waitlist requirements are enforced on the server", async () => {
  const key = crypto.randomUUID();
  const state = await submitLead(
    "ai_os",
    "/ai-recruiter-os",
    "research",
    undefined,
    leadForm({
      idempotencyKey: key,
      research: false,
      aiUseLevel: "",
      workflow: "",
    }),
  );

  assert.equal(state?.ok, false);
  if (!state || state.ok) return;
  assert.ok(state.fieldErrors?.researchAccepted?.length);
  assert.ok(state.fieldErrors?.aiUseLevel?.length);
  assert.ok(state.fieldErrors?.workflowToImprove?.length);
});

test("LEADS 08.6: phone follow-up consent requires a validated phone number", async () => {
  const key = crypto.randomUUID();
  const state = await submitLead(
    "coaching",
    "/coaching",
    "decision_brief",
    undefined,
    leadForm({ idempotencyKey: key, whatsapp: true }),
  );

  assert.equal(state?.ok, false);
  if (!state || state.ok) return;
  assert.ok(state.fieldErrors?.phoneE164?.length);
});

test("LEADS 08.6: honeypot rejects bot submission without persistence", async () => {
  const key = crypto.randomUUID();
  const state = await submitLead(
    "contact",
    "/contact",
    "general",
    undefined,
    leadForm({ idempotencyKey: key, website: "https://spam.example" }),
  );

  assert.equal(state?.ok, false);

  const db = await getDb();
  const row = await db
    .select()
    .from(leadSubmissions)
    .where(eq(leadSubmissions.idempotencyKey, key))
    .get();
  assert.equal(row, undefined);
});

test("LEADS 08.6: per-email velocity guard blocks repeated enquiry flooding", async () => {
  const email = `velocity-${crypto.randomUUID()}@example.com`;

  for (let index = 0; index < 5; index += 1) {
    const state = await submitLead(
      "contact",
      "/contact",
      "general",
      undefined,
      leadForm({ email }),
    );
    assert.equal(state?.ok, true);
  }

  const blocked = await submitLead(
    "contact",
    "/contact",
    "general",
    undefined,
    leadForm({ email }),
  );
  assert.equal(blocked?.ok, false);
});

test("LEADS 08.6: parallel rotating-email intake cannot exceed atomic kind cap", async () => {
  const db = await getDb();
  await db.delete(leadSubmissions).run();
  await db.delete(publicRateLimits).run();

  const states = await Promise.all(
    Array.from({ length: 45 }, (_, index) =>
      submitLead(
        "contact",
        "/contact",
        "general",
        undefined,
        leadForm({
          email: `parallel-lead-${index}@example.com`,
        }),
      ),
    ),
  );

  assert.equal(states.filter((state) => state?.ok).length, 40);
  assert.equal(states.filter((state) => state && !state.ok).length, 5);

  const rows = await db.select().from(leadSubmissions).all();
  assert.equal(rows.length, 40);
});

test("LEADS 08.6: migration journal/snapshot include unique 0016 lead identity", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const journal = JSON.parse(
    readFileSync(
      join(process.cwd(), "drizzle", "migrations", "meta", "_journal.json"),
      "utf8",
    ),
  );
  const tags = journal.entries.map((entry: { tag: string }) => entry.tag);
  assert.equal(tags.filter((tag: string) => tag.startsWith("0016_")).length, 1);
  assert.ok(tags.includes("0016_lead_submissions"));
  assert.ok(
    existsSync(
      join(
        process.cwd(),
        "drizzle",
        "migrations",
        "meta",
        "0016_snapshot.json",
      ),
    ),
  );
  assert.equal(tags.filter((tag: string) => tag.startsWith("0017_")).length, 1);
  assert.ok(tags.includes("0017_public_rate_limits"));
  assert.ok(
    existsSync(
      join(
        process.cwd(),
        "drizzle",
        "migrations",
        "meta",
        "0017_snapshot.json",
      ),
    ),
  );
});
