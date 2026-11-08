import path from "node:path";

// Public, local fixture credentials, never a developer or hosted account.
export const WORKER_ADMIN = {
  email: "admin@worker-e2e.local",
  password: "worker-e2e-fixture-password-2026!",
};

export const WORKER_RUNTIME_GUIDE_SLUG = "worker-runtime-only-sitemap-guide";
export const WORKER_RUNTIME_NOTE_SLUG = "worker-runtime-isr-note";

export function workerFixtureEntry(root: string) {
  // Only the disposable config points here. Production always uses worker.ts.
  return `
import handler from ${JSON.stringify(path.join(root, "worker.ts"))};
export { DOQueueHandler } from ${JSON.stringify(path.join(root, "worker.ts"))};
import { fixtureControl, recordRevalidation } from ${JSON.stringify(path.join(root, "scripts/worker-e2e-control.ts"))};
export default {
  async fetch(request, env, ctx) {
    const control = await fixtureControl(request, env);
    if (control) return control;
    recordRevalidation(request);
    return handler.fetch(request, env, ctx);
  }
};
`;
}

export function workerPort(value = process.env.E2E_WORKER_PORT ?? "3107") {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("E2E_WORKER_PORT must be an integer between 1024 and 65535");
  }
  return port;
}

export function workerPaths(work: string) {
  // populateCache's local workers default to <cwd>/.wrangler/state; Wrangler
  // adds v3, while the app's getPlatformProxy persist.path already includes it.
  const persist = path.join(work, ".wrangler/state");
  return { persist, state: path.join(persist, "v3") };
}

export function previewConfig(source: string, root: string) {
  // The checked-in preview JSONC uses full-line comments only.
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  delete config.$schema;
  // Fail closed if the shared preview configuration ever gains remote bindings.
  for (const group of [config.d1_databases, config.r2_buckets, config.services, config.durable_objects?.bindings]) {
    for (const binding of group ?? []) {
      if (binding.remote) throw new Error("Worker E2E refuses remote bindings");
    }
  }
  delete config.env;
  delete config.vars;
  config.main = path.join(root, "worker.ts");
  config.assets.directory = path.join(root, ".open-next/assets");
  for (const db of config.d1_databases) delete db.migrations_dir;
  return config;
}

export function workerDevArgs(config: string, persist: string, port: number) {
  return ["dev", "--local", "--config", config, "--persist-to", persist,
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0",
    "--show-interactive-dev-session=false"];
}
