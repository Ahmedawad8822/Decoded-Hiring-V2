import { drizzle } from "drizzle-orm/d1";
import { getD1Database } from "../cloudflare/bindings";
import * as schema from "./schema";

export async function getDb() {
  const d1 = await getD1Database();
  return drizzle(d1, { schema });
}

export type Database = Awaited<ReturnType<typeof getDb>>;
export * from "./schema";
