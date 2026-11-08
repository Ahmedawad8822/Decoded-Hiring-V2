import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import config from "../open-next.config";
import { renderStartedAt } from "../src/lib/cloudflare/render-clock";
import { withRenderStart } from "../src/lib/cloudflare/render-context";

test("both OpenNext routing and server overrides use the real DO queue", async () => {
  for (const target of [config.default, config.middleware]) {
    const queue = target && "override" in target ? target.override?.queue : undefined;
    assert.equal(typeof queue, "function");
    const resolved = typeof queue === "function" ? await queue() : queue;
    assert.equal(typeof resolved === "object" ? resolved.name : resolved, "durable-queue");
  }
  assert.equal(config.dangerous?.enableCacheInterception, true);
});

test("render start stays local to concurrent requests and survives asynchronous work", async () => {
  assert.equal(renderStartedAt(), undefined);
  await Promise.all([100, 200].map(start => withRenderStart(async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(renderStartedAt(), start - 1);
  }, () => start)));
  assert.equal(renderStartedAt(), undefined);
});

test("every queue migration uses the Free-compatible SQLite class", () => {
  for (const file of ["wrangler.jsonc", "wrangler.preview.jsonc"]) {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, ""));
    assert.deepEqual((cfg.env?.production ?? cfg).migrations, [{ tag: "isr-queue-v1", new_sqlite_classes: ["DOQueueHandler"] }]);
  }
});
