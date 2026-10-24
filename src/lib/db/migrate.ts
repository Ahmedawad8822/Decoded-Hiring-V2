import { getD1Database } from "../cloudflare/bindings";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * SQL error codes/names that are GENUINELY IDEMPOTENT and safe to tolerate
 * when BASELINING a legacy local database (see migrateLocalDb):
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
 * Tracking table. Name and shape deliberately match what
 * `wrangler d1 migrations apply` creates (wrangler's DEFAULT_MIGRATION_TABLE
 * and getCreateMigrationsTableQuery), with `name` = the .sql file name, so the
 * local runner and wrangler (local or remote) agree on what is applied.
 */
const MIGRATIONS_TABLE = "d1_migrations";
const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

/**
 * Apply drizzle/*.sql migrations to the local/test D1 (Miniflare) database,
 * recording each applied file in `d1_migrations` exactly like wrangler does.
 *
 * Only files not yet recorded are applied, in sorted order, and each is
 * recorded after it succeeds. Data migrations and DROP+CREATE sequences
 * therefore never re-run.
 *
 * BASELINE for legacy local DBs (created by the old runner, which re-ran every
 * file and kept no record): when the tracking table is empty but the database
 * already has user tables, each unrecorded file is applied once with the
 * tolerant "already exists"/"duplicate column" handling, then recorded. This
 * also covers legacy DBs that are only partially migrated. A brand-new DB
 * (no user tables) and every later run apply strictly.
 *
 * Any non-idempotent error aborts the remaining migrations and throws. There
 * is deliberately no warn-and-continue path: the caller's `test.before` hook
 * (and `npm run db:*` scripts) must see the failure instead of quietly running
 * against a partially-migrated schema.
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

  await d1.prepare(CREATE_MIGRATIONS_TABLE).run();
  const applied = new Set(
    (await d1.prepare(`SELECT name FROM "${MIGRATIONS_TABLE}"`).all<{ name: string }>())
      .results.map((r) => r.name),
  );

  let tolerant = false;
  if (applied.size === 0) {
    const existing = await d1
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) != '_cf_' AND name != ?`,
      )
      .bind(MIGRATIONS_TABLE)
      .first<{ n: number }>();
    tolerant = (existing?.n ?? 0) > 0;
  }

  for (const file of files) {
    if (applied.has(file)) continue;
    const fullPath = path.join(migrationsDir, file);
    const sqlContent = fs.readFileSync(fullPath, "utf-8");
    // Split on statement-breakpoint. A pure-comment chunk (SQL comment lines
    // only, e.g. the "custom SQL migration" template drizzle-kit writes for
    // an intentionally empty checkpoint migration) carries no statement, so
    // it is dropped instead of being sent to D1 (D1 rejects a statement-less
    // batch with "SQL code did not contain a statement"). Real statements —
    // including a custom migration that pairs comments with real SQL — are
    // unaffected.
    const isCommentOnly = (chunk: string) =>
      chunk
        .split("\n")
        .map((line) => line.trim())
        .every((line) => line === "" || line.startsWith("--"));
    const statements = sqlContent
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !isCommentOnly(s));

    for (const statement of statements) {
      try {
        await d1.prepare(statement).run();
      } catch (err: unknown) {
        const error = err as Error;
        if (tolerant && isExpectedIdempotentError(error.message)) {
          continue;
        }
        // FAIL LOUDLY — e.g. CREATE UNIQUE INDEX failures must never be
        // silently ignored: the DB would be missing a required constraint.
        throw new Error(
          `[D1 Migration Failure in ${file}]: ${error.message ?? String(err)} — statement: ${statement.slice(0, 200)}`
        );
      }
    }
    await d1.prepare(`INSERT INTO "${MIGRATIONS_TABLE}" (name) VALUES (?)`).bind(file).run();
  }
}
