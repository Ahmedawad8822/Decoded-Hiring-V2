// ============================================================================
// E2E BOOTSTRAP — remediation F (deterministic E2E foundation)
// ----------------------------------------------------------------------------
// Runs BEFORE the Playwright suite (wired into `test:e2e`). Guarantees the
// Mission 06 lifecycle prerequisites exist or FAILS LOUDLY:
//   1. local D1 migrations applied (fail-loud migrateLocalDb)
//   2. admin account seeded from ADMIN_INITIAL_EMAIL/PASSWORD
//   3. Mission 06 demo course seeded (mission-01-demo curriculum)
//
// The E2E suite must never silently skip the central lifecycle test because
// credentials were missing: if this script cannot produce the prerequisites,
// `npm run test:e2e` fails with a clear error instead of passing 7/8.
//
// Local-only: refuses hosted environments. No production resources touched.
// ============================================================================

import { getDb, users } from "../src/lib/db";
import { getAuth } from "../src/lib/auth";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { eq } from "drizzle-orm";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";

function loadEnvLocal() {
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      // .env.local absent — handled by the fail-loud check below
    }
  }
}

async function main() {
  if (process.env.CF_PAGES || process.env.CLOUDFLARE === "1") {
    throw new Error("e2e-bootstrap is local-only and refuses to run in a hosted environment.");
  }

  loadEnvLocal();

  const adminEmail = process.env.ADMIN_INITIAL_EMAIL;
  const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;

  if (!adminEmail || !adminPassword) {
    throw new Error(
      "E2E PREREQUISITE MISSING: ADMIN_INITIAL_EMAIL and ADMIN_INITIAL_PASSWORD must be set in .env.local (or the environment) before running npm run test:e2e. The lifecycle suite requires an admin account and will not silently skip."
    );
  }

  console.log("🧪 e2e-bootstrap: applying local D1 migrations...");
  await migrateLocalDb();

  const db = await getDb();
  const auth = await getAuth();

  const existingUser = await db.select().from(users).where(eq(users.email, adminEmail)).get();
  if (!existingUser) {
    console.log(`🧪 e2e-bootstrap: creating admin account (${adminEmail})...`);
    const newUser = await auth.api.signUpEmail({
      body: { email: adminEmail, password: adminPassword, name: process.env.ADMIN_INITIAL_NAME || "Decoded Editorial" },
    });
    if (newUser?.user?.id) {
      await db.update(users).set({ role: "admin" }).where(eq(users.id, newUser.user.id));
      console.log("🧪 e2e-bootstrap: admin role granted.");
    } else {
      throw new Error("e2e-bootstrap: admin sign-up returned no user id.");
    }
  } else {
    if (existingUser.role !== "admin") {
      await db.update(users).set({ role: "admin" }).where(eq(users.id, existingUser.id));
    }
    console.log("🧪 e2e-bootstrap: admin account already present.");
  }

  console.log("🧪 e2e-bootstrap: seeding Mission 06 demo course (idempotent)...");
  const { seedMission06Demo } = await import("./seed-mission-06");

  await seedMission06Demo();

  console.log("🧪 e2e-bootstrap: seeding Mission 08 public scheduling fixture...");
  const { seedMission08E2E } = await import("./seed-mission-08-e2e");
  await seedMission08E2E();

  console.log("✅ e2e-bootstrap complete: prerequisites guaranteed.");
  await disposeCloudflareBindings();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("❌ e2e-bootstrap FAILED:", err instanceof Error ? err.message : err);
  try {
    await disposeCloudflareBindings();
  } catch {
    // ignore
  }
  process.exit(1);
});
