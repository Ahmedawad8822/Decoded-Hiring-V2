import { spawn } from "node:child_process";

export type Command = readonly [string, readonly string[]];
export type CommandRunner = (command: Command, env?: NodeJS.ProcessEnv) => Promise<void>;

export const runCommand: CommandRunner = ([command, args], env = process.env) => new Promise((resolve, reject) => {
  const grouped = process.platform !== "win32";
  const child = spawn(command, [...args], { env, stdio: "inherit", detached: grouped });
  let cancelled: NodeJS.Signals | undefined;
  // Stop npm/npx descendants as well before callers remove their temporary state.
  const forward = (signal: NodeJS.Signals) => {
    cancelled = signal;
    try {
      if (grouped && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* child may have already exited */ }
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const cleanup = () => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  };
  child.once("error", () => { cleanup(); reject(new Error(`Could not start ${command}`)); });
  child.once("exit", (code, signal) => {
    cleanup();
    if (code === 0 && !signal && !cancelled) resolve();
    else reject(new Error(`${command} failed (${cancelled ?? signal ?? code ?? "unknown exit"})`));
  });
});
