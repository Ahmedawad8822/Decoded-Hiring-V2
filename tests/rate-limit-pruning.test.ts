/**
 * RATE LIMIT PRUNING: expired fixed-window rows (public_rate_limits) are
 * deleted in bounded batches, live rows are never touched, and a pruning
 * failure never changes the admit/deny decision of a consume call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import type { D1Database } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";

import { getDb, publicRateLimits } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  clearD1DatabaseForTest,
  disposeCloudflareBindings,
  getD1Database,
  setD1DatabaseForTest,
} from "../src/lib/cloudflare/bindings";
import {
  RATE_LIMIT_RETENTION_MS,
  consumeFixedWindowMs,
  pruneExpiredRateLimits,
  setRateLimitPruneSamplerForTest,
} from "../src/features/public-intake/rate-limit";

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-10-24T12:00:00.000Z");

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  setRateLimitPruneSamplerForTest(null);
  clearD1DatabaseForTest();
  await disposeCloudflareBindings();
});

async function resetRows(): Promise<void> {
  const db = await getDb();
  await db.delete(publicRateLimits).run();
}

async function insertRows(
  rows: Array<{ scopeKey: string; windowStart: number }>,
): Promise<void> {
  const db = await getDb();
  for (const row of rows) {
    await db
      .insert(publicRateLimits)
      .values({
        scopeKey: row.scopeKey,
        windowStart: row.windowStart,
        count: 1,
        updatedAt: NOW,
      })
      .run();
  }
}

async function scopeKeys(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select({ scopeKey: publicRateLimits.scopeKey }).from(publicRateLimits);
  return rows.map((row) => row.scopeKey).sort();
}

test("prune deletes windows older than retention and keeps recent and live rows", async () => {
  await resetRows();
  const old = NOW.getTime() - RATE_LIMIT_RETENTION_MS - HOUR_MS;
  await insertRows([
    { scopeKey: "old:a", windowStart: old },
    { scopeKey: "old:b", windowStart: NOW.getTime() - 25 * HOUR_MS },
    { scopeKey: "recent:a", windowStart: NOW.getTime() - 2 * HOUR_MS },
    { scopeKey: "recent:b", windowStart: NOW.getTime() - 60 * 1000 },
    { scopeKey: "live:now", windowStart: NOW.getTime() },
  ]);

  const deleted = await pruneExpiredRateLimits(NOW);

  assert.equal(deleted, 2);
  assert.deepEqual(await scopeKeys(), ["live:now", "recent:a", "recent:b"]);
});

test("prune never deletes a row exactly at the retention cutoff or later", async () => {
  await resetRows();
  await insertRows([
    { scopeKey: "edge:at-cutoff", windowStart: NOW.getTime() - RATE_LIMIT_RETENTION_MS },
    { scopeKey: "edge:just-expired", windowStart: NOW.getTime() - RATE_LIMIT_RETENTION_MS - 1 },
  ]);

  const deleted = await pruneExpiredRateLimits(NOW);

  assert.equal(deleted, 1);
  assert.deepEqual(await scopeKeys(), ["edge:at-cutoff"]);
});

test("prune honours the batch bound and drains the rest over later calls", async () => {
  await resetRows();
  const expired = NOW.getTime() - 48 * HOUR_MS;
  await insertRows(
    Array.from({ length: 7 }, (_, i) => ({ scopeKey: `bulk:${i}`, windowStart: expired + i })),
  );

  const first = await pruneExpiredRateLimits(NOW, { limit: 3 });
  assert.equal(first, 3, "one call deletes at most `limit` rows");
  assert.equal((await scopeKeys()).length, 4);

  const second = await pruneExpiredRateLimits(NOW, { limit: 3 });
  assert.equal(second, 3);

  const third = await pruneExpiredRateLimits(NOW, { limit: 3 });
  assert.equal(third, 1);
  assert.deepEqual(await scopeKeys(), []);

  assert.equal(await pruneExpiredRateLimits(NOW), 0, "nothing left is a no-op");
});

test("prune uses the window_start index and the index exists", async () => {
  const d1 = await getD1Database();
  const indexes = await d1
    .prepare("PRAGMA index_list('public_rate_limits')")
    .all<{ name: string }>();
  assert.ok(
    indexes.results.some((index) => index.name === "public_rate_limits_window_start_idx"),
    "migration 0019 must create the window_start index",
  );

  const plan = await d1
    .prepare(
      "EXPLAIN QUERY PLAN SELECT scope_key FROM public_rate_limits WHERE window_start < ? ORDER BY window_start LIMIT ?",
    )
    .bind(0, 500)
    .all<{ detail: string }>();
  assert.ok(
    plan.results.some((row) => row.detail.includes("public_rate_limits_window_start_idx")),
    `expected an index range scan, got: ${plan.results.map((row) => row.detail).join(" | ")}`,
  );
});

test("consume admits again after its expired row is pruned (fresh window)", async () => {
  await resetRows();
  const scopeKey = "fresh:after-prune";
  await insertRows([
    { scopeKey, windowStart: NOW.getTime() - 48 * HOUR_MS },
  ]);
  // Force the opportunistic pass so the consume itself does the pruning.
  setRateLimitPruneSamplerForTest(() => 0);
  try {
    const result = await consumeFixedWindowMs({
      scopeKey,
      now: NOW,
      windowMs: 60 * 60 * 1000,
      maxCount: 1,
    });
    assert.equal(result.allowed, true);
  } finally {
    setRateLimitPruneSamplerForTest(null);
  }
  const db = await getDb();
  const row = await db
    .select()
    .from(publicRateLimits)
    .where(eq(publicRateLimits.scopeKey, scopeKey))
    .get();
  assert.equal(row?.count, 1);
  assert.equal(row?.windowStart, NOW.getTime());
});

test("opportunistic pruning runs only when the sampler is under the probability", async () => {
  await resetRows();
  const expiredKey = "sampled:expired";
  await insertRows([{ scopeKey: expiredKey, windowStart: NOW.getTime() - 48 * HOUR_MS }]);
  const consume = () =>
    consumeFixedWindowMs({
      scopeKey: "sampled:consumer",
      now: NOW,
      windowMs: 60 * 1000,
      maxCount: 5,
    });

  try {
    setRateLimitPruneSamplerForTest(() => 0.5);
    await consume();
    assert.ok((await scopeKeys()).includes(expiredKey), "sample above 1% must not prune");

    setRateLimitPruneSamplerForTest(() => 0);
    await consume();
    assert.ok(!(await scopeKeys()).includes(expiredKey), "sample below 1% prunes");
  } finally {
    setRateLimitPruneSamplerForTest(null);
  }
});

test("a pruning failure is logged and never changes the consume decision", async () => {
  await resetRows();
  const scopeKey = "failure:isolated";
  const realD1 = await getD1Database();
  // Only DELETE statements fail, so admission (INSERT ... ON CONFLICT) is real.
  const failingDelete = {
    prepare(query: string) {
      if (/^\s*delete\b/i.test(query)) {
        throw new Error("injected D1 failure during prune");
      }
      return realD1.prepare(query);
    },
    batch: realD1.batch.bind(realD1),
  } as unknown as D1Database;

  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };

  setD1DatabaseForTest(failingDelete);
  setRateLimitPruneSamplerForTest(() => 0);
  try {
    const decisions: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await consumeFixedWindowMs({
        scopeKey,
        now: NOW,
        windowMs: 60 * 1000,
        maxCount: 2,
      });
      decisions.push(result.allowed);
    }
    assert.deepEqual(decisions, [true, true, false], "admit/deny unaffected by prune failure");
  } finally {
    setRateLimitPruneSamplerForTest(null);
    clearD1DatabaseForTest();
    console.error = originalError;
  }

  assert.ok(
    logged.some((line) => line.includes("expired-row pruning failed")),
    "prune failure must be logged",
  );
});

test("windows longer than the pruning retention are rejected loudly", async () => {
  await assert.rejects(
    () =>
      consumeFixedWindowMs({
        scopeKey: "test:too-long-window",
        now: new Date(),
        windowMs: RATE_LIMIT_RETENTION_MS + 1,
        maxCount: 1,
      }),
    /exceeds RATE_LIMIT_RETENTION_MS/,
  );
});
