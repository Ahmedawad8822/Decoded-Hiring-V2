/**
 * Enforces an uncompressed size budget on the OpenNext Worker.
 *
 * Runs `wrangler deploy --dry-run` (no Cloudflare credentials needed) against
 * the top-level wrangler.jsonc and parses its
 * "Total Upload: X KiB / gzip: Y KiB" line. Run `npm run cf:build` first.
 *
 * Env: WORKER_UNCOMPRESSED_BUDGET_KIB (default 20480; Workers limit is 65536).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIMIT_KIB = 64 * 1024; // Workers Free and Paid: 64 MiB uncompressed
const WARN_KIB = LIMIT_KIB * 0.9;
const DEFAULT_BUDGET_KIB = 20480;

const budgetRaw = process.env.WORKER_UNCOMPRESSED_BUDGET_KIB;
const budget = budgetRaw ? Number(budgetRaw) : DEFAULT_BUDGET_KIB;
if (!Number.isFinite(budget) || budget <= 0) {
  console.error(`Invalid WORKER_UNCOMPRESSED_BUDGET_KIB: "${budgetRaw}"`);
  process.exit(2);
}

const outdir = mkdtempSync(join(tmpdir(), "worker-size-"));
const res = spawnSync(
  "npx",
  ["wrangler", "deploy", "--dry-run", "--outdir", outdir],
  { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
rmSync(outdir, { recursive: true, force: true });

const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
const match = output.match(
  /Total Upload:\s*([\d.,]+)\s*(KiB|MiB)\s*\/\s*gzip:\s*([\d.,]+)\s*(KiB|MiB)/i,
);
if (res.status !== 0 || !match) {
  console.error(output);
  console.error(
    res.status !== 0
      ? "wrangler deploy --dry-run failed (did you run `npm run cf:build`?)"
      : 'Could not find "Total Upload: ... / gzip: ..." in wrangler output (format changed?)',
  );
  process.exit(2);
}

const toKiB = (v: string, unit: string) =>
  Number(v.replace(/,/g, "")) * (unit.toLowerCase() === "mib" ? 1024 : 1);
const totalKiB = toKiB(match[1], match[2]);
const gzipKiB = toKiB(match[3], match[4]);

const pct = (totalKiB / LIMIT_KIB) * 100;
const ok = totalKiB <= budget;
console.log(
  `Worker size: ${totalKiB.toFixed(2)} KiB uncompressed (${pct.toFixed(1)}% of ${LIMIT_KIB} KiB Free/Paid limit), budget ${budget} KiB, gzip ${gzipKiB.toFixed(2)} KiB (informational only) - ${ok ? "OK" : "OVER BUDGET"}`,
);

if (totalKiB > WARN_KIB) {
  console.warn(
    `::warning::Worker is above 90% of the ${LIMIT_KIB} KiB uncompressed Workers Free/Paid limit (${totalKiB.toFixed(2)} KiB).`,
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Worker size\n\n| uncompressed total upload | budget (uncompressed) | Free/Paid limit (uncompressed) | gzip (info only) |\n|---|---|---|---|\n| ${totalKiB.toFixed(2)} KiB | ${budget} KiB | ${LIMIT_KIB} KiB | ${gzipKiB.toFixed(2)} KiB |\n\n${ok ? "Within budget." : "**Over budget.**"}\n`,
  );
}

process.exit(ok ? 0 : 1);
