/**
 * BUSINESS EVENTS HARDENING: the Drizzle table matches the migrated table,
 * summary reads never write, and retention pruning is bounded and only
 * removes rows older than the retention.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import { getTableConfig } from "drizzle-orm/sqlite-core";

import {
  clearD1DatabaseForTest,
  disposeCloudflareBindings,
  getD1Database,
} from "../src/lib/cloudflare/bindings";
import { businessEvents, getDb } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  BUSINESS_EVENT_PRUNE_BATCH,
  BUSINESS_EVENT_RETENTION_DAYS,
  countBusinessEvents,
  getBusinessEventSummary,
  pruneExpiredBusinessEvents,
  reconcileDurableBusinessEvents,
  recordBusinessEvent,
  setBusinessEventPruneSamplerForTest,
} from "../src/features/analytics/service";

const DAY_S = 24 * 60 * 60;
const NOW = new Date("2026-10-26T12:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  setBusinessEventPruneSamplerForTest(null);
  clearD1DatabaseForTest();
  await disposeCloudflareBindings();
});

async function total(): Promise<number> {
  const d1 = await getD1Database();
  const row = await d1
    .prepare("SELECT COUNT(*) AS n FROM business_events")
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function seedRaw(
  rows: Array<{ key: string; occurredAt: number }>,
): Promise<void> {
  const db = await getDb();
  for (const row of rows) {
    await db
      .insert(businessEvents)
      .values({
        id: `bev_t_${row.key}`,
        dedupeKey: row.key,
        eventName: "offer_cta_clicked",
        occurredAt: row.occurredAt,
        createdAt: row.occurredAt,
      })
      .run();
  }
}

test("retention is a named 400-day policy default", () => {
  assert.equal(BUSINESS_EVENT_RETENTION_DAYS, 400);
});

test("schema parity: Drizzle businessEvents matches the migrated table", async () => {
  const d1 = await getD1Database();
  const config = getTableConfig(businessEvents);
  assert.equal(config.name, "business_events");

  const info = await d1
    .prepare("PRAGMA table_info('business_events')")
    .all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>();
  const actual = new Map((info.results ?? []).map((c) => [c.name, c]));
  assert.equal(actual.size, config.columns.length, "same column count");
  for (const column of config.columns) {
    const col = actual.get(column.name);
    assert.ok(col, `column ${column.name} exists in the migrated table`);
    assert.equal(col.type.toLowerCase(), column.getSQLType().toLowerCase());
    assert.equal(Boolean(col.notnull) || col.pk > 0, column.notNull || column.primary);
    assert.equal(col.pk > 0, column.primary, `${column.name} primary key`);
    if (column.hasDefault) {
      assert.equal(col.dflt_value, `'${column.default}'`, `${column.name} default`);
    } else {
      assert.equal(col.dflt_value, null, `${column.name} has no default`);
    }
  }

  const indexList = await d1
    .prepare("PRAGMA index_list('business_events')")
    .all<{ name: string; unique: number; origin: string }>();
  const created = (indexList.results ?? []).filter((i) => i.origin === "c");
  const declared = new Map(config.indexes.map((i) => [i.config.name, i.config]));
  assert.deepEqual(
    created.map((i) => i.name).sort(),
    [...declared.keys()].sort(),
    "same explicit indexes",
  );
  for (const index of created) {
    const cfg = declared.get(index.name)!;
    assert.equal(Boolean(index.unique), Boolean(cfg.unique), `${index.name} uniqueness`);
    const cols = await d1
      .prepare(`PRAGMA index_info('${index.name}')`)
      .all<{ seqno: number; name: string }>();
    assert.deepEqual(
      (cols.results ?? []).sort((a, b) => a.seqno - b.seqno).map((c) => c.name),
      cfg.columns.map((c) => (c as { name: string }).name),
      `${index.name} columns`,
    );
  }
});

test("getBusinessEventSummary performs no writes (no reconciliation on read)", async () => {
  await seedRaw([{ key: "ro-fresh", occurredAt: NOW_S - 60 }]);
  const before = await total();

  const summary = await getBusinessEventSummary({ windowDays: 30, now: NOW });
  assert.equal(summary.counts.offer_cta_clicked, 1);
  assert.equal(await total(), before, "summary must not insert rows");

  // The explicit reconcile function is the only writer and stays idempotent.
  await reconcileDurableBusinessEvents({ since: new Date(NOW_S * 1000 - DAY_S * 1000) });
  const afterFirst = await total();
  await reconcileDurableBusinessEvents({ since: new Date(NOW_S * 1000 - DAY_S * 1000) });
  assert.equal(await total(), afterFirst);
});

test("pruneExpiredBusinessEvents removes only rows older than retention", async () => {
  const d1 = await getD1Database();
  await d1.prepare("DELETE FROM business_events").run();
  const cutoff = NOW_S - BUSINESS_EVENT_RETENTION_DAYS * DAY_S;
  await seedRaw([
    { key: "old-1", occurredAt: cutoff - 10 },
    { key: "old-2", occurredAt: cutoff - DAY_S },
    { key: "edge", occurredAt: cutoff },
    { key: "fresh-1", occurredAt: cutoff + 10 },
    { key: "fresh-2", occurredAt: NOW_S },
  ]);

  const deleted = await pruneExpiredBusinessEvents(NOW);
  assert.equal(deleted, 2);
  assert.equal(await total(), 3);
  const keys = await d1
    .prepare("SELECT dedupe_key AS k FROM business_events ORDER BY dedupe_key")
    .all<{ k: string }>();
  assert.deepEqual(
    (keys.results ?? []).map((r) => r.k),
    ["edge", "fresh-1", "fresh-2"],
  );
});

test("pruning is bounded per call and drains over repeated calls", async () => {
  const d1 = await getD1Database();
  await d1.prepare("DELETE FROM business_events").run();
  const old = NOW_S - (BUSINESS_EVENT_RETENTION_DAYS + 5) * DAY_S;
  await seedRaw(
    Array.from({ length: 7 }, (_, i) => ({ key: `bulk-${i}`, occurredAt: old + i })),
  );
  assert.ok(BUSINESS_EVENT_PRUNE_BATCH >= 1);

  assert.equal(await pruneExpiredBusinessEvents(NOW, { limit: 3 }), 3);
  assert.equal(await total(), 4);
  assert.equal(await pruneExpiredBusinessEvents(NOW, { limit: 3 }), 3);
  assert.equal(await pruneExpiredBusinessEvents(NOW, { limit: 3 }), 1);
  assert.equal(await total(), 0);
});

test("a successful event write opportunistically prunes (sampler seam)", async () => {
  const d1 = await getD1Database();
  await d1.prepare("DELETE FROM business_events").run();
  const old = Math.floor(Date.now() / 1000) - (BUSINESS_EVENT_RETENTION_DAYS + 5) * DAY_S;
  await seedRaw([{ key: "stale", occurredAt: old }]);

  setBusinessEventPruneSamplerForTest(() => 0.999);
  await recordBusinessEvent({ dedupeKey: "live-a", eventName: "offer_cta_clicked" });
  assert.equal(await countBusinessEvents("offer_cta_clicked"), 2, "no prune when sampler misses");

  setBusinessEventPruneSamplerForTest(() => 0);
  await recordBusinessEvent({ dedupeKey: "live-b", eventName: "offer_cta_clicked" });
  assert.equal(await countBusinessEvents("offer_cta_clicked"), 2, "stale row pruned, live-a and live-b remain");
  setBusinessEventPruneSamplerForTest(null);
});
