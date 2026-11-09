import "./helpers/env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEnv, parseBuildArgs } from "../scripts/build-env";
import { environmentOrigin, httpsOrigin, readWranglerSource } from "../scripts/deployment-config";
import { deploymentBlockers, deployProduction, hasAuthSecret, productionSteps } from "../scripts/deploy-production";
import type { Command, CommandRunner } from "../scripts/run-command";

const source = `{
  // Origin strings must survive JSONC parsing.
  "env": {
    "production": {"vars": {"BETTER_AUTH_URL": "https://production.example", "NEXT_PUBLIC_SITE_URL": "https://production.example/",},},
    "cputest": {"vars": {"BETTER_AUTH_URL": "https://test.example", "NEXT_PUBLIC_SITE_URL": "https://test.example"}},
  },
}`;
const clean = { status: "", head: "revision-a", originMain: "revision-a" };

test("JSONC origins select only the requested environment and require both vars to match", () => {
  assert.equal(environmentOrigin(source, "production"), "https://production.example");
  assert.equal(environmentOrigin(source, "cputest"), "https://test.example");
  for (const environment of ["production", "cputest"] as const) {
    assert.ok(environmentOrigin(readWranglerSource(), environment).startsWith("https://"));
  }
  for (const invalid of ["{", "{}", '{"env":{"production":{}}}', source.replace('"https://production.example/"', '"https://other.example"')]) {
    assert.throws(() => environmentOrigin(invalid, "production"));
  }
  assert.throws(() => environmentOrigin('{"env": process.exit()}', "production"));
});

test("deployment origins reject placeholders, non-HTTPS and non-origin URLs", () => {
  for (const value of [undefined, null, 123, "", "<PROD_SITE_URL>", "https://<host>", "http://example.com", "ftp://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?q=1", "https://example.com/#x", " https://example.com", "https:example.com"]) {
    assert.throws(() => httpsOrigin(value));
  }
});

test("build CLI accepts explicit supported environments only", () => {
  assert.equal(parseBuildArgs(["--env", "production"]), "production");
  assert.equal(parseBuildArgs(["--env", "cputest"]), "cputest");
  for (const args of [[], ["--env"], ["--env", "preview"], ["--env", "production", "--skipNextBuild"]]) assert.throws(() => parseBuildArgs(args));
});

test("each environment build uses fresh empty state, overrides inherited state/secret, and cleans up", async () => {
  const states: string[] = [];
  const secrets: string[] = [];
  for (const environment of ["cputest", "production"] as const) {
    const calls: Command[] = [];
    await buildEnv(environment, async (command, env) => {
      assert.ok(env?.DH_LOCAL_STATE_DIR);
      const state = env.DH_LOCAL_STATE_DIR;
      assert.notEqual(state, process.env.DH_LOCAL_STATE_DIR);
      assert.equal(env.BETTER_AUTH_URL, environmentOrigin(source, environment));
      assert.equal(env.NEXT_PUBLIC_SITE_URL, env.BETTER_AUTH_URL);
      assert.notEqual(env.BETTER_AUTH_SECRET, process.env.BETTER_AUTH_SECRET);
      assert.equal(env.SKIP_NEXT_APP_BUILD, "false");
      if (!calls.length) {
        assert.deepEqual(readdirSync(state), []);
        states.push(state);
        secrets.push(env.BETTER_AUTH_SECRET!);
        writeFileSync(join(state, "migration-marker"), "fixture");
      } else {
        assert.equal(state, states.at(-1));
        assert.ok(existsSync(join(state, "migration-marker")));
      }
      calls.push(command);
    }, source);
    assert.deepEqual(calls, [["npm", ["run", "db:migrate:local"]], ["npx", ["opennextjs-cloudflare", "build", "--env", environment]]]);
    assert.equal(existsSync(states.at(-1)!), false);
  }
  assert.equal(new Set(states).size, 2);
  assert.equal(new Set(secrets).size, 2);
});

test("failed migration/build stops the pipeline and removes disposable state", async () => {
  for (const failure of [1, 2]) {
    let state = "";
    let calls = 0;
    await assert.rejects(buildEnv("production", async (_, env) => {
      state = env!.DH_LOCAL_STATE_DIR!;
      if (++calls === failure) throw new Error("fixture failure");
    }, source), /fixture failure/);
    assert.equal(calls, failure);
    assert.equal(existsSync(state), false);
  }
});

test("guard rejects tracked/untracked dirt, divergent/ahead/behind HEAD and unresolved main", () => {
  assert.deepEqual(deploymentBlockers(clean), []);
  for (const status of [" M package.json", "?? extra.txt", "M  staged.ts"]) assert.match(deploymentBlockers({ ...clean, status }).join(), /dirty/);
  assert.match(deploymentBlockers({ ...clean, head: "other" }).join(), /HEAD does not equal/);
  assert.match(deploymentBlockers({ ...clean, originMain: "" }).join(), /could not be resolved/);
});

test("dirty deploy runs no commands; refreshed remote mismatch/fetch failure stops before preflight", async () => {
  const calls: Command[] = [];
  const run: CommandRunner = async (command) => { calls.push(command); };
  await assert.rejects(deployProduction([], { source, run, state: () => ({ ...clean, status: "?? fixture" }) }), /dirty/);
  assert.equal(calls.length, 0);
  let reads = 0;
  await assert.rejects(deployProduction([], { source, run, state: () => ++reads === 1 ? clean : { ...clean, originMain: "new-main" } }), /HEAD does not equal/);
  assert.deepEqual(calls, [["git", ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]]]);
  await assert.rejects(deployProduction([], { source, state: () => clean, run: async () => { throw new Error("fetch failed"); } }), /fetch failed/);
});

const secrets = () => JSON.stringify([{ name: "BETTER_AUTH_SECRET", type: "secret_text" }]);

test("deploy refuses when the production auth secret is missing", async () => {
  const calls: Command[] = [];
  await assert.rejects(deployProduction([], { source, secrets: () => "[]", state: () => clean, run: async (command) => { calls.push(command); } }), /BETTER_AUTH_SECRET/);
  assert.equal(calls.length, 1, "only the read-only fetch may run before the secret check");
  assert.equal(hasAuthSecret("not json"), false);
});

test("approved clean main executes fetch, preflight, production migrations/build/deploy, then explicit prewarm", async () => {
  const calls: Command[] = [];
  await deployProduction([], { source, secrets, state: () => clean, run: async (command) => { calls.push(command); } });
  assert.equal(calls[0][0], "git");
  assert.deepEqual(calls.slice(1), productionSteps("https://production.example"));
  // A migration/build/deploy/preflight failure must prevent every subsequent command.
  for (let stop = 2; stop <= 5; stop++) {
    let count = 0;
    await assert.rejects(deployProduction([], { source, secrets, state: () => clean, run: async () => {
      if (++count === stop) throw new Error("step failed");
    } }), /step failed/);
    assert.equal(count, stop);
  }
});

test("dry run prints all steps/blockers and executes nothing even with a dirty divergent tree", async () => {
  const lines: string[] = [];
  await deployProduction(["--dry-run"], { source, state: () => ({ ...clean, status: "dirty", head: "other" }),
    log: (line) => lines.push(line), run: async () => { assert.fail("dry run executed a command"); } });
  assert.match(lines.join("\n"), /dirty/);
  assert.match(lines.join("\n"), /HEAD does not equal/);
  assert.equal(lines.filter((line) => line.startsWith("Would run:")).length, 6);
  await assert.rejects(deployProduction(["--force"], { source }), /Usage/);
});
