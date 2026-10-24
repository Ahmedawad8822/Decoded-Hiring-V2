/**
 * AUTH RATE LIMIT: Better Auth's sensitive endpoints are throttled per client
 * IP through the durable D1 fixed-window primitive (not in-memory state).
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import { getAuth } from "../src/lib/auth";
import { getDb, publicRateLimits } from "../src/lib/db";
import { AUTH_STRICT_LIMIT } from "../src/lib/auth/rate-limit";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";

test.before(async () => {
  // The shared bootstrap disables the limiter for other suites; enable it here.
  delete process.env.DH_AUTH_RATE_LIMIT_DISABLED;
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

function authRequest(path: string, ip: string, body: unknown) {
  return new Request(`http://localhost:3000/api/auth/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "cf-connecting-ip": ip,
    },
    body: JSON.stringify(body),
  });
}

const signInBody = {
  email: "nobody@example.test",
  password: "wrong-password-123",
};

test("sign-in: N allowed then 429 per IP, other IPs unaffected, durable across instances", async () => {
  const max = AUTH_STRICT_LIMIT.max;

  // A fresh getAuth() per request: in-memory state could not carry over.
  for (let i = 0; i < max; i++) {
    const auth = await getAuth();
    const res = await auth.handler(
      authRequest("sign-in/email", "203.0.113.10", signInBody),
    );
    assert.notEqual(res.status, 429, `request ${i + 1} must not be limited`);
  }

  const blocked = await (await getAuth()).handler(
    authRequest("sign-in/email", "203.0.113.10", signInBody),
  );
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("X-Retry-After")) >= 1);
  const body = (await blocked.json()) as { message?: string };
  assert.match(body.message ?? "", /too many requests/i);

  const other = await (await getAuth()).handler(
    authRequest("sign-in/email", "203.0.113.11", signInBody),
  );
  assert.notEqual(other.status, 429);
});

test("sign-up and password reset are throttled too", async () => {
  for (const path of ["sign-up/email", "request-password-reset"]) {
    let last = 0;
    for (let i = 0; i <= AUTH_STRICT_LIMIT.max; i++) {
      const res = await (await getAuth()).handler(
        authRequest(path, "203.0.113.20", {}),
      );
      last = res.status;
    }
    assert.equal(last, 429, path);
  }
});

test("session reads are not throttled and write nothing", async () => {
  const db = await getDb();
  const before = (await db.select().from(publicRateLimits)).length;
  for (let i = 0; i < 3; i++) {
    const res = await (await getAuth()).handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { origin: "http://localhost:3000", "cf-connecting-ip": "203.0.113.30" },
      }),
    );
    assert.notEqual(res.status, 429);
  }
  const after = (await db.select().from(publicRateLimits)).length;
  assert.equal(after, before, "get-session must not consume a D1 rate-limit write");
});
