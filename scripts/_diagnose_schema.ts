/**
 * Quick diagnostic: check the knowledge_chunks table structure in D1.
 */
import "../tests/helpers/env";
import { getD1Database } from "../src/lib/cloudflare/bindings";
import { migrateLocalDb } from "../src/lib/db/migrate";

async function main() {
  await migrateLocalDb();
  const db = await getD1Database();

  // Check table structure
  const schemaInfo = await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge_chunks'").all();
  console.log("knowledge_chunks schema:", JSON.stringify(schemaInfo, null, 2));

  // Check columns
  const cols = await db.prepare("PRAGMA table_info(knowledge_chunks)").all();
  console.log("knowledge_chunks columns:", JSON.stringify(cols, null, 2));
}

main().catch(console.error);
