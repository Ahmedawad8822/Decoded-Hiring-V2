import "./helpers/env";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { disposeCloudflareBindings } from "@/lib/cloudflare/bindings";
import { migrateLocalDb } from "@/lib/db/migrate";
import { generateCandidateSlots, iterateCandidateSlots } from "@/features/scheduling/availability";
import { resolvePublicSchedulingModel as resolveModelImpl } from "@/features/scheduling/public-scheduling";
import { generateCandidateSlots as referenceCandidates } from "./helpers/slots-reference/availability";
import { resolvePublicSchedulingModel as referenceModelImpl } from "./helpers/slots-reference/public-scheduling";
import { seedSlotsFixture, settleLocalD1 } from "./helpers/slots-fixture";

// Every model call starts with D1 reads; yield first so a socket closed during
// the preceding synchronous work is retired (see settleLocalD1).
async function referenceModel(...args: Parameters<typeof referenceModelImpl>) {
  await settleLocalD1();
  return referenceModelImpl(...args);
}
async function resolvePublicSchedulingModel(...args: Parameters<typeof resolveModelImpl>) {
  await settleLocalD1();
  return resolveModelImpl(...args);
}

test.before(() => migrateLocalDb());
test.after(() => disposeCloudflareBindings());

// Backstop for settleLocalD1: if a local D1 proxy socket is still reset, rerun
// the test once. Each attempt seeds fresh rows with new ids, so a rerun is safe;
// any other failure, or a second reset, still fails.
function isProxyReset(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const err = e as { code?: string; message?: string; cause?: unknown };
    if (err.code === "ECONNRESET" || /ECONNRESET/.test(err.message ?? "")) return true;
    e = err.cause;
  }
  return false;
}

function proxyTest(name: string, fn: () => Promise<void>) {
  test(name, async (t) => {
    try {
      await fn();
    } catch (error) {
      if (!isProxyReset(error)) throw error;
      t.diagnostic("local D1 proxy reset (ECONNRESET); retrying once with fresh rows");
      await settleLocalD1();
      await fn();
    }
  });
}

const scenarios = [
  { timezone: "Africa/Cairo", now: "2026-10-20T08:00:00Z" },
  { timezone: "Africa/Cairo", now: "2026-04-22T08:00:00Z" },
  { timezone: "America/New_York", now: "2026-03-07T00:00:00Z" },
  { timezone: "America/New_York", now: "2026-10-31T00:00:00Z" },
  { timezone: "Europe/London", now: "2026-03-28T00:00:00Z" },
  { timezone: "Europe/London", now: "2026-10-24T00:00:00Z" },
  { timezone: "Australia/Lord_Howe", now: "2026-04-04T00:00:00Z" },
  { timezone: "Australia/Lord_Howe", now: "2026-10-03T00:00:00Z" },
  { timezone: "Pacific/Apia", now: "2011-12-28T00:00:00Z" },
  { timezone: "Asia/Kathmandu", now: "2026-02-01T00:00:00Z" },
  { timezone: "Pacific/Kiritimati", now: "2026-02-01T00:00:00Z" },
  { timezone: "UTC", now: "2026-02-01T12:17:00.123Z" },
];

