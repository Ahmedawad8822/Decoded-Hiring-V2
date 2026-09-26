# Mission 08 — Commerce & Scheduling

Status: **IN PROGRESS**

Branch: `mission-08-commerce-scheduling`  
Base: `main@e4e4a310c71f635e0e1a1597c9588f90a063026d`

## Why this mission is next

The final v2.1 blueprint places Commerce & Scheduling before Hardening & Growth. Missions 06 and 07 delivered Learning Platform and Website Editorial AI, but the repository currently has no booking, scheduling, order/payment or provider-adapter domain.

Hardening cannot certify a launch architecture that is still missing this approved product domain.

## Goal

Build the provider-neutral commerce and scheduling domain required for coaching, workshops and paid/manual course access, while keeping real payment activation optional.

## Existing seams to preserve

- `courses.accessMode` already contains `FREE | PAID_ONE_TIME | MANUAL_INVOICE | PAYMENT_DISABLED`.
- `enrollFree()` already fails closed for non-free course modes.
- `/coaching` and `/workshop` already have public lead workflows.
- Better Auth + server-side admin authorization remain authoritative.
- D1 is business truth; R2 remains file storage.
- Mission 07 Editorial AI is a separate domain and must not absorb scheduling responsibilities.

## Required new modules

Expected deep modules:

- `src/features/commerce`
- `src/features/scheduling`

Provider contracts may live under those domains. Avoid a generic integrations god-layer.

## Schema direction

Expected tables, subject to implementation review:

- offers
- orders
- payment_events
- booking_types
- booking_availability_windows
- slot_holds
- bookings
- booking_history
- provider_connections metadata only

Secrets never live in these tables.

## Non-goals

- selecting or activating a real payment gateway without Ahmed's explicit choice
- general autonomous Gmail/inbox behavior
- social scheduling
- folding Website Editorial AI into the scheduling agent
- premature subscription billing
- deployment/DNS/production changes

## Definition of done

The canonical contract is `Docs/Engineering/COMMERCE-SCHEDULING-SPEC.md`.

## Slice 08.1 — Scheduling Core

Implements the foundational scheduling domain: booking types, weekly availability
windows, canonical slot generation, and concurrency-safe slot hold leases.

### Tables introduced

**booking_types** — defines a bookable service's policy:

| Field | Type | Notes |
|---|---|---|
| id | text PK | server-generated (`bt_<nano12>`) |
| slug | text UNIQUE NOT NULL | human-routable, `[a-z0-9-]+` |
| title | text NOT NULL | |
| description | text nullable | |
| durationMinutes | integer NOT NULL | > 0 |
| bufferBeforeMinutes | integer NOT NULL | default 0, >= 0 |
| bufferAfterMinutes | integer NOT NULL | default 0, >= 0 |
| minimumNoticeMinutes | integer NOT NULL | default 0, >= 0 |
| bookingHorizonDays | integer NOT NULL | > 0 |
| timezone | text NOT NULL | valid IANA timezone |
| confirmationPolicy | text NOT NULL | `AUTO_CONFIRM` | `AHMED_APPROVAL` | `REQUEST_ONLY` |
| accessMode | text NOT NULL | `FREE` | `PAID_SESSION` | `MANUAL_INVOICE` | `PAYMENT_DISABLED` |
| meetingMethod | text NOT NULL | `GOOGLE_MEET` | `EXTERNAL_LINK` | `PHONE` | `IN_PERSON` | `TO_BE_CONFIRMED` |
| attendeeLimit | integer NOT NULL | default 1, >= 1 |
| active | boolean NOT NULL | default true |
| createdAt / updatedAt | timestamp NOT NULL | |

Indexes: `idx_booking_types_active(active)`. Unique: `booking_types_slug_unique(slug)`.

**booking_availability_windows** — weekly recurrence rules:

| Field | Type | Notes |
|---|---|---|
| id | text PK | (`baw_<nano12>`) |
| bookingTypeId | text FK → booking_types.id CASCADE | |
| weekday | integer NOT NULL | 0..6 (Sunday=0) |
| startMinute | integer NOT NULL | 0..1439 (minutes after local midnight) |
| endMinute | integer NOT NULL | 1..1440 |
| createdAt | timestamp NOT NULL | |

