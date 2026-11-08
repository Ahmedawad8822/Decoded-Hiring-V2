import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { previewConfig, workerDevArgs, workerFixtureEntry, workerPaths, workerPort } from "../scripts/worker-e2e-setup";

test("preview keeps binding identities and self-reference, but isolates state and secrets", () => {
  const source = fs.readFileSync("wrangler.preview.jsonc", "utf8");
  const config = previewConfig(source, "/project with spaces");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dh-worker-setup-test-"));
  try {
    const { persist, state } = workerPaths(work);
    assert.equal(state, path.join(persist, "v3"));
    assert.ok(persist.startsWith(work + path.sep));
    assert.equal(config.main, "/project with spaces/worker.ts");
    assert.equal(config.assets.directory, "/project with spaces/.open-next/assets");
    const db = config.d1_databases.find((d: { binding: string }) => d.binding === "DB");
    const tags = config.d1_databases.find((d: { binding: string }) => d.binding === "NEXT_TAG_CACHE_D1");
    assert.equal(db.database_id, tags.database_id);
    assert.equal(db.migrations_dir, undefined);
    assert.equal(config.services[0].service, config.name);
    assert.deepEqual(config.durable_objects.bindings, [
      { name: "NEXT_CACHE_DO_QUEUE", class_name: "DOQueueHandler" },
    ]);
    const local = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
    assert.deepEqual(config.migrations, local.env.production.migrations);
    assert.deepEqual(config.durable_objects, local.env.production.durable_objects);
    assert.equal(local.services, undefined, "getPlatformProxy has no self-reference implementation");
    assert.equal(local.durable_objects, undefined, "getPlatformProxy has no internal DO implementation");
    assert.equal(local.migrations, undefined, "getPlatformProxy must not emulate migrated DO classes either");
    assert.equal(local.main, "worker.ts");
    assert.equal(local.env.production.services[0].service, local.env.production.name);
    const fixture = workerFixtureEntry("/project with spaces");
    assert.ok(fixture.includes('export { DOQueueHandler }'));
    assert.ok(fixture.includes("worker-e2e-control.ts"));
    assert.ok(!fs.readFileSync("worker.ts", "utf8").includes("worker-e2e-control"));
    assert.equal(config.vars, undefined);
    assert.equal(config.env, undefined);
    const args = workerDevArgs(path.join(work, "wrangler.json"), persist, workerPort("3151"));
    assert.equal(args[0], "dev");
    assert.ok(args.includes("--local"));
    assert.equal(args[args.indexOf("--persist-to") + 1], persist);
    assert.equal(args[args.indexOf("--ip") + 1], "127.0.0.1");
    assert.ok(!args.some((s) => /--remote|deploy|login|secret|tail/.test(s)));
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test("Worker setup rejects remote bindings and invalid ports", () => {
  for (const group of ["d1_databases", "r2_buckets", "services"]) {
    assert.throws(() => previewConfig(JSON.stringify({ [group]: [{ remote: true }] }), "/repo"), /remote bindings/);
  }
  for (const value of ["0", "3000.5", "65536", "NaN", "3000 --remote"]) {
    assert.throws(() => workerPort(value), /E2E_WORKER_PORT/);
  }
});
