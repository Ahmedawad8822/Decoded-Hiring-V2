import "./helpers/env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { formatHealth, parseHealthArgs, parseHealthResponse, queryEdgeHealth, readAnalyticsToken } from "../scripts/edge-health";

// Synthetic API-shaped fixtures, not a saved account response or additional edge evidence.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/edge-health-${name}.json`, import.meta.url), "utf8"));
const account = "0".repeat(32);
const source = '{"env":{"production":{"name":"production-fixture"},"cputest":{"name":"test-fixture"}}}';
const options = parseHealthArgs([], { CLOUDFLARE_ACCOUNT_ID: account }, source);

test("health defaults and explicit CLI values require an account without discovery", () => {
  assert.deepEqual(options, { account, worker: "production-fixture", hours: 24, environment: "production" });
  assert.equal(parseHealthArgs(["--account", account, "--env", "cputest"], {}, source).worker, "test-fixture");
  assert.equal(parseHealthArgs(["--account", account, "--worker", "override", "--hours", "1.5"], {}, source).hours, 1.5);
  assert.equal(parseHealthArgs(["--account", account, "--worker", "override"], {}, source).worker, "override");
  for (const args of [[], ["--account", "invalid"], ["--account", account, "--hours", "0"], ["--account", account, "--hours", "NaN"], ["--account", account, "--hours", "745"], ["--account", account, "--env", "local"], ["--account", account, "--worker"], ["--wat", "x"]]) {
    assert.throws(() => parseHealthArgs(args, {}, source));
  }
  assert.equal(readAnalyticsToken({ CLOUDFLARE_API_TOKEN: "fixture-only-value" }), "fixture-only-value");
});

test("success fixture converts microseconds to ms without treating burst CPU as an error threshold", () => {
  const report = parseHealthResponse(fixture("success"));
  assert.equal(report.failed, false);
  assert.deepEqual(report.workers[0].cpuMs, { p50: 4.5, p99: 334, p999: 650, max: 728 });
  assert.match(formatHealth(report, options), /p99=334.000 ms.*max=728.000 ms/);
});

test("failure fixture flags exceededResources (including 1102) and DO failures", () => {
  assert.equal(parseHealthResponse(fixture("failure")).failed, true);
  for (const dataset of ["workersInvocationsAdaptive", "durableObjectsInvocationsAdaptiveGroups"]) {
    const payload = fixture("success");
    const row = payload.data.viewer.accounts[0][dataset][0];
    row.dimensions.status = "clientDisconnected";
    assert.equal(parseHealthResponse(payload).failed, true); // even with zero sum.errors
    row.dimensions.status = "success";
    row.sum.errors = 1;
    assert.equal(parseHealthResponse(payload).failed, true);
  }
});

test("no Worker data fails health; no DO traffic is permitted", () => {
  const payload = fixture("success");
  payload.data.viewer.accounts[0].durableObjectsInvocationsAdaptiveGroups = [];
  assert.equal(parseHealthResponse(payload).failed, false);
  payload.data.viewer.accounts[0].workersInvocationsAdaptive = [];
  assert.equal(parseHealthResponse(payload).failed, true);
});

test("partial GraphQL errors, inaccessible accounts, missing metrics and duplicate groups fail closed", () => {
  for (const change of [
    (p: ReturnType<typeof fixture>) => { p.errors = [{ message: "fixture API failure" }]; },
    (p: ReturnType<typeof fixture>) => { p.data.viewer.accounts = []; },
    (p: ReturnType<typeof fixture>) => { delete p.data.viewer.accounts[0].workersInvocationsAdaptive[0].max; },
    (p: ReturnType<typeof fixture>) => { p.data.viewer.accounts[0].workersInvocationsAdaptive[0].sum.errors = null; },
    (p: ReturnType<typeof fixture>) => { const rows = p.data.viewer.accounts[0].workersInvocationsAdaptive; rows.push(rows[0]); },
  ]) {
    const payload = fixture("success");
    change(payload);
    assert.throws(() => parseHealthResponse(payload));
  }
  assert.throws(() => parseHealthResponse(null));
});

test("mocked fetch sends a bounded, read-only status-grouped query with explicit account/worker", async () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(input, "https://api.cloudflare.com/client/v4/graphql");
    assert.equal(init?.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer fixture-only-value");
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.variables, { account, worker: "production-fixture", start: "2026-11-08T12:00:00.000Z", end: now.toISOString() });
    assert.match(body.query, /workersInvocationsAdaptive/);
    assert.match(body.query, /durableObjectsInvocationsAdaptiveGroups/);
    assert.equal((body.query.match(/dimensions \{ status \}/g) ?? []).length, 2);
    assert.doesNotMatch(body.query, /mutation/);
    return Response.json(fixture("success"));
  };
  assert.equal((await queryEdgeHealth(options, "fixture-only-value", fakeFetch, now)).failed, false);
});

test("HTTP/network/GraphQL failures do not echo server responses or credentials", async () => {
  await assert.rejects(queryEdgeHealth(options, "fixture-only-value", async () => new Response("sensitive body", { status: 403 })), /^Error: Cloudflare analytics HTTP 403$/);
  await assert.rejects(queryEdgeHealth(options, "fixture-only-value", async () => { throw new Error("sensitive network detail"); }), /^Error: Cloudflare analytics request failed \(network\/timeout\)$/);
  await assert.rejects(queryEdgeHealth(options, "fixture-only-value", async () => Response.json({ errors: [{ message: "sensitive detail" }] })), /GraphQL returned errors/);
});