Unique: `idx_booking_windows_unique(bookingTypeId, weekday, startMinute, endMinute)`.
Index: `idx_booking_windows_type(bookingTypeId)`.

**slot_holds** — temporary lease on a canonical slot:

| Field | Type | Notes |
|---|---|---|
| id | text PK | (`sh_<nano12>`) |
| bookingTypeId | text FK → booking_types.id CASCADE | |
| slotKey | text UNIQUE NOT NULL | **CRITICAL** — canonical slot identity |
| startAt / endAt | timestamp NOT NULL | UTC instants of the slot |
| ownerToken | text NOT NULL | server-generated opaque lease identity |
| status | text NOT NULL | `HELD` | `CONSUMED` | `RELEASED` (default HELD) |
| expiresAt | timestamp NOT NULL | |
| consumedAt | timestamp nullable | set on HELD → CONSUMED |
| releasedAt | timestamp nullable | set on HELD → RELEASED |
| createdAt / updatedAt | timestamp NOT NULL | |

Indexes: `idx_slot_holds_booking_type`, `idx_slot_holds_expires_at`, `idx_slot_holds_owner`.
Unique: `slot_holds_slot_key_unique(slot_key)`.

### State / lease model

```
[slot_holds row does not exist]
          │
          ▼ CASE A: INSERT
    ┌─────┴─────┐
    │   HELD    │◄─ reclaim (CASE D/E)
    └─────┬─────┘
          │
   ┌──────┴──────┐
   ▼             ▼
CONSUMED      RELEASED
(CASE F)      (CASE E: reacquireable)
```

**Expiry is derived, not stored as a state:** `status === "HELD" && expiresAt <= now` means
the lease is expired. No background job is needed to transition to an EXPIRED state.

### Slot identity

Every canonical slot has a deterministic identity:

```
slotKey = `${bookingTypeId}:${startAt.toISOString()}`
```

Example: `bt_coaching_01:2026-10-04T07:00:00.000Z`

The `slotKey` UNIQUE constraint on `slot_holds` is the authoritative DB backstop:
exactly one row represents ownership of any canonical slot at any instant.
Expired/released holds are reclaimed by UPDATE (not INSERT), replacing the row
rather than stacking multiple rows per slot.

### Timezone strategy

All persisted instants (startAt, endAt, expiresAt, createdAt, updatedAt, etc.)
are stored as UTC timestamps in D1.

The booking type's `timezone` field is validated at write time. Validation first
checks `Intl.supportedValuesOf("timeZone")` (canonical fast path) and then
probes `Intl.DateTimeFormat` so platform-valid *aliases* (e.g. `UTC`,
`Etc/UTC`) are accepted rather than rejected merely because they are absent from
the canonical list. Bogus names (e.g. `Mars/Phobos`) throw `RangeError` in the
probe and are rejected.

No external date library is added. The implementation uses only platform
`Intl` primitives (`Intl.DateTimeFormat` with `formatToParts`,
`Intl.supportedValuesOf`, and `timeZoneName: "longOffset"` / `"shortOffset"`
for DST-aware UTC offset resolution).

`localTimeToUtc()` converts a local wall-clock (reference date + local minutes)
to its UTC instant with explicit DST semantics instead of the legacy "iterate the
offset until it converges" approach:

- **Normal local time** → exactly one valid UTC instant (round-trips to the same
  wall-clock on the same local date).
- **Nonexistent local time** (spring-forward gap, e.g. America/New_York
  2026-03-08 02:30) → `NonexistentTimeError`; it is **not** silently mapped to
  01:30, 03:30, or any other instant.
- **Ambiguous local time** (fall-back overlap, e.g. 2026-11-01 01:30) → resolved
  **deterministically** to the earlier UTC instant (the first / DST occurrence);
  the policy is documented in code.

### Availability window policy

Overlapping windows for the same booking type + weekday are **rejected at
write time**, not silently merged. This is a deliberate design choice: the
operator must resolve the conflict explicitly. Exact duplicates are also
rejected (both by a pre-check SELECT and by the UNIQUE index backstop).

