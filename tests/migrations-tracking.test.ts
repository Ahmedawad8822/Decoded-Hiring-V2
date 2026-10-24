/**
 * MIGRATION TRACKING REGRESSIONS
 * ---------------------------------------------------------------------------
 * migrateLocalDb records applied files in wrangler's `d1_migrations` table
 * (id, name, applied_at; name = .sql file name) and applies only unrecorded
 * files. Legacy DBs (schema present, no tracking rows) are baselined once.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: throwaway DH_LOCAL_STATE_DIR + test secret.

import * as fs from "node:fs";
import * as path from "node:path";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings, getD1Database } from "../src/lib/cloudflare/bindings";

const files = fs
  .readdirSync(path.join(process.cwd(), "drizzle", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();

async function recorded(): Promise<string[]> {
  const d1 = await getD1Database();
  const { results } = await d1
    .prepare(`SELECT name FROM d1_migrations ORDER BY id`)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

async function indexExists(name: string): Promise<boolean> {
  const d1 = await getD1Database();
  const row = await d1
    .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .bind(name)
    .first();
  return row !== null;
}

test.after(async () => {
  await disposeCloudflareBindings();
});

// Tests share one throwaway DB and run in order.
test("fresh DB applies every migration strictly and records each file", async () => {
  await migrateLocalDb();
  assert.deepEqual(await recorded(), files);
});

test("second run applies nothing", async () => {
  const d1 = await getD1Database();
  const probe = "business_events_booking_idx";
  assert.equal(await indexExists(probe), true);
  const before = await d1.prepare(`SELECT id, applied_at FROM d1_migrations ORDER BY id`).all();
  // Remove an object a migration creates: a re-run of 0018 would recreate it.
  await d1.prepare(`DROP INDEX ${probe}`).run();
  await migrateLocalDb();
  assert.equal(await indexExists(probe), false, "recorded migration must not re-execute");
  const after = await d1.prepare(`SELECT id, applied_at FROM d1_migrations ORDER BY id`).all();
  assert.deepEqual(after.results, before.results);
});

test("legacy DB (schema present, tracking empty) is baselined without errors", async () => {
  const d1 = await getD1Database();
  await d1.prepare(`DELETE FROM d1_migrations`).run();
  await migrateLocalDb(); // tolerant pass: "already exists" tolerated, probe index recreated
  assert.deepEqual(await recorded(), files);
  assert.equal(await indexExists("business_events_booking_idx"), true);
  await migrateLocalDb(); // now tracked: strict no-op
  assert.deepEqual(await recorded(), files);
});

test("a recorded-empty DB with a missing tail migration applies only that one strictly", async () => {
  const d1 = await getD1Database();
  const last = files[files.length - 1];
  await d1.prepare(`DELETE FROM d1_migrations WHERE name = ?`).bind(last).run();
  // Strict path (tracking non-empty): the tail file's CREATE TABLE already
  // exists, so this must fail loudly rather than be tolerated.
  await assert.rejects(() => migrateLocalDb(), /D1 Migration Failure/);
  await d1.prepare(`INSERT INTO d1_migrations (name) VALUES (?)`).bind(last).run();
});
