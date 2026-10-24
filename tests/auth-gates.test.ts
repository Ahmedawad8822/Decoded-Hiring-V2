/**
 * AUTH GATES: fail-closed secret, request-cached auth outside a request,
 * and the shared admin page gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import { isRedirectError } from "next/dist/client/components/redirect-error";
import {
  getAuth,
  getServerSession,
  requireAdminPage,
  resolveAuthSecret,
} from "../src/lib/auth";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("resolveAuthSecret fails closed when BETTER_AUTH_SECRET is missing", () => {
  const saved = process.env.BETTER_AUTH_SECRET;
  try {
    delete process.env.BETTER_AUTH_SECRET;
    assert.throws(() => resolveAuthSecret(), /BETTER_AUTH_SECRET/);
    process.env.BETTER_AUTH_SECRET = "";
    assert.throws(() => resolveAuthSecret(), /BETTER_AUTH_SECRET/);
  } finally {
    process.env.BETTER_AUTH_SECRET = saved;
  }
  assert.equal(resolveAuthSecret(), saved);
});

test("getAuth and getServerSession work outside a request", async () => {
  const auth = await getAuth();
  assert.ok(auth && typeof auth.api.getSession === "function");
  assert.equal(await getServerSession(), null);
  assert.equal(await getServerSession(), null);
});

test("requireAdminPage redirects anonymous callers to /admin/login", async () => {
  await assert.rejects(
    () => requireAdminPage(),
    (err: unknown) => {
      assert.ok(isRedirectError(err), "expected a Next redirect error");
      assert.match(
        (err as { digest: string }).digest,
        /^NEXT_REDIRECT;[a-z]+;\/admin\/login;/
      );
      assert.doesNotMatch((err as { digest: string }).digest, /error=forbidden/);
      return true;
    }
  );
});