Adjacent windows (e.g. 09:00–10:00 and 10:00–11:00) are NOT overlapping
(half-open intervals: `[startMinute, endMinute)`).

**DB-backed invariant (authoritative backstop):** `drizzle/migrations/0011_*.sql`
adds a SQLite `BEFORE INSERT | UPDATE` trigger on `booking_availability_windows`
that `RAISE(ABORT, …)` when a newly written window overlaps an existing one for
the same booking type + weekday. Drizzle's SQLite dialect cannot express row
triggers, so this is a hand-written custom migration rather than a declarative
schema change — `drizzle-kit generate` reports "No schema changes, nothing to
migrate" because the invariant lives in SQL, outside the declarative model.
The trigger closes the read-then-write race two writers share when both pass the
application pre-check SELECT and then both attempt to INSERT; under concurrent
writes exactly one INSERT commits and the other is rolled back.

### Provider interfaces

Provider-neutral contracts defined in `src/features/scheduling/providers.ts`:

- `CalendarProvider` — `getFreeBusy`, `createEvent`, `updateEvent`, `cancelEvent`
- `PaymentGateway` — `createCheckout`, `verifyCallback`, `refundOrCancel`
- `MailboxProvider` — `sendConfirmation`, `sendReschedule`, `sendCancellation`, `sendReminder`
- `MeetingProvider` — `resolveMeetingLocation`

**Fail-closed unconfigured implementations:**

- `UnconfiguredPaymentGateway` — `createCheckout` throws
  `SchedulingProviderError("PROVIDER_NOT_CONFIGURED")`. Never returns
  `paid: true` or a dummy checkout.
- `NullCalendarProvider` — `getFreeBusy` throws. Availability for this slice
  works with policy only when no calendar provider is configured.

No Google, Stripe, or Lemon Squeezy types appear in the domain contracts.

### Concurrency invariants

1. `UNIQUE(slot_key)` on `slot_holds` is the authoritative backstop — two
   concurrent INSERTs for the same slot cannot both succeed.
2. All write mutations (acquire-reclaim, release, consume) use CAS conditions
   on `(slotKey, ownerToken, status, expiresAt)` so a stale owner cannot
   mutate a newer lease.
3. Two simultaneous `acquireSlotHold` calls produce exactly one winner and
   one loser (never two winners). The loser re-reads and returns the winner's
   hold — as a **safe view** that never carries the winner's `ownerToken`, so a
   losing caller can never observe the lease secret.
4. Expiry is derived (`status === "HELD" && expiresAt <= now`); expired holds
   are reclaimed via atomic UPDATE (not INSERT), preserving the
   one-row-per-slot invariant.
5. **Lease identity is server-generated.** `acquireSlotHold` does NOT accept an
   `ownerToken` or `endAt` from the caller — both are derived server-side
   (`generateOwnerToken()` uses the platform CSPRNG via `crypto.randomUUID()`;
   `endAt = startAt + bookingType.durationMinutes`). The caller only ever
   *presents* a previously-issued token to release or consume its own lease;
   browser input can never choose or influence the authoritative lease token.
6. **Authoritative acquisition.** `acquireSlotHold` loads the active booking
   type, its windows, and resolves `startAt` against `generateCandidateSlots`
   (single source of truth). A requested `startAt` that is not a valid
   canonical slot (off-hours, non-aligned, outside notice/horizon, inactive
   type) is rejected with `success: false, reason: "POLICY"` before any row is
   written. The persisted `endAt` is always `startAt + duration`.

### Tests added

`tests/mission-08-scheduling-core.test.ts` — 59 tests, all passing:

| Area | Count |
|---|---|
| Booking type validation + schema | 9 |
| Availability windows (incl. DB trigger backstop) | 6 |
| Canonical slot generation | 7 |
| Hold acquisition (policy-enforced) | 6 |
| Ownership-token leak / server-generated token | 6 |
| Concurrency | 2 |
| Stale-owner / forged-token protection | 4 |
| DST / IANA (nonexistent, ambiguous, alias) | 4 |
| Boundary runtime validation | 3 |
| Slug collision (no silent merge) | 2 |
| Provider contracts | 2 |