for (const [index, scenario] of scenarios.entries()) {
  proxyTest(`slots equal frozen implementation: ${scenario.timezone} ${scenario.now}`, async () => {
    await settleLocalD1();
    const fixture = await seedSlotsFixture({
      now: new Date(scenario.now),
      policy: {
        timezone: scenario.timezone, durationMinutes: [15, 30, 60][index % 3],
        bufferBeforeMinutes: index % 2 ? 0 : 7,
        bufferAfterMinutes: index % 2 ? 0 : 11,
        minimumNoticeMinutes: index % 3 ? 0 : 67,
        bookingHorizonDays: index % 2 ? 3 : 60,
      },
      // Midnight, gaps/folds, final minute, adjacent edges, unsorted rules.
      windows: Array.from({ length: 7 }, (_, weekday) => [
        { weekday, startMinute: 1020, endMinute: 1440 },
        { weekday, startMinute: 0, endMinute: 240 },
        { weekday, startMinute: 240, endMinute: 480 },
      ]).flat(),
    });
    const expected = referenceCandidates(fixture.candidateParams);
    assert.deepEqual(generateCandidateSlots(fixture.candidateParams), expected);
    assert.deepEqual(Array.from(iterateCandidateSlots(fixture.candidateParams)), expected);
    const expectedModel = await referenceModel(fixture.params);
    const actualModel = await resolvePublicSchedulingModel(fixture.params);
    assert.deepEqual(actualModel, expectedModel);
    assert.ok(actualModel.enabled);
    assert.ok(actualModel.slots.length > 0 && actualModel.slots.length <= 60);
    assert.equal(actualModel.rangeEnd, new Date(fixture.params.now.getTime() + 31 * 86_400_000).toISOString());

    // Provider intervals exactly touching an edge must not block that slot.
    const slot = expected[0];
    assert.ok(slot);
    fixture.busy.splice(0, fixture.busy.length,
      { startAt: new Date(slot.startAt.getTime() - 60_000), endAt: slot.startAt, busy: true },
      { startAt: slot.endAt, endAt: new Date(slot.endAt.getTime() + 60_000), busy: true },
      { startAt: slot.startAt, endAt: slot.endAt, busy: false },
    );
    assert.deepEqual(await resolvePublicSchedulingModel(fixture.params), await referenceModel(fixture.params));

    // Entire probe range unavailable: no cap-triggered early return can hide
    // errors late in the range, including a transition later than the first day.
    fixture.busy.push({ startAt: fixture.params.now, endAt: fixture.candidateParams.rangeEnd, busy: true });
    const blocked = await resolvePublicSchedulingModel(fixture.params);
    assert.deepEqual(blocked, await referenceModel(fixture.params));
    assert.ok(blocked.enabled && blocked.slots.length === 0);
  });
}

proxyTest("dense one-minute schedule stops at cap, including conflicts before the cap", async () => {
  await settleLocalD1();
  const fixture = await seedSlotsFixture({
    policy: { timezone: "UTC", durationMinutes: 1, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, bookingHorizonDays: 3 },
    windows: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 540, endMinute: 780 })),
    conflicts: false,
  });
  // Make the first day unavailable, so generation must resume on the next day.
  fixture.busy.push({ startAt: fixture.params.now, endAt: new Date(fixture.params.now.getTime() + 86_400_000), busy: true });
  const actual = await resolvePublicSchedulingModel(fixture.params);
  assert.deepEqual(actual, await referenceModel(fixture.params));
  assert.ok(actual.enabled && actual.slots.length === 60);
});

proxyTest("notice, horizon and range edges; insufficient/overlapping windows retain reference output", async () => {
  await settleLocalD1();
  const fixture = await seedSlotsFixture({ conflicts: false, policy: { timezone: "UTC" } });
  const slot = fixture.candidates[0];
  const params = { ...fixture.candidateParams, rangeStart: slot.startAt, rangeEnd: slot.endAt };
  for (const delta of [-1, 0, 1]) {
    const edge = { ...params, rangeEnd: new Date(slot.endAt.getTime() + delta) };
    assert.deepEqual(generateCandidateSlots(edge), referenceCandidates(edge));
  }
  const noticeNow = new Date(slot.startAt.getTime() - fixture.bookingType.minimumNoticeMinutes * 60_000);
  const horizonNow = new Date(slot.startAt.getTime() - fixture.bookingType.bookingHorizonDays * 86_400_000);
  for (const boundary of [noticeNow, horizonNow]) for (const delta of [-1, 0, 1]) {
    const edge = { ...params, now: new Date(boundary.getTime() + delta) };
    assert.deepEqual(generateCandidateSlots(edge), referenceCandidates(edge));
  }
  const overlapping = { ...params, windows: [...fixture.windows, ...fixture.windows].reverse() };
  assert.deepEqual(generateCandidateSlots(overlapping), referenceCandidates(overlapping));
  const tooSmall = { ...params, bookingType: { ...params.bookingType, bufferBeforeMinutes: 1440 } };
  assert.deepEqual(generateCandidateSlots(tooSmall), []);
});
