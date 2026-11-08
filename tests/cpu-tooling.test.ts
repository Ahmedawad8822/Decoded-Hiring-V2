import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCpuTail, summarize } from "../scripts/cpu-routes";

test("tail joins pretty Wrangler objects and normalized JSONL by probe, preserving absent CPU", () => {
  const event = (id: string) => ({ request: { headers: { "X-CPU-Probe": id, other: 'quoted "} [ text' } }, response: { status: 200 } });
  const text = "Connected to worker\n" + JSON.stringify({ outcome: "exceededCpu", event: event("first") }, null, 4) + "\n" +
    JSON.stringify({ outcome: "ok", cpuTime: 12, wallTime: 35, event: event("second") }) + "\n" +
    JSON.stringify({ outcome: "ok", CPUTimeMs: 0, event: event("third") }) + '\n{"partial":';
  const rows = parseCpuTail(text);
  assert.equal(rows.size, 3);
  assert.equal(rows.get("first")?.outcome, "exceededCpu");
  assert.equal(rows.get("first")?.cpuMs, undefined);
  assert.equal(rows.get("second")?.cpuMs, 12);
  assert.equal(rows.get("second")?.wallMs, 35);
  assert.equal(rows.get("third")?.cpuMs, 0);
  assert.equal(rows.get("third")?.status, 200);
});

test("tail ignores uncorrelated exports and invalid timings; accepts arrays", () => {
  const rows = parseCpuTail(JSON.stringify([
    { cpuTime: 99, event: { request: { url: "https://example.workers.dev/" } } },
    { cpuTime: -1, wallTime: "20", event: { request: { headers: { "x-cpu-probe": "p" } } } },
  ]));
  assert.equal(rows.size, 1);
  assert.equal(rows.get("p")?.cpuMs, undefined);
  assert.equal(rows.get("p")?.wallMs, undefined);
  assert.deepEqual(summarize([3, 1, 2, 100]), { n: 4, p50: 2, p95: 100, max: 100, mean: 26.5 });
});
