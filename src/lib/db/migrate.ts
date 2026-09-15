import { getD1Database } from "../cloudflare/bindings";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * SQL error codes/names that are GENUINELY IDEMPOTENT and safe to tolerate
 * on re-run against an already-migrated local/test database:
 *  - "table X already exists"    (SQLite: table X already exists / #1)
 *  - "index X already exists"    (SQLite: index X already exists)
 *  - "duplicate column name"     (SQLite: duplicate column name: X)
 *
 * Anything else — including a failed CREATE UNIQUE INDEX — is a required
 * schema guarantee that was NOT applied. Swallowing it would leave the
 * local/test DB silently missing constraints (e.g. the (user_id, course_id)
 * enrollment uniqueness backstop) while every read/write path believes the
 * schema is intact. Mission 06 rule: migration failure must FAIL LOUDLY.
 */
function isExpectedIdempotentError(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("already exists") ||
    m.includes("duplicate column name")
  );
}

/**
 * Apply drizzle/*.sql migrations to the local/test D1 (Miniflare) database.
 *
 * Expected-idempotent errors are tolerated; ANY other error aborts the
 * remaining migrations and throws. There is deliberately no warn-and-continue
 * path: the caller's `test.before` hook (and `npm run db:*` scripts) must see
 * the failure instead of quietly running against a partially-migrated schema.
 */
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
        if (isExpectedIdempotentError(error.message)) {
          continue;
        }
        // FAIL LOUDLY — e.g. CREATE UNIQUE INDEX failures must never be
        // silently ignored: the DB would be missing a required constraint.
        throw new Error(
          `[D1 Migration Failure in ${file}]: ${error.message ?? String(err)} — statement: ${statement.slice(0, 200)}`
        );
      }
    }
  }
}