The local D1 is reset of scheduling rows at suite start so fixed-collision and
trigger tests are deterministic across repeated `tsx` runs.

### Migrations

- `drizzle/migrations/0010_old_nuke.sql` — generated via `npm run db:generate`.
- `drizzle/migrations/0011_booking_window_overlap_trigger.sql` — hand-written
  custom migration; `CREATE TRIGGER IF NOT EXISTS` (BEFORE INSERT | UPDATE on
  `booking_availability_windows`). Idempotent: `migrateLocalDb` tolerates
  `already exists` on re-runs. `drizzle-kit generate` reports
  "No schema changes, nothing to migrate" — triggers live outside the declarative
  schema.

### Deferred scope (not built in this slice)

- Booking row lifecycle (confirmed bookings)
- Ahmed approval queue
- Real calendar free/busy integration
- Google Calendar, Gmail
- Real PaymentGateway (Stripe, Lemon Squeezy)
- Checkout UI
- Coaching / workshop calendar UI
- Reminders
- Cloudflare Workflows
- Analytics events
- Command Center
- Scheduling Agent

The mission closes only after all release gates and independent release review pass, followed by Ahmed's explicit merge GO.


## Slice 08.2 — Booking Lifecycle & Approval

Status: **ACCEPTED / MERGED INTO CANONICAL MISSION 08**

Implementation branch: `mission-08.2-booking-lifecycle`  
Accepted implementation head: `681048298fce84e0dbb7710a7e19ec77a05e297b`  
Canonical merge commit: `ab956291c2a00b276ac2998bae16b9c2228ab710`

### Scope implemented

- durable `bookings` business-truth table
- append-only `booking_history` audit trail
- states: `REQUESTED | PENDING_APPROVAL | CONFIRMED | COMPLETED | CANCELLED | DECLINED`
- request idempotency via UNIQUE(request_key)
- one booking per exact hold generation via UNIQUE(hold_id, hold_acquisition_key)
- booking CAS version + transition correlation key
- `AHMED_APPROVAL` path
- Better Auth `requireAdmin()` enforcement on production admin transitions
- FREE `AUTO_CONFIRM` path
- paid/manual/disabled confirmation fail-closed until commerce state exists
- atomic D1 confirmation: claim booking -> consume exact hold generation -> confirm -> audit
- stale/reclaimed hold-generation protection
- cancellation/decline release of only the exact lease generation owned by the booking
- reschedule consumes the new generation, releases the old consumed generation, and records old/new slot identities in audit history
- completion keeps the current consumed appointment historical
- migration `0013_booking_lifecycle` plus Drizzle snapshot/journal
- dedicated 08.2 regression suite added to `npm test`

### Security boundary

Browser/admin callers do not submit an authoritative role. Public admin lifecycle operations resolve the live Better Auth server session through `requireAdmin()`. The trusted actor transition seam used by unit regression tests is not exported from the scheduling barrel.

### Review status

Source review found and remediated:
1. cancelled/rescheduled confirmed bookings initially left the prior `CONSUMED` hold permanently blocking the slot; lifecycle-controlled exact-generation release now frees those slots without loosening generic 08.1 acquisition rules.
2. initial admin transition inputs accepted a caller-provided role string; production mutations now authenticate through Better Auth `requireAdmin()`.

Runtime certification passed on exact implementation head `681048298fce84e0dbb7710a7e19ec77a05e297b`:
- typecheck — PASS
- lint with zero warnings — PASS
- full `npm test` — 281 pass / 0 fail
- 08.1 scheduling suite — 78 pass / 0 fail
- 08.2 booking lifecycle suite — 18 pass / 0 fail
- Drizzle drift — PASS
- production build — PASS

Independent `dh-release-review` found no Critical or Major blockers. Ahmed gave explicit GO, and Slice 08.2 was merged into the canonical Mission 08 branch at `ab956291c2a00b276ac2998bae16b9c2228ab710`.

### Slice 08.2 stop rule

