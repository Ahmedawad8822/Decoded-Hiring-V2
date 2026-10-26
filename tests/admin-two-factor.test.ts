/**
 * G3: admin TOTP two-factor. Enforcement on/off, gate exemptions, the full
 * enroll -> verify -> sign-in-challenge flow against the real Better Auth
 * instance on the isolated D1, and the 2FA rate limits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import { isRedirectError } from "next/dist/client/components/redirect-error";
import { eq } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import {
  ADMIN_SECURITY_PATH,
  checkAdmin,
  checkAdminPage,
  getAuth,
  isAdmin2faRequired,
} from "../src/lib/auth";
import { buildAuthRateLimitOptions, AUTH_STRICT_LIMIT } from "../src/lib/auth/rate-limit";
import { getDb, twoFactors, users } from "../src/lib/db";
import { isAppError } from "../src/lib/errors";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";

const EMAIL = "twofa-admin@example.test";
const PASSWORD = "twofa-admin-password-2026!";
const ORIGIN = "http://localhost:3000";

type Sess = Parameters<typeof checkAdmin>[0];
const asSession = (u: Record<string, unknown>) => ({ user: u, session: {} }) as unknown as Sess;

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

function post(path: string, body: unknown, cookie?: string) {
  return new Request(`${ORIGIN}/api/auth/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("isAdmin2faRequired: enforced unless exactly 'false'", () => {
  const saved = process.env.ADMIN_REQUIRE_2FA;
  try {
    delete process.env.ADMIN_REQUIRE_2FA;
    assert.equal(isAdmin2faRequired(), true);
    process.env.ADMIN_REQUIRE_2FA = "";
    assert.equal(isAdmin2faRequired(), true);
    process.env.ADMIN_REQUIRE_2FA = "0";
    assert.equal(isAdmin2faRequired(), true);
    process.env.ADMIN_REQUIRE_2FA = "false";
    assert.equal(isAdmin2faRequired(), false);
  } finally {
    if (saved === undefined) delete process.env.ADMIN_REQUIRE_2FA;
    else process.env.ADMIN_REQUIRE_2FA = saved;
  }
});

test("gates: admin without 2FA is redirected / rejected when enforced, exempt on the security surface, free when off", () => {
  const saved = process.env.ADMIN_REQUIRE_2FA;
  const noTfa = asSession({ id: "a", role: "admin", twoFactorEnabled: false });
  const withTfa = asSession({ id: "b", role: "admin", twoFactorEnabled: true });
  const nonAdmin = asSession({ id: "c", role: "user", twoFactorEnabled: true });
  try {
    delete process.env.ADMIN_REQUIRE_2FA; // default = enforced

    assert.throws(
      () => checkAdminPage(noTfa),
      (err: unknown) => {
        assert.ok(isRedirectError(err));
        assert.ok((err as { digest: string }).digest.includes(`;${ADMIN_SECURITY_PATH};`));
        return true;
      }
    );
    assert.throws(
      () => checkAdmin(noTfa),
      (err: unknown) => isAppError(err) && err.kind === "forbidden" && /two-factor/i.test(err.message)
    );

    // Security page + its actions are exempt.
    assert.equal(checkAdminPage(noTfa, { allowWithout2fa: true }), noTfa);
    assert.equal(checkAdmin(noTfa, { allowWithout2fa: true }), noTfa);

    // Enrolled admin passes; the role checks still run first.
    assert.equal(checkAdminPage(withTfa), withTfa);
    assert.equal(checkAdmin(withTfa), withTfa);
    assert.throws(() => checkAdmin(nonAdmin), (e: unknown) => isAppError(e) && /Admin access/.test(e.message));
    assert.throws(() => checkAdmin(null), (e: unknown) => isAppError(e) && e.kind === "unauthorized");
    assert.throws(
      () => checkAdminPage(nonAdmin),
      (e: unknown) => isRedirectError(e) && (e as { digest: string }).digest.includes("error=forbidden")
    );

    // Off: no enforcement.
    process.env.ADMIN_REQUIRE_2FA = "false";
    assert.equal(checkAdminPage(noTfa), noTfa);
    assert.equal(checkAdmin(noTfa), noTfa);
  } finally {
    if (saved === undefined) delete process.env.ADMIN_REQUIRE_2FA;
    else process.env.ADMIN_REQUIRE_2FA = saved;
  }
});

test("enroll, verify a TOTP from the stored secret, then sign-in returns the 2FA challenge", async () => {
  const auth = await getAuth();
  const db = await getDb();

  const created = await auth.api.signUpEmail({
    body: { email: EMAIL, password: PASSWORD, name: "2FA Admin" },
  });
  await db.update(users).set({ role: "admin" }).where(eq(users.id, created.user.id));

  // Plain sign-in: no 2FA yet, so a session cookie comes back.
  const signIn = await auth.handler(post("sign-in/email", { email: EMAIL, password: PASSWORD }));
  assert.equal(signIn.status, 200);
  let cookie = cookieHeader(signIn);

  // Enable: wrong password is refused, right password returns URI + backup codes.
  const bad = await auth.handler(post("two-factor/enable", { password: "nope", method: "totp" }, cookie));
  assert.equal(bad.status, 400);
  const enable = await auth.handler(
    post("two-factor/enable", { password: PASSWORD, method: "totp", issuer: "Decoded Hiring" }, cookie)
  );
  assert.equal(enable.status, 200);
  const enabled = (await enable.json()) as { totpURI: string; backupCodes: string[] };
  assert.match(enabled.totpURI, /^otpauth:\/\/totp\//);
  assert.match(enabled.totpURI, /Decoded(%20|\+)Hiring/);
  assert.ok(enabled.backupCodes.length >= 8);

  // Not enabled until a code is verified.
  let [row] = await db.select().from(users).where(eq(users.id, created.user.id));
  assert.notEqual(row.twoFactorEnabled, true);

  // Generate a code from the STORED (encrypted) secret and verify it.
  const [tf] = await db.select().from(twoFactors).where(eq(twoFactors.userId, created.user.id));
  assert.ok(tf.secret && !tf.secret.includes("otpauth"), "secret is stored encrypted, not plain");
  const secret = await symmetricDecrypt({ key: process.env.BETTER_AUTH_SECRET!, data: tf.secret });
  const code = await createOTP(secret, { digits: 6, period: 30 }).totp();

  const wrong = await auth.handler(
    post("two-factor/verify-totp", { code: code === "000000" ? "111111" : "000000" }, cookie)
  );
  assert.equal(wrong.status, 401);
  const verify = await auth.handler(post("two-factor/verify-totp", { code }, cookie));
  assert.equal(verify.status, 200);
  cookie = cookieHeader(verify) || cookie;

  [row] = await db.select().from(users).where(eq(users.id, created.user.id));
  assert.equal(row.twoFactorEnabled, true);

  // The gate now sees an enrolled admin.
  assert.equal(checkAdmin(asSession({ role: "admin", twoFactorEnabled: row.twoFactorEnabled })).user.role, "admin");

  // A fresh password sign-in is now a challenge with no session cookie.
  const challenge = await auth.handler(post("sign-in/email", { email: EMAIL, password: PASSWORD }));
  assert.equal(challenge.status, 200);
  const body = (await challenge.json()) as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
  assert.equal(body.twoFactorRedirect, true);
  assert.deepEqual(body.twoFactorMethods, ["totp"]);
  const challengeCookies = cookieHeader(challenge);
  assert.doesNotMatch(challengeCookies, /session_token=[^;]+/);

  // Completing the challenge with a backup code yields a real session.
  const backup = await auth.handler(
    post("two-factor/verify-backup-code", { code: enabled.backupCodes[0] }, challengeCookies)
  );
  assert.equal(backup.status, 200);
  assert.match(cookieHeader(backup), /session_token=/);

  // Backup codes are single-use.
  const again = await auth.handler(post("sign-in/email", { email: EMAIL, password: PASSWORD }));
  const reuse = await auth.handler(
    post("two-factor/verify-backup-code", { code: enabled.backupCodes[0] }, cookieHeader(again))
  );
  assert.notEqual(reuse.status, 200);
});

test("rate limits cover the 2FA verify endpoints at the sign-in strict limit", () => {
  const rules = buildAuthRateLimitOptions().customRules;
  for (const p of ["/two-factor/verify-*", "/two-factor/enable", "/two-factor/disable"]) {
    assert.deepEqual(rules[p], { window: AUTH_STRICT_LIMIT.window, max: AUTH_STRICT_LIMIT.max }, p);
  }
  assert.equal(AUTH_STRICT_LIMIT.max, 5);
});
