/**
 * Diagnose SQLITE_MISMATCH on knowledge_chunks INSERT.
 */
import "../tests/helpers/env";
import { getD1Database } from "../src/lib/cloudflare/bindings";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { getDb, knowledge_sources, knowledge_chunks } from "../src/lib/db";
import { uploadKnowledgeSource } from "../src/features/editorial-ai/knowledge/storage";

async function main() {
  await migrateLocalDb();
  const db = await getDb();
  const d1 = await getD1Database();

  // Upload a source
  const content = "## Test Heading\n\nThis is the first paragraph with enough content.";
  const buffer = new TextEncoder().encode(content).buffer;
  const result = await uploadKnowledgeSource({
    buffer,
    filename: "test.md",
    contentType: "text/markdown",
    title: "Mismatch Test",
    createdBy: "test-admin",
  });
  console.log("Source ID:", result.id);

  // Try 1: Disable FK and insert with literal SQL
  console.log("\n--- Try 1: PRAGMA foreign_keys=OFF + literal SQL ---");
  try {
    await d1.prepare("PRAGMA foreign_keys = OFF").all();
    const res = await d1.prepare(
      `INSERT INTO knowledge_chunks (id, source_id, ordinal, heading, content, content_hash, character_count, created_at) VALUES ('tc1', '${result.id}', 0, 'H', 'C', 'hc', 10, 1234567890)`
    ).all();
    console.log("Try 1 result:", JSON.stringify(res));
  } catch (e) {
    console.error("Try 1 error:", (e as Error).message);
  } finally {
    await d1.prepare("PRAGMA foreign_keys = ON").all();
  }

  // Try 2: Insert with all string params
  console.log("\n--- Try 2: All-string params ---");
  try {
    const res = await d1.prepare(
      `INSERT INTO knowledge_chunks (id, source_id, ordinal, heading, content, content_hash, character_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind("tc2", result.id, "0", "H", "C", "hc", "10", "1234567890").all();
    console.log("Try 2 result:", JSON.stringify(res));
  } catch (e) {
    console.error("Try 2 error:", (e as Error).message);
  }

  // Try 3: Insert with only minimal columns
  console.log("\n--- Try 3: Minimal columns (id, source_id, ordinal, content, content_hash, character_count, created_at) ---");
  try {
    const res = await d1.prepare(
      `INSERT INTO knowledge_chunks (id, source_id, ordinal, content, content_hash, character_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind("tc3", result.id, 0, "C", "hc", 0, 1234567890).all();
    console.log("Try 3 result:", JSON.stringify(res));
  } catch (e) {
    console.error("Try 3 error:", (e as Error).message);
  }

  // Try 4: Insert with only id, source_id, content
  console.log("\n--- Try 4: Only id, source_id, content (plus defaults) ---");
  try {
    const res = await d1.prepare(
      `INSERT INTO knowledge_chunks (id, source_id, ordinal, content, content_hash, character_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind("tc4", result.id, 0, "C", "hc", 0, Math.floor(Date.now()/1000)).all();
    console.log("Try 4 result:", JSON.stringify(res));
  } catch (e) {
    console.error("Try 4 error:", (e as Error).message);
  }

  // Try 5: Check column types via PRAGMA
  console.log("\n--- Try 5: Check column types ---");
  const colTypes = await d1.prepare("SELECT typeof(ordinal), typeof(content_hash), typeof(character_count), typeof(created_at) FROM knowledge_chunks LIMIT 1").all();
  console.log("Column types (empty table, will fail):", JSON.stringify(colTypes));

  // Try 6: Query sqlite_master for the table definition
  console.log("\n--- Try 6: sqlite_master ---");
  const tableDef = await d1.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_chunks'").all();
  console.log("Table def:", JSON.stringify(tableDef, null, 2));

  // Cleanup
  await db.delete(knowledge_chunks);
  await db.delete(knowledge_sources);
}

main().catch(console.error);
