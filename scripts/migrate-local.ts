// ============================================================================
// LOCAL D1 MIGRATIONS (`npm run db:migrate:local`)
// ----------------------------------------------------------------------------
// Applies drizzle/migrations to the local Miniflare D1 (fail-loud
// migrateLocalDb). `next build` prerenders /guides and /field-notes from the
// database, so a fresh checkout (CI included) must run this before building.
//
// Local-only: refuses hosted environments. No production resources touched.
// ============================================================================

import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";

async function main() {
  if (process.env.CF_PAGES || process.env.CLOUDFLARE === "1") {
    throw new Error("migrate-local is local-only and refuses to run in a hosted environment.");
  }
  await migrateLocalDb();
  console.log("✅ Local D1 migrations applied.");
  await disposeCloudflareBindings();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("❌ migrate-local FAILED:", err instanceof Error ? err.message : err);
  try {
    await disposeCloudflareBindings();
  } catch {
    // ignore
  }
  process.exit(1);
});
