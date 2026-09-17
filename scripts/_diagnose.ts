import "../tests/helpers/env";
import { getD1Database } from "../src/lib/cloudflare/bindings";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";

async function main() {
  await migrateLocalDb();
  const d1 = await getD1Database();

  const mem = await d1.prepare("SELECT COUNT(*) as cnt FROM editorial_memory WHERE active = 1").all();
  console.log("Active memory items:", mem.results?.[0]?.cnt);

  const tables = await d1.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log("Tables:", (tables.results as Array<{ name: string }>)?.map((r) => r.name).join(", "));

  const fts = await d1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'").all();
  console.log("FTS tables:", (fts.results as Array<{ name: string }>)?.map((r) => r.name).join(", "));

  const triggers = await d1.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%chunks%'").all();
  console.log("Triggers:", (triggers.results as Array<{ name: string }>)?.map((r) => r.name).join(", "));

  await disposeCloudflareBindings();
  console.log("Migration verification complete.");
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
