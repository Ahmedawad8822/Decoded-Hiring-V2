// Build prerequisites only: no deployment, remote data access, seeding or runtime secret.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvironment, environmentOrigin, readWranglerSource, type BuildEnvironment } from "./deployment-config";
import { runCommand, type CommandRunner } from "./run-command";

export function parseBuildArgs(args: string[]): BuildEnvironment {
  if (args.length !== 2 || args[0] !== "--env") throw new Error("Usage: build-env.ts --env <cputest|production>");
  return buildEnvironment(args[1]);
}

export async function buildEnv(environment: BuildEnvironment, run: CommandRunner = runCommand,
  source = readWranglerSource()): Promise<void> {
  const origin = environmentOrigin(source, environment);
  const state = mkdtempSync(join(tmpdir(), "dh-build-"));
  const env = {
    ...process.env,
    BETTER_AUTH_URL: origin,
    NEXT_PUBLIC_SITE_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    DH_LOCAL_STATE_DIR: state,
    WRANGLER_REGISTRY_PATH: join(state, "registry"),
    WRANGLER_LOG_PATH: join(state, "logs"),
    WRANGLER_SEND_METRICS: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    // Never reuse Next output produced from a developer's populated database.
    SKIP_NEXT_APP_BUILD: "false",
  };
  try {
    await run(["npm", ["run", "db:migrate:local"]], env);
    await run(["npx", ["opennextjs-cloudflare", "build", "--env", environment]], env);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

if (/build-env\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  Promise.resolve().then(() => buildEnv(parseBuildArgs(process.argv.slice(2)))).catch((error) => {
    console.error("Environment build failed:", error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  });
}
