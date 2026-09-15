import { getD1Database } from "../cloudflare/bindings";
import * as fs from "node:fs";
import * as path from "node:path";

export async function migrateLocalDb() {
  const d1 = await getD1Database();
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  
  if (!fs.existsSync(migrationsDir)) {
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sqlContent = fs.readFileSync(fullPath, "utf-8");
    // Split on statement-breakpoint
    const statements = sqlContent
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      try {
        await d1.prepare(statement).run();
      } catch (err: unknown) {
        const error = err as Error;
        // Ignore "table already exists" or "index already exists"
        if (
          !error.message?.includes("already exists") &&
          !error.message?.includes("duplicate column name")
        ) {
          console.warn(`[D1 Migration Warning in ${file}]:`, error.message);
        }
      }
    }
  }
}
