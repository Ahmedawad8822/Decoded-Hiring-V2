import { execFileSync } from "node:child_process";
import { environmentOrigin, readWranglerSource } from "./deployment-config";
import { runCommand, type Command, type CommandRunner } from "./run-command";

export type GitState = { status: string; head: string; originMain: string };

export function deploymentBlockers(state: GitState): string[] {
  const blockers: string[] = [];
  if (state.status.trim()) blockers.push("Git tree is dirty (including untracked files); deploy requires a clean tree.");
  if (!state.head.trim() || !state.originMain.trim()) blockers.push("HEAD or origin/main could not be resolved.");
  else if (state.head.trim() !== state.originMain.trim()) blockers.push("HEAD does not equal origin/main; deploy requires the fetched main revision.");
  return blockers;
}

function git(...args: string[]): string {
  try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error(`Git check failed: git ${args.join(" ")}`); }
}

function gitState(): GitState {
  let originMain = "";
  try { originMain = git("rev-parse", "--verify", "refs/remotes/origin/main"); } catch { /* reported by guard */ }
  return { status: git("status", "--porcelain", "--untracked-files=all"), head: git("rev-parse", "HEAD"), originMain };
}

export function hasAuthSecret(secretListJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(secretListJson);
    return Array.isArray(parsed) && parsed.some((entry) => (entry as { name?: unknown })?.name === "BETTER_AUTH_SECRET");
  } catch { return false; }
}

function productionSecretList(): string {
  // Lists secret NAMES only; values are never returned by the API.
  try { return execFileSync("npx", ["wrangler", "secret", "list", "--env", "production"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch { return ""; }
}

export function productionSteps(origin: string): Command[] {
  return [
    ["npx", ["tsx", "scripts/prewarm.ts", "--check", "--base-url", origin]],
    ["npm", ["run", "db:migrate:remote"]],
    ["npx", ["tsx", "scripts/build-env.ts", "--env", "production"]],
    ["npx", ["opennextjs-cloudflare", "deploy", "--env", "production"]],
    ["npx", ["tsx", "scripts/prewarm.ts", "--base-url", origin]],
  ];
}

export async function deployProduction(args: string[], deps: {
  run?: CommandRunner; state?: () => GitState; source?: string; log?: (message: string) => void;
  secrets?: () => string;
} = {}): Promise<void> {
  if (args.length && (args.length !== 1 || args[0] !== "--dry-run")) throw new Error("Usage: deploy-production.ts [--dry-run]");
  const dryRun = args[0] === "--dry-run";
  const run = deps.run ?? runCommand;
  const log = deps.log ?? console.log;
  const origin = environmentOrigin(deps.source ?? readWranglerSource(), "production");
  const steps = productionSteps(origin);
  const fetchMain: Command = ["git", ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]];
  const state = deps.state ?? gitState;
  if (dryRun) {
    log("DRY RUN: no fetch, build, prewarm requests or remote commands will run.");
    log(`Would run: ${fetchMain[0]} ${fetchMain[1].join(" ")}`);
    log("Would require a clean git tree and HEAD equal to freshly fetched origin/main.");
    log("Would require BETTER_AUTH_SECRET to exist on the production Worker.");
    for (const blocker of deploymentBlockers(state())) log(`Current local blocker (origin/main not refreshed): ${blocker}`);
    for (const [command, flags] of steps) log(`Would run: ${command} ${flags.join(" ")}`);
    return;
  }
  // Fail before network access on local modifications; refresh main before comparing.
  if (state().status.trim()) throw new Error("Production deploy refused: git tree is dirty (including untracked files).");
  await run(fetchMain);
  const blockers = deploymentBlockers(state());
  if (blockers.length) throw new Error(`Production deploy refused:\n${blockers.join("\n")}`);
  if (!hasAuthSecret((deps.secrets ?? productionSecretList)())) {
    throw new Error("Production deploy refused: BETTER_AUTH_SECRET is not set on the production Worker (wrangler secret put BETTER_AUTH_SECRET --env production).");
  }
  for (const step of steps) await run(step);
}

if (/deploy-production\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  deployProduction(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "Production deploy failed");
    process.exitCode = 1;
  });
}