**Satisfied.** Slice 08.2 is frozen in the canonical Mission 08 branch.


## Slice 08.3 — Offer / Access Integration

Status: **ACCEPTED / MERGED INTO CANONICAL MISSION 08**

Implementation branch: `mission-08.3-offer-access-integration`  
Accepted implementation head: `ff780c8ffd45432772a67af99e30abd6be7a69d8`  
Canonical merge commit: `8c18b78f32b31f2bf6dd3733510318485ff36872`

### Scope implemented

- provider-neutral `offers` domain and migration `0014_offer_access`
- Offer kinds: `COURSE | COACHING | WORKSHOP | PRODUCT`
- access modes:
  - `FREE`
  - `PAID_ONE_TIME`
  - `PAID_SESSION`
  - `MANUAL_INVOICE`
  - `PAYMENT_DISABLED`
  - `COMING_SOON`
- one primary Offer per linked course or booking type, enforced by UNIQUE indexes
- Offer slug uniqueness
- linked course / booking-type existence validation
- provider-paid price validation with currency + positive minor-unit amount
- currency formatting that respects each currency's minor-unit scale
- same-site / fragment / mailto / HTTPS alternative-CTA validation
- `PAYMENT_DISABLED` and `COMING_SOON` require an explicit non-payment alternative CTA
- paid modes remain fail-closed: this slice creates no checkout and grants no paid entitlement
- inactive Offers fail closed instead of falling back to legacy access configuration
- Mission 06 course `accessMode` retained only as compatibility fallback until a linked Offer exists
- linked Offer becomes authoritative for new course access decisions
- server-side guard prevents legacy course access-mode drift once Offer owns the course
- FREE Offer may grant the existing Mission 06 free enrollment path
- paid/manual/disabled/coming-soon Offers cannot use the FREE auto-enrollment path
- Studio course list exposes effective Offer mode and prevents editing the dormant legacy fallback when linked
- Mission 01, coaching, workshop, AI Recruiter OS, and learner course overview pages consume Offer state
- public product routes require the expected Offer kind
- inactive Offers expose no CTA or price
- existing public behavior remains unchanged when no Offer is configured
- dedicated 08.3 regression suite added to `npm test`

### Explicit non-scope

Slice 08.3 does **not**:
- activate Stripe, Lemon Squeezy, or any other payment provider
- create checkout sessions
- create payment/order truth
- grant entitlement from an unverified payment callback
- implement provider webhooks
- implement booking-payment orchestration
- replace booking lifecycle state
- deploy or change production configuration

Those remain later Mission 08 slices.

### Runtime certification

Final exact-head GitHub Actions run `36238762049` passed on accepted implementation head `ff780c8ffd45432772a67af99e30abd6be7a69d8`:

- typecheck — PASS
- lint with zero warnings — PASS
- full `npm test` — **299 pass / 0 fail**
- 08.1 scheduling suite — **78 pass / 0 fail**
- 08.2 booking lifecycle suite — **18 pass / 0 fail**
- 08.3 Offer/access suite — **18 pass / 0 fail**
- Drizzle drift — PASS: `No schema changes, nothing to migrate`
- production build — PASS

Independent `dh-release-review` found no Critical or Major blockers. Ahmed gave explicit GO and PR #8 was merged into the canonical Mission 08 branch at `8c18b78f32b31f2bf6dd3733510318485ff36872`.

### Slice 08.3 stop rule

**Satisfied.** Slice 08.3 is frozen in the canonical Mission 08 branch.


## Slice 08.4 — Provider-Neutral Adapters

Status: **ACCEPTED / MERGED INTO CANONICAL MISSION 08**

Implementation branch: `mission-08.4-provider-neutral-adapters`  
Accepted implementation head: `123607a9cae02fe969023ec40421c0019a2e48f0`  
Canonical merge commit: `7a417f67621c73de97bb1b6002ee70dfdf4c0202`

### Scope implemented

The existing Mission 08.1 provider seam is hardened in place rather than duplicated.

#### Shared provider boundary

