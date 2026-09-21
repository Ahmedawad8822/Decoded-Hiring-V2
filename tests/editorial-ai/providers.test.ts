/**
 * EDITORIAL AI — PROVIDER & GUARD REGRESSION TEST (Mission 07 §7)
 * ---------------------------------------------------------------------------
 * Guards against reintroduction of the FakeProvider production leak and
 * identity contamination in schema defaults.
 *
 * Covers:
 *   1. resolveProvider() throws EditorialProviderNotConfiguredError when
 *      the EDITORIAL_MODEL_* env vars are absent (fail-closed, no silent
 *      fallback to FakeProvider).
 *   2. generateDraftAction source contains the NODE_ENV !== "production"
 *      guard — FakeProvider may NEVER activate in production even when
 *      EDITORIAL_FORCE_FAKE_PROVIDER=1 is set.
 *   3. Schema author defaults are "Decoded Editorial", not a personal name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveProvider,
  EditorialProviderNotConfiguredError,
  isProviderNotConfigured,
} from "../../src/features/editorial-ai/providers/index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  "../../src/lib/db/schema.ts",
);
const ACTIONS_PATH = path.resolve(
  __dirname,
  "../../src/features/editorial-ai/drafts/actions.ts",
);

test("provider: resolveProvider() throws EditorialProviderNotConfiguredError when env vars are absent", async () => {
  // Simulate an unconfigured environment by passing an explicit empty env.
  // No real provider import happens; resolveProvider throws before that.
  await assert.rejects(
    async () =>
      resolveProvider({
        baseUrl: undefined,
        apiKey: undefined,
        modelName: undefined,
        temperature: 0.3,
        maxTokens: 2000,
      }),
    (err: unknown) => {
      assert.ok(
        err instanceof EditorialProviderNotConfiguredError,
        `Expected EditorialProviderNotConfiguredError, got: ${err}`,
      );
      assert.ok(
        isProviderNotConfigured(err),
        "isProviderNotConfigured should recognise the error",
      );
      return true;
    },
  );
});

test("provider: generateDraftAction source contains NODE_ENV production guard", () => {
  const source = fs.readFileSync(ACTIONS_PATH, "utf-8");
  // The guard must be a compound condition: flag AND not-production.
  assert.ok(
    source.includes("EDITORIAL_FORCE_FAKE_PROVIDER"),
    "generateDraftAction must reference the EDITORIAL_FORCE_FAKE_PROVIDER flag",
  );
  assert.ok(
    source.includes('NODE_ENV !== "production"'),
    "generateDraftAction must check NODE_ENV !== \"production\" to prevent " +
      "FakeProvider activation in production — this is the single control " +
      "point for the EDITORIAL_FORCE_FAKE_PROVIDER env flag.",
  );
  // The guard must be on the SAME if-statement (compound condition).
  const flagLine = source.split("\n").find((line) =>
    line.includes("EDITORIAL_FORCE_FAKE_PROVIDER"),
  );
  assert.ok(flagLine, "Should find a line referencing EDITORIAL_FORCE_FAKE_PROVIDER");
  // Walk forward to ensure NODE_ENV check is within the same if-condition block
  // (the guard must be `flag && NODE_ENV`, not `flag` alone then a separate check).
  const guardBlock = source
    .split("\n")
    .filter(
      (line, idx, all) =>
        line.includes("EDITORIAL_FORCE_FAKE_PROVIDER") ||
        all[idx - 1]?.includes("EDITORIAL_FORCE_FAKE_PROVIDER") ||
        (all[idx - 1]?.trim().endsWith("&&") && line.includes("NODE_ENV")),
    )
    .join("\n");
  assert.ok(
    guardBlock.includes("NODE_ENV"),
    "NODE_ENV check must be part of the same compound condition as the " +
      "EDITORIAL_FORCE_FAKE_PROVIDER flag check",
  );
});

test("schema: author defaults are 'Decoded Editorial', not a personal name", () => {
  const source = fs.readFileSync(SCHEMA_PATH, "utf-8");
  // guides.author and field_notes.author must default to "Decoded Editorial"
  assert.ok(
    source.includes('default("Decoded Editorial")'),
    "guides.author and field_notes.author must default to 'Decoded Editorial' — " +
      "the platform identity, never a personal name.",
  );
  // No personal names in schema defaults
  assert.ok(
    !/default\("Ahmed Awad"\)/.test(source),
    "Personal name 'Ahmed Awad' must not appear as a schema default.",
  );
});

test("migration: migration 0008 exists and backfills author identity", () => {
  const migrationsDir = path.resolve(
    import.meta.dirname,
    "../../drizzle/migrations",
  );
  const files = fs.readdirSync(migrationsDir);
  const m0008 = files.find(
    (f) => f.startsWith("0008_") && f.endsWith(".sql"),
  );
  assert.ok(m0008, "Migration 0008 SQL file must exist in drizzle/migrations/");

  const sql = fs.readFileSync(path.join(migrationsDir, m0008), "utf-8");
  assert.ok(
    sql.includes("Decoded Editorial"),
    "Migration 0008 must reference 'Decoded Editorial' as the corrected identity",
  );
  assert.ok(
    sql.includes("Ahmed Awad"),
    "Migration 0008 must backfill existing 'Ahmed Awad' rows to the canonical identity",
  );
});

// ---------------------------------------------------------------------------
// REGRESSION: Migration 0008 backfill must NOT erase legitimate authorship.
// ---------------------------------------------------------------------------
// "Ahmed Awad" was a personal name that leaked into production schema defaults
// (migration 0000 set guides.author DEFAULT 'Ahmed Awad'; 0001 did the same
// for field_notes). It was used as a fallback default — NOT as a real named
// author on any seed or migration content. Migration 0008 backfills all rows
// WHERE author = 'Ahmed Awad' → 'Decoded Editorial'. This is safe because:
//
//   (a) No migration (0000–0008) INSERTs seed data with author = 'Ahmed Awad'.
//   (b) The current seed.ts uses author = 'Decoded Editorial' (changed at R02).
//   (c) resolveAuthorName() falls back to DEFAULT_PUBLISH_AUTHOR = 'Decoded Editorial'.
//   (d) The schema default is 'Decoded Editorial' (changed at R02).
//
// This test proves the backfill is scoped (has a WHERE clause) and that no
// source code still defaults author to 'Ahmed Awad'.
test("migration: 0008 backfill is scoped — WHERE author='Ahmed Awad' only (no blanket UPDATE)", () => {
  const migrationsDir = path.resolve(
    import.meta.dirname,
    "../../drizzle/migrations",
  );
  const files = fs.readdirSync(migrationsDir);
  const m0008 = files.find(
    (f) => f.startsWith("0008_") && f.endsWith(".sql"),
  );
  assert.ok(m0008, "Migration 0008 must exist");

  const sql = fs.readFileSync(path.join(migrationsDir, m0008), "utf-8");

  // The backfill must use a WHERE clause limiting to author = 'Ahmed Awad'.
  // A blanket "UPDATE ... SET author='Decoded Editorial'" (without WHERE)
  // would erase legitimate authorship — that is forbidden.
  const updateStatements = sql
    .split(";")
    .filter(
      (s) =>
        s.trim().toUpperCase().includes("UPDATE") && s.includes("'Ahmed Awad'"),
    );

  assert.ok(
    updateStatements.length >= 2,
    "Migration 0008 must backfill both guides and field_notes",
  );

  for (const stmt of updateStatements) {
    const upper = stmt.toUpperCase();
    assert.ok(
      upper.includes("WHERE"),
      `Backfill UPDATE must be scoped with a WHERE clause: ${stmt.trim().slice(0, 80)}`,
    );
    // WHERE clause must target ONLY author = 'Ahmed Awad' (backtick-quoted or bare).
    assert.ok(
      /WHERE\s+`?AUTHOR`?\s*=\s*'AHMED AWAD'/i.test(stmt),
      `Backfill WHERE clause must target only author='Ahmed Awad': ${stmt.trim().slice(0, 80)}`,
    );
  }
});

test("migration: no source code uses 'Ahmed Awad' as an author default or fallback", () => {
  const schemaSrc = fs.readFileSync(SCHEMA_PATH, "utf-8");
  const servicePath = path.resolve(
    import.meta.dirname,
    "../../src/features/editorial-ai/drafts/service",
  );

  // Schema must default to 'Decoded Editorial', not a personal name.
  assert.doesNotMatch(
    schemaSrc,
    /default\(["']Ahmed Awad["']/i,
    "Schema must not default author to 'Ahmed Awad'",
  );

  // resolveAuthorName fallback (DEFAULT_PUBLISH_AUTHOR) must not be 'Ahmed Awad'.
  // Check the service source for the constant.
  const serviceSrc = fs.readFileSync(servicePath + ".ts", "utf-8");
  assert.doesNotMatch(
    serviceSrc,
    /DEFAULT_PUBLISH_AUTHOR\s*=\s*["']Ahmed Awad["']/i,
    "DEFAULT_PUBLISH_AUTHOR must not be 'Ahmed Awad'",
  );
  assert.ok(
    serviceSrc.includes('DEFAULT_PUBLISH_AUTHOR = "Decoded Editorial"'),
    "DEFAULT_PUBLISH_AUTHOR must be 'Decoded Editorial'",
  );
});
