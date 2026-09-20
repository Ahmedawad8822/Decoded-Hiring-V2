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