- provider kinds: `payment | calendar | mailbox | meeting`
- provider-neutral runtime status:
  - configured/unconfigured
  - provider identity metadata
  - supported capability names
- structured provider errors include:
  - error code
  - provider kind
  - operation
  - retryability
- all unconfigured providers are immutable safe defaults
- a frozen `UnconfiguredCommerceSchedulingProviders` bundle is available for later orchestration dependency injection

#### PaymentGateway

Provider-neutral contract now covers:
- checkout creation from internal order/offer identity
- amount minor units + currency
- stable internal idempotency key
- callback verification
- webhook signature verification
- provider-state normalization
- cancel/refund with stable idempotency key
- provider checkout/payment/event identifiers only as adapter metadata
- discriminated verification result: unverified callbacks cannot carry a paid state
- normalized payment state intentionally cannot be `FULFILLED`; only internal Decoded Hiring orchestration may grant fulfillment/access

Unconfigured payment behavior:
- every external payment operation throws `PROVIDER_NOT_CONFIGURED`
- no dummy checkout URL
- no fake verified callback
- no fake paid result
- no provider activation or credentials

#### CalendarProvider

Contract now covers:
- bounded free/busy
- confirmed event creation
- approved reschedule/update
- cancellation
- internal booking identity
- idempotency keys for event side effects
- timezone
- attendees/location
- provider event reference
- returned meeting/location metadata

Unconfigured calendar behavior:
- free/busy throws instead of returning an empty array that could be misread as fully available
- create/update/cancel throw fail-closed

#### MailboxProvider

Contract now covers:
- confirmation
- reschedule
- cancellation
- reminder
- internal booking identity
- idempotency key
- provider message reference

Unconfigured mailbox:
- every send operation throws `PROVIDER_NOT_CONFIGURED`

#### MeetingProvider

Contract now covers provider-neutral meeting/location resolution with booking/idempotency correlation.

Unconfigured meeting behavior:
- explicit HTTPS external link — allowed without provider
- explicit phone — allowed without provider
- explicit in-person address — allowed without provider
- `TO_BE_CONFIRMED` — allowed as honest static state
- provider-generated `GOOGLE_MEET` — fails closed
- missing static overrides — fail with `INVALID_CONFIGURATION`
- non-HTTPS or credential-bearing external URLs — rejected

### Retry / authority invariants encoded in contracts

- checkout creation carries an internal idempotency key
- refund/cancel carries an internal idempotency key
- calendar create/update/cancel carry internal idempotency keys
- mailbox sends carry internal idempotency keys
- meeting resolution carries internal booking/idempotency identity for generated-provider paths
- payment provider may prove `PAID` but cannot assert `FULFILLED`
- unverified callbacks cannot expose a normalized payment state at the type level

### Regression coverage

Dedicated `tests/mission-08-provider-adapters.test.ts` covers:
- fail-closed payment capabilities
- webhook/signature path
- no fake paid result
- fail-closed calendar free/busy and event mutation
- fail-closed mailbox operations
- safe static meeting resolution
- generated-meeting fail-closed behavior
- unsafe/missing meeting configuration
- explicit provider runtime status
- immutable default adapters/bundle
- provider-neutral calendar result metadata
- provider-neutral payment state normalization
- compile-time guard preventing provider-controlled fulfillment
- compile-time guard preventing unverified callback payment state

The existing 08.1 provider-coupling source regression remains active and continues to reject concrete provider SDK coupling in the domain boundary.

### Explicit non-scope

Slice 08.4 does **not**:
- select or activate any real payment provider
- select or activate Google Calendar/Workspace or another calendar provider
- send real email
- create real provider-generated meeting links
- add credentials/secrets
- create Order/payment persistence
- process live webhooks
- orchestrate provider side effects after booking confirmation
- deploy, modify DNS, or alter production resources

Order/payment truth, provider activation/configuration, durable side-effect orchestration, audit/idempotency persistence, and public scheduling workflow remain later Mission 08 slices.

### Runtime certification

Final exact-code GitHub Actions run `36243241650` passed on implementation head `45c97a177ea847ffe6eaee940a7c13c418ad4ab2`:

