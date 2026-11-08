// Local-only Playwright webServer: seed -> build -> populate -> workerd.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { previewConfig, WORKER_ADMIN, WORKER_RUNTIME_GUIDE_SLUG, WORKER_RUNTIME_NOTE_SLUG, workerDevArgs, workerFixtureEntry, workerPaths, workerPort } from "./worker-e2e-setup";

const root = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "dh-worker-e2e-"));
const { state, persist } = workerPaths(work);
const port = workerPort();
const origin = `http://127.0.0.1:${port}`;
const fixtureEnv = {
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  BETTER_AUTH_URL: origin,
  NEXT_PUBLIC_SITE_URL: origin,
  ADMIN_REQUIRE_2FA: "false",
  WORKER_E2E_CONTROL: "local-fixture",
};
Object.assign(process.env, fixtureEnv, {
  DH_LOCAL_STATE_DIR: state,
  ADMIN_INITIAL_EMAIL: WORKER_ADMIN.email,
  ADMIN_INITIAL_PASSWORD: WORKER_ADMIN.password,
  ADMIN_INITIAL_NAME: "Worker E2E Admin",
  WRANGLER_SEND_METRICS: "false",
  NEXT_TELEMETRY_DISABLED: "1",
  XDG_CONFIG_HOME: path.join(work, "config"),
  WRANGLER_LOG_PATH: path.join(work, "logs"),
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
});

