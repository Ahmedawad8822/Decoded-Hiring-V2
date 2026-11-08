/**
 * DB INSTANCE REUSE: getDb() returns one Drizzle instance per D1 binding
 * (building one re-derives the relational config from the whole schema, which
 * dominated CPU on dynamic pages), and a different binding gets its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import type { D1Database } from "@cloudflare/workers-types";

import { getDb } from "../src/lib/db";
import {
  clearD1DatabaseForTest,
  disposeCloudflareBindings,
  getD1Database,
  setD1DatabaseForTest,
} from "../src/lib/cloudflare/bindings";

test.after(async () => {
  clearD1DatabaseForTest();
  await disposeCloudflareBindings();
});

test("getDb reuses one instance for the same D1 binding", async () => {
  const first = await getDb();
  const second = await getDb();
  assert.equal(first, second);
});

test("a different D1 binding gets its own instance that queries it", async () => {
  const real = await getD1Database();
  const before = await getDb();
  const queried: string[] = [];
  const wrapped = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          queried.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  setD1DatabaseForTest(wrapped);
  try {
    const after = await getDb();
    assert.notEqual(after, before);
    assert.equal(await getDb(), after);
    await after.run("SELECT 1");
    assert.ok(queried.length > 0, "queries go to the new binding");
  } finally {
    clearD1DatabaseForTest();
  }
  assert.equal(await getDb(), before);
});