- typecheck — PASS
- lint with zero warnings — PASS
- full `npm test` — **310 pass / 0 fail**
- 08.1 scheduling suite — **78 pass / 0 fail**
- 08.2 booking lifecycle suite — **18 pass / 0 fail**
- 08.3 Offer/access suite — **18 pass / 0 fail**
- 08.4 provider-adapter suite — **11 pass / 0 fail**
- Drizzle drift — PASS: `No schema changes, nothing to migrate`
- production build — PASS

### Independent review

Independent `dh-release-review` on PR #9 found:
- no Critical findings
- no Major findings
- one non-blocking Minor: future live webhook orchestration must make signature verification a mandatory gate before payment-state normalization/persistence

That webhook requirement is implemented more strongly in Slice 08.5: live webhook orchestration uses one compound provider boundary that verifies the signature and derives Order identity + normalized payment truth from the same signed raw envelope before any persistence.

Ahmed gave explicit GO and PR #9 was merged into canonical Mission 08 at `7a417f67621c73de97bb1b6002ee70dfdf4c0202`.

### Slice 08.4 stop rule

**Satisfied.** Slice 08.4 is frozen in the canonical Mission 08 branch.


## Slice 08.5 — Order / Payment Truth + Durable Orchestration

Status: **IMPLEMENTED — SOURCE CERTIFIED; INDEPENDENT RELEASE REVIEW PENDING**

Implementation branch: `mission-08.5-order-orchestration`  
Accepted base: `7a417f67621c73de97bb1b6002ee70dfdf4c0202`  
Source-certified head before this documentation sync: `fec9f8607cc1a59944777e1c0240c73b2c30c752`

### Scope implemented

Slice 08.5 closes the missing internal commerce truth and durability boundary required before public scheduling/provider activation.

#### Order / payment business truth

- provider-independent `orders` table and state machine:
  - `PENDING`
  - `REQUIRES_ACTION`
  - `PAID`
  - `FULFILLED`
  - `CANCELLED`
  - `FAILED`
  - `REFUNDED`
- stable internal request identity via unique `requestKey`
- immutable Offer/booking/user binding checks for duplicate requests
- linked course and booking orders require quantity `1`
- booking-linked Offers require the exact booking identity
- Offer price/currency are snapshotted into the Order
- provider checkout/payment/event ids remain metadata, never business identity
- append-only `order_history`
- append-only/deduplicated `payment_events`

#### Verified payment evidence

- callback evidence must pass `PaymentGateway.verifyCallback`
- callback provider verification receives only opaque provider evidence; the expected internal Order id is not supplied to the adapter
- webhook evidence must pass compound `PaymentGateway.verifyWebhookPayment`
- the webhook adapter must verify the signature and derive Order id, payment state, amount/currency and provider metadata from the **same signed raw envelope**
- unsigned caller-supplied webhook state/amount/currency are not part of the 08.5 application boundary
- callback/webhook provider metadata must match the configured adapter identity
- verified provider event ids require an authoritative provider name
- duplicate callbacks collapse by internal callback key
- duplicate provider events collapse by provider + provider event id
- concurrent same-provider-event races collapse to one accepted business transition
- payment amount/currency are checked against the Order snapshot
- external adapters may prove `PAID` but cannot assert `FULFILLED`

#### Internal fulfillment authority

- verified/manual payment reaching `PAID` atomically enqueues one durable internal fulfillment effect
- `FULFILLED` is owned only by Decoded Hiring orchestration
- course fulfillment grants/restores learner enrollment with `accessSource = order:<orderId>`
- course enrollment grant is gated on the exact still-`PAID` order version
- paid booking fulfillment waits for or auto-confirms a matching booking according to booking policy
- only `AUTO_CONFIRM` may be system-confirmed after payment
- `AHMED_APPROVAL` remains human-gated
- standalone products without an internal fulfillment strategy stay honestly `PAID` and block rather than fabricating fulfillment

#### Refund reconciliation

- `REFUNDED` atomically enqueues a durable refund-reconciliation effect
- refund before fulfillment closes obsolete fulfillment without granting access
- refund after course fulfillment revokes only enrollment access owned by that Order
- unrelated/pre-existing access is not revoked