let child: ChildProcess | undefined;
let cleanupPromise: Promise<void> | undefined;
function cleanup(): Promise<void> {
  // Duplicate termination signals must await the same cleanup, rather than
  // letting a second handler exit while the first one is still stopping workerd.
  return cleanupPromise ??= stopAndRemove();
}
async function stopAndRemove() {
  const proc = child;
  if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    try { process.kill(-proc.pid, "SIGTERM"); } catch { /* already gone */ }
    const timer = setTimeout(() => {
      try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, 3000);
    await exited;
    clearTimeout(timer);
    // Reap any grandchildren even if the CLI parent exited first.
    try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log("[worker-e2e] Worker stopped; throwaway setup removed.");
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void cleanup().finally(() => process.exit(0)); });
}
async function run(bin: string, args: string[], cwd = root) {
  const proc = spawn(path.join(root, "node_modules/.bin", bin), args, {
    cwd, env: process.env, stdio: "inherit", detached: true,
  });
  child = proc;
  try {
    await new Promise<void>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code ?? signal}`)));
    });
  } finally { if (child === proc) child = undefined; }
}

async function main() {
  if (process.env.CF_PAGES || process.env.CLOUDFLARE === "1") throw new Error("Worker E2E is local-only");
  console.log(`[worker-e2e] Throwaway state: ${state}`);
  const config = previewConfig(fs.readFileSync(path.join(root, "wrangler.preview.jsonc"), "utf8"), root);
  // Compile fixture controls only into a temporary local Worker entry. The
  // production entry and build artifacts never import these controls.
  config.main = path.join(work, "worker-fixture.ts");
  fs.writeFileSync(config.main, workerFixtureEntry(root));
  const configPath = path.join(work, "wrangler.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(path.join(work, ".dev.vars"), Object.entries(fixtureEnv).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  // npm exec inside OpenNext's populateCache must resolve the installed CLI
  // from the disposable cwd, rather than downloading anything.
  fs.symlinkSync(path.join(root, "node_modules"), path.join(work, "node_modules"), "dir");
  await run("tsx", ["scripts/e2e-bootstrap.ts"]);
  await run("tsx", ["scripts/seed.ts"]); // published baseline guide for Link/RSC tests
  // Explicit local-only A/B diagnostic. Never alter the deployment config.
  const interceptionOff = process.env.WORKER_E2E_INTERCEPTION_OFF === "1";
  const originalR2 = process.env.WORKER_E2E_ORIGINAL_R2 === "1";
  const writeDelay = Number(process.env.WORKER_E2E_CACHE_WRITE_DELAY_MS ?? "0");
  if (!Number.isSafeInteger(writeDelay) || writeDelay < 0 || writeDelay > 5000) {
    throw new Error("WORKER_E2E_CACHE_WRITE_DELAY_MS must be an integer from 0 to 5000");
  }
  const buildArgs = ["build"];
  if (interceptionOff || writeDelay || originalR2) {
    const override = path.join(work, "open-next.config.ts");
    fs.writeFileSync(override, `
import config from ${JSON.stringify(path.join(root, "open-next.config.ts"))};
import originalR2 from ${JSON.stringify(path.join(root, "node_modules/@opennextjs/cloudflare/dist/api/overrides/incremental-cache/r2-incremental-cache.js"))};
// Local fault injection: make a pre-mutation render finish its R2 upload after
// the action invalidates it, as in the coordinator's browser prefetch trace.
for (const target of [config.default, config.middleware]) {
  const resolve = ${originalR2} ? () => originalR2 : target.override.incrementalCache;
  target.override.incrementalCache = async () => {
    const cache = typeof resolve === "function" ? await resolve() : resolve;
    return { name: cache.name, get: cache.get.bind(cache), delete: cache.delete.bind(cache),
      async set(...args) {
        await new Promise(resolve => setTimeout(resolve, ${writeDelay}));
        return cache.set(...args);
      }
    };
  };
}
export default { ...config, dangerous: { ...config.dangerous, enableCacheInterception: ${!interceptionOff} } };
`);
    buildArgs.push("--openNextConfigPath", override);
  }
  await run("opennextjs-cloudflare", buildArgs);
  // Diverge deployed D1 from the build snapshot without any path invalidation.
  // The first sitemap GET must discover this article, not build-local content.
  await run("tsx", ["-e", `
    import { createGuide, publishGuide } from "./src/features/guides/service";
    import { createFieldNote, publishFieldNote } from "./src/features/field-notes/service";
    import { disposeCloudflareBindings } from "./src/lib/cloudflare/bindings";
    (async () => {
      try {
        const guide = await createGuide({ title: "Runtime sitemap fixture", slug: ${JSON.stringify(WORKER_RUNTIME_GUIDE_SLUG)}, author: "Worker fixture", body: [] });
        await publishGuide(guide.id);
        const note = await createFieldNote({ title: "Runtime ISR note", slug: ${JSON.stringify(WORKER_RUNTIME_NOTE_SLUG)}, body: [] });
        await publishFieldNote(note.id);
      } finally { await disposeCloudflareBindings(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `]);

  // Reuse the pinned adapter's exact cache asset keys and tag-table schema.
  // Its local cache population has no --persist-to support, so change cwd to
  // the disposable directory; both it and dev now use the same state parent.
  const { retrieveCompiledConfig, getNormalizedOptions } = await import("../node_modules/@opennextjs/cloudflare/dist/cli/commands/utils/utils.js");
  const { populateCache } = await import("../node_modules/@opennextjs/cloudflare/dist/cli/commands/populate-cache.js");
  const compiled = await retrieveCompiledConfig();
  const options = getNormalizedOptions(compiled.config);
  if (!compiled.config.dangerous?.enableCacheInterception && !interceptionOff) throw new Error("Built Worker must enable cache interception");
  const queue = compiled.config.default.override?.queue;
  const resolvedQueue = typeof queue === "function" ? await queue() : queue;
  if (typeof resolvedQueue !== "object" || resolvedQueue?.name !== "durable-queue") {
    throw new Error("Worker E2E must exercise the production Durable Object queue");
  }
  console.log(`[worker-e2e] Cache interception: ${compiled.config.dangerous?.enableCacheInterception}`);
  process.chdir(work);
  // The adapter types every Cloudflare binding as required here; population
  // only reads optional cache prefixes (unset in this isolated setup).
  await populateCache(options, compiled.config, config, {
    target: "local", wranglerConfigPath: configPath, shouldUsePreviewId: false,
  }, {} as Parameters<typeof populateCache>[4]);
  await run("wrangler", workerDevArgs(configPath, persist, port), work);
}
main().catch((error) => {
  if (!cleanupPromise) {
    console.error(error);
    process.exitCode = 1;
  }
}).finally(cleanup);
