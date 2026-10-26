// ============================================================================
// CREATE ADMIN (`npm run admin:create`)
// ----------------------------------------------------------------------------
// Creates (or promotes) ONE admin user in a target D1 without running the app.
// Use it for the first production admin (Docs/Engineering/DEPLOYMENT.md step 6).
//
// Inputs come from the ENVIRONMENT ONLY, never argv, so the password does not
// land in shell history:
//   ADMIN_EMAIL     required
//   ADMIN_PASSWORD  required, >= 12 characters
//   ADMIN_NAME      optional (default "Decoded Editorial")
//
// Flags:
//   --local                     default; local Miniflare state (honours DH_LOCAL_STATE_DIR)
//   --remote --env <name>       remote D1; --env is mandatory with --remote
//   --reset-password            also overwrite the password of an existing user
//
// The rows mirror what Better Auth's email/password sign-up writes: a `user`
// row (role 'admin', email_verified 0 = requireEmailVerification is off) and an
// `account` row (provider 'credential', account_id = user id, password = the
// hash from Better Auth's own `hashPassword`). The password and its hash are
// never printed. Idempotent: an existing email is promoted and its password is
// left alone unless --reset-password is given.
// ============================================================================

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MIN_PASSWORD_LENGTH = 12;
export const DEFAULT_ADMIN_NAME = "Decoded Editorial";

export type Target = { kind: "local" } | { kind: "remote"; env: string };

export interface CliOptions {
  target: Target;
  resetPassword: boolean;
}

export interface AdminInput {
  email: string;
  password: string;
  name: string;
}

export function parseArgs(argv: string[]): CliOptions {
  let local = false;
  let remote = false;
  let env: string | undefined;
  let resetPassword = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local") local = true;
    else if (arg === "--remote") remote = true;
    else if (arg === "--reset-password") resetPassword = true;
    else if (arg === "--env") {
      env = argv[++i];
      if (!env || env.startsWith("--")) throw new Error("--env requires a value (for example: --env production).");
    } else if (arg.startsWith("--env=")) env = arg.slice("--env=".length);
    else throw new Error(`Unknown argument: ${arg}. Credentials are read from the environment, never from arguments.`);
  }

  if (local && remote) throw new Error("Choose either --local or --remote, not both.");
  if (remote) {
    if (!env) throw new Error("--remote requires an explicit --env <name> (for example: --remote --env production).");
    if (!/^[A-Za-z0-9_-]+$/.test(env)) throw new Error("--env must contain only letters, digits, '-' and '_'.");
    return { target: { kind: "remote", env }, resetPassword };
  }
  if (env) throw new Error("--env only applies together with --remote.");
  return { target: { kind: "local" }, resetPassword };
}

