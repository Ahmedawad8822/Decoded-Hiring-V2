import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import { getD1Database } from "../cloudflare/bindings";
import * as schema from "./schema";

// drizzle() re-derives the relational config from the whole schema on every
// call, which was the top CPU cost of dynamic pages on Workers. Reuse one
// instance per D1 binding object; a new binding (new test DB, new isolate)
// gets a fresh instance.
const instances = new WeakMap<D1Database, ReturnType<typeof createDb>>();

function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export async function getDb() {
  const d1 = await getD1Database();
  let db = instances.get(d1);
  if (!db) {
    db = createDb(d1);
    instances.set(d1, db);
  }
  return db;
}

export type Database = Awaited<ReturnType<typeof getDb>>;
export * from "./schema";
