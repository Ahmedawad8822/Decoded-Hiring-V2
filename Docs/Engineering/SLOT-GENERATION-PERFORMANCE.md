# Public slot generation CPU

Measured on 2026-11-08 with Node 22.23.2 against the implementation at
`6328c1c` and this optimization. The benchmark creates throwaway Miniflare D1
state through `tests/helpers/env.ts`; it never reads the developer database.

The fixture has two weekly windows per weekday, 30-minute appointments,
10-minute window buffers, one-hour notice, a 60-day booking horizon, confirmed
bookings, consumed/live/expired/released holds, and unsorted overlapping calendar
busy intervals. It crosses Cairo's autumn DST transition. There are 610 canonical
candidates across the full 60 days.

The resolver preserves its existing **31-day public range cap**, including when
called with `rangeDays: 60`. The benchmark separately measures the full 60-day
canonical generator, and asserts that the public model returns 60 slots.

Run the benchmark and profile:

```sh
npx tsx scripts/bench-slots.ts --reference --iterations=100
npx tsx scripts/bench-slots.ts --iterations=100
mkdir -p /tmp/slots-profile
node --cpu-prof --cpu-prof-dir=/tmp/slots-profile --import tsx scripts/bench-slots.ts --reference
node --cpu-prof --cpu-prof-dir=/tmp/slots-profile --import tsx scripts/bench-slots.ts
```

Each timing uses `process.cpuUsage` (user + system CPU), 15 warmups and 100
measured calls. The final runs below were sequential, without the test suite
running alongside them, and without the profiler enabled.

| Operation | Before median / p95 | After median / p95 |
|---|---:|---:|
| `resolvePublicSchedulingModel`, public range cap | 184.884 / 221.110 ms | 10.763 / 22.933 ms |
| Canonical generator, full 60 days | 224.617 / 280.070 ms | 6.721 / 7.787 ms |
| Iterator, first 60 candidates, without DB or conflicts | — | 0.953 / 1.222 ms |

The resolver median improved by about 17 times. **The complete Node resolver
measurement still misses the under-5-ms target.** It includes local D1 client
and Miniflare RPC CPU, excludes the separate workerd process, and is not a
measurement of a built/deployed Worker request. Neither the iterator timing nor
these resolver timings establish compliance with the Workers Free 10-ms CPU
limit. That requires another built Worker/request CPU profile with the adapter
and runtime overhead included. No deployment was performed.

The baseline CPU profile identifies this hot stack:

```text
listAvailableSlots → generateCandidateSlots → localTimeToUtc
  → getLocalDateParts
  → getTimezoneOffsetMs (five offset probes per candidate; hottest helper)
  → roundTripsToWallClock → getLocalWallClock
```

Repeated `Intl.DateTimeFormat` construction dominates these helpers. Calendar
`overlaps` scans are also visible. In the optimized Node profile, Miniflare's
`receiveReply` is the largest sampled function; remaining scheduling work is
mostly offset/round-trip formatting. Profiles also include setup and the full
60-day generator loop, so their sample shares are not per-request CPU budgets.

Changes:

- Bound and reuse Intl formatters; cache identical offset probes and local
  dates only within a generation pass. Keep the exact original five probes,
  formatter options and round-trip validation for gaps and folds.
- Expand weekly window minutes once, group padded reference days by local
  calendar day, and yield canonical slots in order. Retain duplicate-date
  multiplicity at historical date-line changes. Stop the public consumer as
  soon as 60 available slots have been found, without regenerating prefixes.
- Sort calendar intervals once and sweep their maximum end as candidates
  advance. Preserve strict edge overlap and canonical-key exclusion for
  bookings/holds, including persisted intervals that overlap neighboring slots.
- Read Offer/BookingType with one join and reuse one Drizzle instance per
  resolver call. Read windows, holds and bookings in one D1 batch. This reduces
  six binding calls to two and retains a configuration-only page projection.

Equivalence is checked against frozen copies of the previous generator,
timezone resolver and public model under `tests/helpers/slots-reference/`.
The 14 new tests compare complete canonical arrays and complete public models,
including New York/London gaps and folds, Cairo's midnight transition, Lord
Howe's half-hour shift, Apia's skipped date, fractional and extreme offsets,
buffer/notice/horizon/range edges, unsorted and overlapping inputs, lease expiry
and status, bookings, nested calendar intervals, touching interval edges,
fully busy horizons, and a dense one-minute schedule reaching the slot cap.

Validation: `npm run lint`, `npm run typecheck`, and `npm test` passed; 516 tests
across 39 suites.