export function readInput(env: Record<string, string | undefined>): AdminInput {
  const email = (env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = env.ADMIN_PASSWORD ?? "";
  const name = (env.ADMIN_NAME ?? "").trim() || DEFAULT_ADMIN_NAME;

  if (!email) throw new Error("ADMIN_EMAIL is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("ADMIN_EMAIL is not a valid email address.");
  if (!password) throw new Error("ADMIN_PASSWORD is required.");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return { email, password, name };
}

/** Escape a value as a SQLite string literal. */
export function sqlString(value: string): string {
  if (value.includes("\0")) throw new Error("Values must not contain NUL characters.");
  return `'${value.replaceAll("'", "''")}'`;
}

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export interface BuildSqlParams {
  email: string;
  name: string;
  passwordHash: string;
  userId: string;
  accountId: string;
  /** Epoch SECONDS (drizzle `integer({ mode: "timestamp" })`). */
  nowSeconds: number;
  /** Whether a user with this email already exists. */
  userExists: boolean;
  resetPassword: boolean;
}

/**
 * Builds the statements for one run. Literals only (D1 `--file` has no
 * parameters), each escaped via sqlString. Re-running is safe: the user insert
 * is OR IGNORE on the unique email, and the credential account is only
 * inserted when none exists.
 */
export function buildAdminSql(p: BuildSqlParams): string {
  const email = sqlString(p.email);
  const now = String(Math.trunc(p.nowSeconds));
  const lines: string[] = [];

  const insertCredential =
    `INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "password", "created_at", "updated_at") ` +
    `SELECT ${sqlString(p.accountId)}, u."id", 'credential', u."id", ${sqlString(p.passwordHash)}, ${now}, ${now} ` +
    `FROM "user" u WHERE u."email" = ${email} ` +
    `AND NOT EXISTS (SELECT 1 FROM "account" a WHERE a."user_id" = u."id" AND a."provider_id" = 'credential');`;

  if (!p.userExists) {
    lines.push(
      `INSERT OR IGNORE INTO "user" ("id", "name", "email", "email_verified", "image", "created_at", "updated_at", "role", "banned") ` +
        `VALUES (${sqlString(p.userId)}, ${sqlString(p.name)}, ${email}, 0, NULL, ${now}, ${now}, 'admin', 0);`
    );
  }
  lines.push(`UPDATE "user" SET "role" = 'admin', "updated_at" = ${now} WHERE "email" = ${email};`);

  if (!p.userExists) {
    lines.push(insertCredential);
  } else if (p.resetPassword) {
    lines.push(
      `UPDATE "account" SET "password" = ${sqlString(p.passwordHash)}, "updated_at" = ${now} ` +
        `WHERE "provider_id" = 'credential' AND "user_id" = (SELECT "id" FROM "user" WHERE "email" = ${email});`
    );
    lines.push(insertCredential);
  }
  return lines.join("\n") + "\n";
}

/** Arguments selecting the D1 target for `wrangler d1 execute DB ...`. */
export function wranglerTargetArgs(target: Target, persistParent?: string): string[] {
  if (target.kind === "remote") return ["--remote", "--env", target.env];
  const args = ["--local"];
  if (persistParent) args.push("--persist-to", persistParent);
  return args;
}

// ---------------------------------------------------------------------------
// Runtime (not exercised by unit tests)
// ---------------------------------------------------------------------------

function runWrangler(args: string[]): string {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", "DB", ...args], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    // wrangler output may echo SQL; never forward lines that could carry the hash.
    const msg = (result.stderr || "")
      .split("\n")
      .filter((l) => !/INSERT|UPDATE|password/i.test(l))
      .join("\n")
      .trim();
    throw new Error(`wrangler d1 execute failed (exit ${result.status}).${msg ? `\n${msg}` : ""}`);
  }
  return result.stdout;
}

function queryJson<T>(target: Target, persistParent: string | undefined, sql: string): T[] {
  const out = runWrangler(["--command", sql, "--json", ...wranglerTargetArgs(target, persistParent)]);
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = readInput(process.env);
  const { hashPassword } = await import("better-auth/crypto");

  // Local: wrangler appends "v3" to --persist-to, while the app's
  // getPlatformProxy persist path IS the v3 directory. Bridge with a temp
  // parent holding a `v3` symlink to the same directory.
  let tmpParent: string | undefined;
  if (options.target.kind === "local") {
    const stateDir = path.resolve(process.env.DH_LOCAL_STATE_DIR || ".wrangler/state/v3");
    fs.mkdirSync(stateDir, { recursive: true });
    tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "dh-create-admin-state-"));
    fs.symlinkSync(stateDir, path.join(tmpParent, "v3"), "dir");
  }

  const sqlFile = path.join(os.tmpdir(), `dh-create-admin-${newId()}.sql`);
  try {
    const existing = queryJson<{ id: string }>(
      options.target,
      tmpParent,
      `SELECT "id" FROM "user" WHERE "email" = ${sqlString(input.email)}`
    );
    const userExists = existing.length > 0;
    const needsHash = !userExists || options.resetPassword;

    const sql = buildAdminSql({
      email: input.email,
      name: input.name,
      passwordHash: needsHash ? await hashPassword(input.password) : "",
      userId: newId(),
      accountId: newId(),
      nowSeconds: Math.floor(Date.now() / 1000),
      userExists,
      resetPassword: options.resetPassword,
    });
    fs.writeFileSync(sqlFile, sql, { mode: 0o600 });
    runWrangler(["--file", sqlFile, ...wranglerTargetArgs(options.target, tmpParent)]);

    const rows = queryJson<{ role: string; credential: number }>(
      options.target,
      tmpParent,
      `SELECT u."role" AS role, (SELECT COUNT(*) FROM "account" a WHERE a."user_id" = u."id" AND a."provider_id" = 'credential') AS credential ` +
        `FROM "user" u WHERE u."email" = ${sqlString(input.email)}`
    );
    if (rows[0]?.role !== "admin") throw new Error("Verification failed: the user is not an admin after the update.");

    const where = options.target.kind === "remote" ? `remote D1 (${options.target.env})` : "local D1";
    const action = !userExists
      ? "created"
      : options.resetPassword
        ? "promoted to admin, password reset"
        : "promoted to admin, password untouched";
    console.log(`✅ ${input.email}: ${action} on ${where}. role=admin, credential accounts=${rows[0].credential}.`);
    console.log("ℹ️  Two-factor auth: this admin must enroll TOTP 2FA at /admin/security on first login (required unless ADMIN_REQUIRE_2FA=false).");
  } finally {
    fs.rmSync(sqlFile, { force: true });
    if (tmpParent) fs.rmSync(tmpParent, { recursive: true, force: true });
  }
}

const invokedDirectly = /create-admin\.[cm]?[jt]s$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("❌ create-admin FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