#### Durable scheduling & communications orchestration

D1-backed outbox tables:
- `orchestration_effects`
- append-only `orchestration_history`

Effect types include:
- payment checkout creation
- internal Order fulfillment
- refunded Order reconciliation
- calendar create/update/cancel
- confirmation/reschedule/cancellation/reminder mail

Durability/recovery behavior:
- stable idempotency key per external/internal side effect
- dependency ordering between effects
- lease/CAS worker ownership
- expired-lease recovery
- append-only attempt history
- retryable failure with bounded backoff scheduling
- `BLOCKED` state for absent/invalid provider configuration
- terminal failure state for non-retryable provider failures
- provider-not-configured blocks can resume when configuration becomes available
- invalid-configuration blocks do not auto-resume
- bounded worker discovery/processing entry point
- stale/superseded booking calendar/message work resolves without sending stale communication

#### Booking lifecycle hand-off

- linked Offer is authoritative for booking commercial access policy
- paid/manual booking confirmation requires a matching internal Order in `PAID` or `FULFILLED`
- FREE AUTO_CONFIRM behavior remains intact
- confirmation atomically enqueues calendar-create then confirmation-mail dependency
- reschedule atomically enqueues calendar-update then reschedule-mail dependency
- cancellation atomically enqueues cancellation side effects
- existing 08.2 hold-generation/version ordering remains preserved

#### Migration

Migration `0015_order_orchestration` adds:
- `orders`
- `order_history`
- `payment_events`
- `orchestration_effects`
- `orchestration_history`

Drizzle journal/snapshot identity is unique and drift-free.

### Regression coverage

Dedicated `tests/mission-08-order-orchestration.test.ts` contains **27 passing regressions**, including:
- Order idempotency and request-key conflict
- quantity and booking-link constraints
- unverified callback fail-closed behavior
- callback/webhook provider identity
- signed-envelope webhook binding and rejection of unverified evidence
- amount mismatch rejection
- provider-event dedupe and concurrent event collapse
- manual invoice trusted transition
- course fulfillment + enrollment
- refund before/after fulfillment
- unsupported standalone product fulfillment
- checkout retry safety
- paid AUTO_CONFIRM orchestration
- paid booking confirmation gate
- atomic booking outbox dependencies
- blocked-provider recovery
- invalid-configuration persistence
- concurrent worker collapse
- retry/backoff recovery
- expired-lease recovery/audit
- migration identity

Existing 08.1–08.4 suites remain green.

### Explicit non-scope

Slice 08.5 does **not**:
- activate Stripe, Lemon Squeezy, Google Calendar, Gmail, or any concrete provider
- add production provider credentials/secrets
- expose a live public payment callback/webhook route
- expose public scheduling checkout UX
- build Studio Scheduling/Commerce control plane
- add provider analytics/event dashboards
- deploy or modify DNS/production resources

Provider activation, public scheduling/checkout routes, Studio control plane, observability/analytics, and full browser E2E remain later Mission 08 work.

### Source runtime certification

GitHub Actions run `36264573636` passed on source-certified head `fec9f8607cc1a59944777e1c0240c73b2c30c752`:

- typecheck — PASS
- lint with zero warnings — PASS
- full `npm test` — **337 pass / 0 fail**
- 08.1 scheduling — **78 / 78**
- 08.2 booking lifecycle — **18 / 18**
- 08.3 Offer/access — **18 / 18**
- 08.4 provider adapters — **11 / 11**
- 08.5 Order/orchestration — **27 / 27**
- Drizzle drift — PASS: `No schema changes, nothing to migrate`
- production build — PASS

A final exact-head certification is required after this engineering-ledger synchronization, followed by independent `dh-release-review`.

### Slice 08.5 stop rule

Do not merge Slice 08.5 into `mission-08-commerce-scheduling` until:
- final exact-head typecheck/lint/tests/Drizzle/build are green,
- independent `dh-release-review` passes,
- any Critical/Major findings are remediated and re-reviewed,
- ChatGPT final exact-SHA verification passes,
- Ahmed explicitly says GO.
