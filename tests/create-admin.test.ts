/**
 * CREATE-ADMIN SCRIPT — pure parts: argument parsing (remote needs --env),
 * env input validation, SQL literal escaping and idempotent statement shape.
 * The wrangler/D1 execution path is covered by the manual local end-to-end run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first.

import {
  MIN_PASSWORD_LENGTH,
  buildAdminSql,
  parseArgs,
  readInput,
  sqlString,
  wranglerTargetArgs,
} from "../scripts/create-admin";

const base = {
  email: "a@b.co",
  name: "Admin",
  passwordHash: "salt:hash",
  userId: "u1",
  accountId: "a1",
  nowSeconds: 1700000000,
  userExists: false,
  resetPassword: false,
};

test("parseArgs defaults to local and refuses --remote without --env", () => {
  assert.deepEqual(parseArgs([]).target, { kind: "local" });
  assert.deepEqual(parseArgs(["--local"]).target, { kind: "local" });
  assert.throws(() => parseArgs(["--remote"]), /requires an explicit --env/);
  assert.throws(() => parseArgs(["--remote", "--env"]), /requires a value/);
  assert.throws(() => parseArgs(["--env", "production"]), /only applies together with --remote/);
  assert.throws(() => parseArgs(["--local", "--remote", "--env", "production"]), /not both/);
  assert.deepEqual(parseArgs(["--remote", "--env", "production"]).target, { kind: "remote", env: "production" });
  assert.equal(parseArgs(["--reset-password"]).resetPassword, true);
});

test("parseArgs rejects credentials on argv and unsafe env names", () => {
  assert.throws(() => parseArgs(["--password", "hunter2hunter2"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--remote", "--env", "prod;rm"]), /letters, digits/);
});

test("readInput validates email and minimum password length", () => {
  const ok = "x".repeat(MIN_PASSWORD_LENGTH);
  assert.throws(() => readInput({}), /ADMIN_EMAIL is required/);
  assert.throws(() => readInput({ ADMIN_EMAIL: "nope", ADMIN_PASSWORD: ok }), /valid email/);
  assert.throws(() => readInput({ ADMIN_EMAIL: "a@b.co" }), /ADMIN_PASSWORD is required/);
  assert.throws(() => readInput({ ADMIN_EMAIL: "a@b.co", ADMIN_PASSWORD: ok.slice(1) }), /at least 12/);
  const input = readInput({ ADMIN_EMAIL: " A@B.co ", ADMIN_PASSWORD: ok });
  assert.equal(input.email, "a@b.co");
  assert.equal(input.name, "Decoded Editorial");
});

test("sqlString escapes quotes and rejects NUL", () => {
  assert.equal(sqlString("O'Brien"), "'O''Brien'");
  assert.equal(sqlString("'; DROP TABLE user; --"), "'''; DROP TABLE user; --'");
  assert.throws(() => sqlString("a\0b"), /NUL/);
});

test("buildAdminSql creates user + credential account with escaped literals", () => {
  const sql = buildAdminSql({ ...base, name: "O'Neil", email: "o'n@b.co" });
  assert.match(sql, /INSERT OR IGNORE INTO "user"/);
  assert.match(sql, /'O''Neil'/);
  assert.match(sql, /'o''n@b\.co'/);
  assert.match(sql, /'admin'/);
  assert.match(sql, /INSERT INTO "account"[\s\S]*'credential'/);
  assert.match(sql, /1700000000/);
});

test("buildAdminSql for an existing user promotes without touching the password", () => {
  const sql = buildAdminSql({ ...base, userExists: true });
  assert.match(sql, /UPDATE "user" SET "role" = 'admin'/);
  assert.doesNotMatch(sql, /"account"/);
  assert.doesNotMatch(sql, /salt:hash/);
});

test("buildAdminSql with reset updates the credential password", () => {
  const sql = buildAdminSql({ ...base, userExists: true, resetPassword: true });
  assert.match(sql, /UPDATE "account" SET "password" = 'salt:hash'/);
});

test("wranglerTargetArgs selects local persist dir or explicit remote env", () => {
  assert.deepEqual(wranglerTargetArgs({ kind: "local" }, "/tmp/x"), ["--local", "--persist-to", "/tmp/x"]);
  assert.deepEqual(wranglerTargetArgs({ kind: "remote", env: "production" }), ["--remote", "--env", "production"]);
});


// Public-repo regression: no remote target may provision the documented fixtures,
// even if the calling shell still contains localhost development configuration.
import {
  assertSafeAuthSecret,
  isLocalCredentialContext,
  hashAuthPassword,
  verifyAuthPassword,
} from "../src/lib/auth/credential-policy";
import { hashPassword } from "better-auth/crypto";

const fixturePasswords = [
  "admin-local-dev-password-2026!",
  "worker-e2e-fixture-password-2026!",
  "profile-admin-password-2026!",
  "profile-learner-password-2026!",
];

test("remote admin provisioning rejects every known fixture before D1 access", () => {
  for (const password of fixturePasswords) {
    for (const env of ["production", "cputest"]) {
      assert.throws(() => readInput({
        ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: password,
        BETTER_AUTH_URL: "http://localhost:3000",
      }, { kind: "remote", env }), /fixture passwords/);
    }
    assert.doesNotThrow(() => readInput({ ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: password }));
  }
});

test("production fixtures require configured loopback origins; conflicting or misleading origins fail closed", () => {
  assert.equal(isLocalCredentialContext({ NODE_ENV: "production" }), false);
  for (const origin of ["https://example.com", "http://localhost.example.com", "invalid", "https://user@localhost"]) {
    assert.equal(isLocalCredentialContext({ NODE_ENV: "production", BETTER_AUTH_URL: origin }), false);
  }
  assert.equal(isLocalCredentialContext({ NODE_ENV: "production", BETTER_AUTH_URL: "http://127.0.0.1:3107" }), true);
  assert.equal(isLocalCredentialContext({ NODE_ENV: "production", BETTER_AUTH_URL: "http://localhost", NEXT_PUBLIC_SITE_URL: "https://example.com" }), false);
});

test("hosted auth rejects fixture secrets", () => {
  for (const secret of ["your_32_char_minimum_secret_key_here", "test-only-not-a-real-secret-0123456789abcdef", "ci-only-not-a-real-secret-0123456789abcdef"]) {
    assert.throws(() => assertSafeAuthSecret(secret, { NODE_ENV: "production" }), /fixture auth secrets/);
    assert.doesNotThrow(() => assertSafeAuthSecret(secret, { NODE_ENV: "production", BETTER_AUTH_URL: "http://localhost:3107" }));
  }
});

test("auth hash/verify hooks reject hosted fixture signup and existing imported credentials", async () => {
  const saved = { BETTER_AUTH_URL: process.env.BETTER_AUTH_URL, NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL };
  try {
    process.env.BETTER_AUTH_URL = "https://deployment.example";
    process.env.NEXT_PUBLIC_SITE_URL = "https://deployment.example";
    for (const password of fixturePasswords) {
      const hash = await hashPassword(password);
      await assert.rejects(() => hashAuthPassword(password), /fixture passwords/);
      assert.equal(await verifyAuthPassword({ password, hash }), false);
    }
    const password = "unique-test-credential-for-roundtrip";
    const hash = await hashAuthPassword(password);
    assert.equal(await verifyAuthPassword({ password, hash }), true);
    assert.equal(await verifyAuthPassword({ password: "wrong", hash }), false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
