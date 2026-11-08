// Workers Builds: local build prerequisites only. This file never deploys,
// contacts remote D1/R2, seeds accounts, or uses the runtime auth secret.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const origin = "https://dh-cputest.hdv2.workers.dev";
const env = {
  ...process.env,
  BETTER_AUTH_URL: origin,
  NEXT_PUBLIC_SITE_URL: origin,
  // Required by any auth access during prerendering; ephemeral, never shared
  // with the Worker. Set the real secret separately in Variables & Secrets.
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  NEXT_TELEMETRY_DISABLED: "1",
};

for (const [command, args] of [
  ["npm", ["run", "db:migrate:local"]],
  ["npx", ["opennextjs-cloudflare", "build", "--env", "cputest"]],
] as const) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
