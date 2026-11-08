/**
 * npx tsx scripts/bench-slots.ts [--reference] [--iterations=100]
 * node --cpu-prof --cpu-prof-dir=/tmp/slots-profile --import tsx scripts/bench-slots.ts --reference
 * process.cpuUsage measures this Node process (including local D1 client work,
 * excluding the separate workerd process); it is not deployed Worker CPU.
 */
import "../tests/helpers/env";
import { strict as assert } from "node:assert";
import { disposeCloudflareBindings } from "@/lib/cloudflare/bindings";
import { migrateLocalDb } from "@/lib/db/migrate";
import { seedSlotsFixture } from "../tests/helpers/slots-fixture";
import { resolvePublicSchedulingModel } from "@/features/scheduling/public-scheduling";
import { resolvePublicSchedulingModel as referenceModel } from "../tests/helpers/slots-reference/public-scheduling";
import { generateCandidateSlots, iterateCandidateSlots } from "@/features/scheduling/availability";
import { generateCandidateSlots as referenceCandidates } from "../tests/helpers/slots-reference/availability";

async function measure(label: string, run: () => unknown, iterations: number) {
  for (let i = 0; i < 15; i++) await run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.cpuUsage();
    await run();
    const cpu = process.cpuUsage(start);
    samples.push((cpu.user + cpu.system) / 1000);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ label, iterations,
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1] }));
}

async function main() {
  const reference = process.argv.includes("--reference");
  const iterations = Number(process.argv.find((arg) => arg.startsWith("--iterations="))?.split("=")[1] ?? 100);
  assert.ok(Number.isInteger(iterations) && iterations > 0);
  try {
    await migrateLocalDb();
    const fixture = await seedSlotsFixture();
    const resolve = reference ? referenceModel : resolvePublicSchedulingModel;
    const generate = reference ? referenceCandidates : generateCandidateSlots;
    const model = await resolve(fixture.params);
    assert.ok(model.enabled && model.slots.length === 60);
    console.log(JSON.stringify({ implementation: reference ? "reference" : "optimized",
      requestedDays: 60, effectivePublicDays: 31, fullWindowCandidates: fixture.candidates.length,
      returnedSlots: model.slots.length }));
    await measure("resolvePublicSchedulingModel (31-day public cap)", () => resolve(fixture.params), iterations);
    await measure("generateCandidateSlots (full 60 days)", () => generate(fixture.candidateParams), iterations);
    if (!reference) await measure("iterateCandidateSlots (first 60 candidates, no DB/conflict filtering)", () => {
      let count = 0;
      for (const slot of iterateCandidateSlots(fixture.candidateParams)) {
        assert.ok(slot.slotKey);
        if (++count === 60) break;
      }
    }, iterations);
  } finally {
    await disposeCloudflareBindings();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
