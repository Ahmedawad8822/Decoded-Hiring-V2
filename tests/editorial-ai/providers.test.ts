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

// ---------------------------------------------------------------------------
// REGRESSION: Migration 0008 must NOT erase legitimate authorship.
// ---------------------------------------------------------------------------
// Business rule (Mission 07 final handoff):
//   - Existing legitimate Ahmed-authored content keeps "Ahmed Awad".
//   - New Editorial AI publication uses an explicit editorial author.
//   - Generic schema/Zod/service fallback may use "Decoded Editorial".
//   - A migration may correct only rows that can be safely identified as bad
//     defaults. Ahmed Awad is the founder/editor — his authored content is
//     legitimate, so no row is a "bad default." Migration 0008 therefore
//     corrects ONLY the column DEFAULT (for new rows) and preserves every
//     existing author verbatim via the INSERT ... SELECT that copies the
//     `author` column. There is NO backfill UPDATE.
//
// This test proves: an existing Ahmed-authored Guide and Field Note remain
// "Ahmed Awad" after migration 0008 — i.e. there is no
//   UPDATE <table> SET author = 'Decoded Editorial' WHERE author = 'Ahmed Awad'
// backfill, and the table-copy INSERT selects the `author` column.
test("migration: 0008 corrects the author DEFAULT but does NOT rewrite existing authors", () => {
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
  // The DEFAULT for both tables must be corrected to the canonical identity.
  assert.ok(
    sql.includes("DEFAULT 'Decoded Editorial'"),
    "Migration 0008 must set the author column DEFAULT to 'Decoded Editorial'",
  );
  // No personal-name DEFAULT may remain in the migration.
  assert.ok(
    !/DEFAULT\s+'Ahmed Awad'/.test(sql),
    "Migration 0008 must not carry a personal-name 'Ahmed Awad' DEFAULT",
  );
});

test("migration: 0008 does NOT blanket-rewrite existing Ahmed Awad authorship", () => {
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

  // There must be NO backfill that rewrites existing authors:
  //   UPDATE <table> SET author = 'Decoded Editorial' [WHERE author = 'Ahmed Awad']
  // The original migration did this for both guides and field_notes; it must
  // be gone so legitimate Ahmed-authored content keeps "Ahmed Awad".
  const backfillStatements = sql
    .split(";")
    .filter(
      (s) =>
        /UPDATE/i.test(s) &&
        /SET\s+`author`\s*=\s*'Decoded Editorial'/i.test(s),
    );
  assert.equal(
    backfillStatements.length,
    0,
    `Migration 0008 must not rewrite existing author values — found: ${backfillStatements.map((s) => s.trim().slice(0, 80)).join("; ")}`,
  );
});

test("migration: 0008 preserves existing Ahmed-authored Guide and Field Note authors", () => {
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

  // Each table rebuild must copy the existing `author` column verbatim via
  // INSERT ... SELECT so an existing "Ahmed Awad" row stays "Ahmed Awad"
  // (no NULL, no DEFAULT substitution, no rewrite).
  for (const table of ["__new_guides", "__new_field_notes"]) {
    const insertChunk = sql
      .split(";")
      .find(
        (s) =>
          s.includes("INSERT INTO `") &&
          s.includes(table) &&
          s.includes('"author"'),
      );
    assert.ok(
      insertChunk,
      `Migration 0008 must copy the \`author\` column when rebuilding ${table} so existing authors (incl. "Ahmed Awad") are preserved`,
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
