/**
 * PER-IP INTAKE LIMITS: client IP resolution, salted hashing, and the rule
 * that the per-IP bucket is checked BEFORE shared counters, so one limited IP
 * never spends the shared budget (and other IPs are unaffected).
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import { eq } from "drizzle-orm";

import { getDb, publicRateLimits } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  clearD1DatabaseForTest,
  disposeCloudflareBindings,
} from "../src/lib/cloudflare/bindings";
import {
  PUBLIC_IP_LIMITS,
  UNKNOWN_CLIENT_IP,
  consumePublicIpLimit,
  getRequestClientIpHash,
  hashClientIp,
  resolveClientIp,
  setRateLimitPruneSamplerForTest,
} from "../src/features/public-intake/rate-limit";
import { createLeadSubmission } from "../src/features/leads/service";
import { consumePublicBookingAdmission } from "../src/features/scheduling/public-scheduling";

const NOW = new Date("2026-10-24T12:00:00.000Z");

test.before(async () => {
  await migrateLocalDb();
  // Never prune during these tests.
  setRateLimitPruneSamplerForTest(() => 1);
});

test.after(async () => {
  setRateLimitPruneSamplerForTest(null);
  clearD1DatabaseForTest();
  await disposeCloudflareBindings();
});

async function countFor(scopeKey: string): Promise<number> {
  const db = await getDb();
  const row = await db
    .select({ count: publicRateLimits.count })
    .from(publicRateLimits)
    .where(eq(publicRateLimits.scopeKey, scopeKey))
    .get();
  return row?.count ?? 0;
}

test("resolveClientIp prefers CF-Connecting-IP, then first XFF, then unknown", () => {
  assert.equal(
    resolveClientIp(
      new Headers({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }),
    ),
    "1.1.1.1",
  );
  assert.equal(
    resolveClientIp(new Headers({ "x-forwarded-for": " 2.2.2.2 , 3.3.3.3" })),
    "2.2.2.2",
  );
  assert.equal(resolveClientIp(new Headers()), UNKNOWN_CLIENT_IP);
});

test("hashClientIp is salted SHA-256, deterministic, never the raw IP", async () => {
  const a = await hashClientIp("203.0.113.7");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await hashClientIp("203.0.113.7"));
  assert.notEqual(a, await hashClientIp("203.0.113.8"));
  assert.ok(!a.includes("203.0.113.7"));

  const saved = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = "a-different-salt-0123456789abcdef";
  try {
    assert.notEqual(a, await hashClientIp("203.0.113.7"));
  } finally {
    process.env.BETTER_AUTH_SECRET = saved;
  }
});

test("getRequestClientIpHash returns null outside a request context", async () => {
  assert.equal(await getRequestClientIpHash(), null);
});

test("per-IP bucket caps one IP and leaves another IP alone; stores only hashes", async () => {
  const ipA = await hashClientIp("198.51.100.1");
  const ipB = await hashClientIp("198.51.100.2");
  const limit = PUBLIC_IP_LIMITS.analytics;
  for (let i = 0; i < limit.maxCount; i += 1) {
    assert.equal(await consumePublicIpLimit({ ipHash: ipA, limit, now: NOW }), true);
  }
  assert.equal(await consumePublicIpLimit({ ipHash: ipA, limit, now: NOW }), false);
  assert.equal(await consumePublicIpLimit({ ipHash: ipB, limit, now: NOW }), true);

  const db = await getDb();
  const rows = await db.select().from(publicRateLimits).all();
  assert.ok(rows.every((r) => !r.scopeKey.includes("198.51.100")));
});

test("booking: a limited IP is rejected without spending email or burst budgets", async () => {
  const ip = await hashClientIp("192.0.2.10");
  const limit = PUBLIC_IP_LIMITS.booking;
  const bookingTypeId = "bt-ip-test";
  for (let i = 0; i < limit.maxCount; i += 1) {
    await consumePublicIpLimit({ ipHash: ip, limit, now: NOW });
  }
  const admitted = await consumePublicBookingAdmission({
    bookingTypeId,
    requesterEmail: "ip-test@example.com",
    clientIpHash: ip,
    now: NOW,
  });
  assert.equal(admitted, false);
  assert.equal(await countFor(`booking:${bookingTypeId}:burst`), 0);

  const other = await consumePublicBookingAdmission({
    bookingTypeId,
    requesterEmail: "ip-test2@example.com",
    clientIpHash: await hashClientIp("192.0.2.11"),
    now: NOW,
  });
  assert.equal(other, true);
  assert.equal(await countFor(`booking:${bookingTypeId}:burst`), 1);
});

test("lead: a limited IP gets the generic RATE_LIMITED error and spends no kind budget", async () => {
  const ip = await hashClientIp("192.0.2.20");
  const limit = PUBLIC_IP_LIMITS.lead;
  for (let i = 0; i < limit.maxCount; i += 1) {
    await consumePublicIpLimit({ ipHash: ip, limit, now: NOW });
  }
  await assert.rejects(
    createLeadSubmission({
      idempotencyKey: "00000000-0000-4000-8000-0000000000aa",
      kind: "CONTACT",
      fullName: "Ip Tester",
      email: "ip-lead@example.com",
      positionTitle: null,
      companyName: null,
      countryCode: null,
      phoneE164: null,
      problemSummary: "Testing the per-IP limit",
      desiredOutcome: null,
      timing: null,
      teamSize: null,
      deliveryPreference: null,
      aiUseLevel: null,
      workflowToImprove: null,
      sourceRoute: "/contact",
      audiencePath: null,
      privacyAcknowledged: true,
      researchAccepted: false,
      emailMarketing: false,
      whatsapp: false,
      calls: false,
      clientIpHash: ip,
      now: NOW,
    } as never),
    (error: unknown) => (error as { code?: string }).code === "RATE_LIMITED",
  );
  assert.equal(await countFor("lead:kind:CONTACT"), 0);
});
