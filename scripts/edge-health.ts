/** Read-only Analytics query. Credentials are captured in memory and never logged. */
import { spawnSync } from "node:child_process";
import { buildEnvironment, parseEnvironment, readWranglerSource, type BuildEnvironment } from "./deployment-config";

export const HEALTH_QUERY = `query EdgeHealth($account: string!, $worker: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: {accountTag: $account}) {
      workersInvocationsAdaptive(limit: 1000, filter: {
        scriptName: $worker, datetime_geq: $start, datetime_lt: $end
      }) {
        dimensions { status }
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 cpuTimeP999 }
        max { cpuTime }
      }
      durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: {
        scriptName: $worker, datetime_geq: $start, datetime_lt: $end
      }) {
        dimensions { status }
        sum { requests errors }
      }
    }
  }
}`;

export type HealthOptions = { account: string; worker: string; hours: number; environment: BuildEnvironment };
export function parseHealthArgs(args: string[], env: Record<string, string | undefined> = process.env,
  source = readWranglerSource()): HealthOptions {
  let account = env.CLOUDFLARE_ACCOUNT_ID;
  let worker: string | undefined;
  let environment: BuildEnvironment = "production";
  let hours = 24;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!["--account", "--worker", "--env", "--hours"].includes(arg) || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error("Usage: edge-health.ts [--env production|cputest] [--worker name] [--hours N] [--account id]");
    }
    const value = args[++i];
    if (arg === "--account") account = value;
    else if (arg === "--worker") worker = value;
    else if (arg === "--env") environment = buildEnvironment(value);
    else hours = Number(value);
  }
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error("Set CLOUDFLARE_ACCOUNT_ID or --account to a 32-character account ID");
  if (!Number.isFinite(hours) || hours <= 0 || hours > 31 * 24) throw new Error("--hours must be greater than 0 and at most 744 (31 days); account retention limits may be shorter");
  const name = worker ?? parseEnvironment(source, environment).name;
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Worker name is missing or invalid");
  return { account, worker: name, hours, environment };
}

export function readAnalyticsToken(env: Record<string, string | undefined> = process.env): string {
  if (env.CLOUDFLARE_API_TOKEN?.trim()) return env.CLOUDFLARE_API_TOKEN.trim();
  // JSON suppresses the Wrangler banner; neither stdout nor stderr is forwarded.
  const result = spawnSync("npx", ["wrangler", "auth", "token", "--json"], {
    env: { ...process.env, ...env, WRANGLER_SEND_METRICS: "false" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  if (!result.error && result.status === 0) {
    try {
      const value = JSON.parse(result.stdout);
      if ((value.type === "oauth" || value.type === "api_token") && typeof value.token === "string" && value.token.trim()) return value.token.trim();
    } catch { /* never echo credential output */ }
  }
  throw new Error("No analytics token available; set CLOUDFLARE_API_TOKEN with Account Analytics Read permission or authenticate Wrangler");
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed analytics response");
  return value as RecordValue;
}
function metric(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Missing or invalid analytics metric");
  return value;
}
export type HealthRow = { status: string; requests: number; errors: number; cpuMs?: { p50: number; p99: number; p999: number; max: number } };
export type HealthReport = { workers: HealthRow[]; durableObjects: HealthRow[]; failed: boolean };

export function parseHealthResponse(payload: unknown): HealthReport {
  const root = object(payload);
  if (root.errors != null && (!Array.isArray(root.errors) || root.errors.length)) throw new Error("Cloudflare GraphQL returned errors; check Analytics permission, schema and time-window limits");
  const accounts = object(object(root.data).viewer).accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error("Expected one analytics account; check account access");
  const account = object(accounts[0]);
  function rows(value: unknown, cpu: boolean): HealthRow[] {
    if (!Array.isArray(value) || value.length >= 1000) throw new Error("Missing or possibly truncated analytics dataset");
    const statuses = new Set<string>();
    return value.map((entry) => {
      const row = object(entry);
      const status = object(row.dimensions).status;
      // Only status is requested as a dimension: never average subgroup percentiles.
      if (typeof status !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(status) || statuses.has(status)) throw new Error("Invalid or duplicate status group in analytics response");
      statuses.add(status);
      const sum = object(row.sum);
      const result: HealthRow = { status, requests: metric(sum.requests), errors: metric(sum.errors) };
      if (cpu) {
        const q = object(row.quantiles);
        result.cpuMs = { p50: metric(q.cpuTimeP50) / 1000, p99: metric(q.cpuTimeP99) / 1000,
          p999: metric(q.cpuTimeP999) / 1000, max: metric(object(row.max).cpuTime) / 1000 };
      }
      return result;
    }).sort((a, b) => a.status.localeCompare(b.status));
  }
  const workers = rows(account.workersInvocationsAdaptive, true);
  const durableObjects = rows(account.durableObjectsInvocationsAdaptiveGroups, false);
  const failed = !workers.some((row) => row.requests > 0) || [...workers, ...durableObjects].some((row) => row.status !== "success" || row.errors > 0);
  return { workers, durableObjects, failed };
}

export async function queryEdgeHealth(options: HealthOptions, token: string, get: typeof fetch = fetch,
  now = new Date()): Promise<HealthReport> {
  let response: Response;
  try {
    response = await get("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: HEALTH_QUERY, variables: { account: options.account, worker: options.worker,
        start: new Date(now.getTime() - options.hours * 3_600_000).toISOString(), end: now.toISOString() } }),
    });
  } catch { throw new Error("Cloudflare analytics request failed (network/timeout)"); }
  if (!response.ok) throw new Error(`Cloudflare analytics HTTP ${response.status}`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("Cloudflare analytics returned invalid JSON"); }
  return parseHealthResponse(payload);
}

export function formatHealth(report: HealthReport, options: HealthOptions): string {
  const lines = [`Edge health: ${options.worker}, last ${options.hours} hours (CPU in ms)`];
  for (const [name, rows] of [["Worker", report.workers], ["Durable Objects", report.durableObjects]] as const) {
    if (!rows.length) lines.push(`${name}: no invocations returned`);
    for (const row of rows) {
      const cpu = row.cpuMs;
      lines.push(`${name} ${row.status}: requests=${row.requests}, errors=${row.errors}` + (cpu ?
        `, CPU p50=${cpu.p50.toFixed(3)} ms p99=${cpu.p99.toFixed(3)} ms p999=${cpu.p999.toFixed(3)} ms max=${cpu.max.toFixed(3)} ms` : ""));
    }
  }
  lines.push(report.failed ? "FAIL: non-success status, errors, or no Worker traffic; investigate before claiming edge health." : "OK: success statuses only, zero errors in this sampled window.");
  return lines.join("\n");
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseHealthArgs(args);
  const report = await queryEdgeHealth(options, readAnalyticsToken());
  console.log(formatHealth(report, options));
  if (report.failed) process.exitCode = 1;
}

if (/edge-health\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("Edge health failed:", error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  });
}
