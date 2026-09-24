# Commerce & Scheduling Specification

Status: **Mission 08 implementation contract**  
Source of truth: `Docs/Reference/Decoded_Hiring_V2_Master_Blueprint_FINAL_v2.1.docx`

## 1. Outcome

Decoded Hiring V2 must support products, course access and appointment/workshop booking without coupling the product to a payment gateway, calendar provider, mailbox provider or meeting provider.

The domain must work when payment is disabled and remain activation-ready for future payment, Google Workspace or another provider without redesigning product pages, learner access or booking state.

## 2. Scope

Mission 08 includes:

- product/access pricing modes
- course monetization hand-off from the existing Mission 06 access modes
- booking types as configuration
- availability policies
- timezone-safe slot calculation
- temporary slot holds with expiry
- booking request, approval, confirmation, reschedule and cancellation states
- manual/invoice payment state
- dormant payment-gateway interface
- provider-neutral calendar, mailbox and meeting interfaces
- Scheduling & Communications workflow boundary
- admin operations and audit history
- public coaching/workshop scheduling entry points
- tests for concurrency, idempotency, authorization and expiry/recovery

Mission 08 does **not** activate a real payment provider unless Ahmed separately selects one and supplies configuration.

## 3. Product access modes

Every sellable/bookable offer declares one access mode:

| Mode | Behavior |
|---|---|
| `FREE` | no checkout; configured free enrollment/booking path |
| `PAID_ONE_TIME` | checkout required before durable access is granted |
| `PAID_SESSION` | payment belongs to a specific booking |
| `MANUAL_INVOICE` | request/order remains pending until admin records payment |
| `PAYMENT_DISABLED` | no dead checkout button; render configured alternative CTA |
| `COMING_SOON` | collect interest or show configured non-payment CTA |

Recurring/subscription pricing is intentionally deferred, but schema/contracts must not make it impossible.

## 4. Core domain model

### Offer

A sellable/bookable presentation of a course, coaching session, workshop or future product.

Required fields:

- id
- kind: `COURSE | COACHING | WORKSHOP | PRODUCT`
- linked entity id when applicable
- title
- slug
- access mode
- currency
- amount minor units, nullable for free/manual/disabled modes
- active
- alternative CTA label/url for disabled/coming-soon states
- timestamps

### Order / payment state

Orders are internal business truth even when payment is manual.

States:

`PENDING -> REQUIRES_ACTION -> PAID -> FULFILLED`

Terminal/alternate:

`CANCELLED | FAILED | REFUNDED`

Payment provider identifiers are adapter metadata, not domain identity.

### Booking type

Configuration shared by coaching, workshop discovery and future appointment types.

Required policy:

- title/slug
- duration minutes
- buffer before/after
- minimum notice
- booking horizon
- timezone
- allowed weekdays/windows
- attendee limits
- qualification fields
- meeting method
- confirmation policy: `AUTO_CONFIRM | AHMED_APPROVAL | REQUEST_ONLY`
- cancellation/reschedule rules
- access/payment mode
- active state

### Slot hold

A short-lived ownership lease over a candidate slot.

Required fields:

- booking type
- start/end UTC
- requester/session ownership token
- expiresAt
- state: `HELD | CONSUMED | EXPIRED | RELEASED`
- unique conflict backstop preventing overlapping live holds for the same booking type/time

Expiry must be authoritative on the server. A stale hold can never permanently block the slot.

### Booking

States:

`REQUESTED -> PENDING_APPROVAL -> CONFIRMED -> COMPLETED`

Alternates:

`CANCELLED | DECLINED`

Rescheduling creates an auditable state transition and must not silently overwrite the original appointment history.

Booking stores UTC instants plus the booking timezone used for presentation.

## 5. Availability

Availability is the intersection of:

1. booking-type policy
2. existing confirmed bookings
3. unexpired slot holds
4. provider free/busy when a calendar adapter is configured
5. buffers, minimum notice and booking horizon

D1 owns business state. External calendar availability is an input signal, never the source of truth for whether a Decoded Hiring booking exists.

## 6. Concurrency and idempotency

Mandatory invariants:

- two visitors cannot confirm the same slot
- parallel hold attempts collapse to one winner
- expired holds do not block new holds
- confirmation consumes the exact owning hold
- stale request/approval workers cannot confirm a booking they no longer own
- external callbacks are idempotent
- payment confirmation is safe to retry
- calendar event creation is safe to retry using an internal idempotency key
- duplicate form submission returns the existing business result where appropriate

Use database uniqueness/CAS/lease identity rather than process memory.

## 7. PaymentGateway contract

The application depends on a provider-neutral interface, initially resolved to an unconfigured adapter.

Required capabilities:

- create checkout
- verify payment/callback
- cancel/refund where supported
- webhook signature verification
- normalize provider state to internal order/payment state

When unconfigured:

- paid actions fail closed
- UI exposes the configured alternative/manual path
- no fake successful payment is possible

No raw card data is stored by Decoded Hiring.

## 8. CalendarProvider contract

Capabilities:

- read free/busy for a bounded time range
- create confirmed event
- update event for approved reschedule
- cancel event
- return provider event id and meeting/location metadata

The domain must not require Google-specific fields.

## 9. MailboxProvider contract

Narrow booking/workshop operational scope only:

- send approved confirmation
- send reschedule/cancellation
- send reminder
- optionally read explicitly permitted booking correspondence later

No general autonomous inbox access.

## 10. MeetingProvider contract

Creates or resolves meeting/location information when supported. A calendar adapter may satisfy this capability directly.

## 11. Scheduling & Communications workflow

The workflow owns durable orchestration only. D1 remains business truth.

Flow:

`REQUEST -> HOLD -> PAYMENT/APPROVAL -> CONFIRM -> CALENDAR -> MESSAGE -> REMINDER`

Rules:

- ambiguous/high-value/unusual correspondence escalates
- Ahmed approval is explicit when policy requires it
- agent/workflow authority is bounded by booking policy
- every meaningful external side effect is auditable and idempotent
- failure after D1 confirmation must be recoverable without duplicate events/messages

## 12. Admin UX

Studio must expose a coherent Scheduling/Commerce area with:

- Offers
- Booking types
- Upcoming/requested bookings
- Approval queue
- Orders/payment state
- Provider status
- audit/history on individual bookings

Admin destructive/state-changing actions require server-side authorization.

## 13. Public UX

### Coaching

The existing decision brief remains useful. Mission 08 adds a scheduling path appropriate to the configured confirmation/payment mode rather than replacing the lead capture blindly.

### Workshop

Team enquiries remain lead-first. Open-cohort or discovery-call scheduling can use a booking type when enabled.

No broken checkout or unavailable calendar control should be rendered.

## 14. Security

- server-authoritative authorization/state transitions
- Zod/runtime validation at action/service boundaries
- CSRF/origin protection inherited from application architecture
- provider secrets/tokens server-only and never persisted in plaintext D1
- least-privilege provider scopes
- rate limits/Turnstile prepared for abuse-prone public booking endpoints
- permanent audit for approvals, confirmations, cancellations and payment-state changes
- webhook verification before internal state mutation

## 15. Observability and measurability

Track meaningful business events:

- offer_cta_clicked
- booking_started
- slot_held
- booking_requested
- booking_approved
- booking_confirmed
- booking_declined
- booking_cancelled
- booking_rescheduled
- checkout_started
- payment_confirmed
- payment_failed

Do not emit sensitive qualification answers into analytics.

## 16. Implementation slices

1. Domain/schema + contracts + migrations + pure policy tests
2. Availability + hold lease/concurrency engine
3. Booking lifecycle + approval/admin operations
4. Offer/access integration with courses and public product pages
5. Provider-neutral payment/calendar/mailbox/meeting adapters with fail-closed unconfigured implementations
6. Durable orchestration boundary + audit/idempotency
7. Public coaching/workshop scheduling UX
8. E2E + security + concurrency + recovery certification

## 17. Release gates

Mission 08 is not releasable until:

- full intended booking workflow works without a payment provider
- paid modes fail closed or use manual/invoice/alternative CTA as configured
- no double booking under concurrent attempts
- hold expiry/recovery is deterministic
- approval policy is enforced server-side
- provider side effects are retry-safe
- tests cover booking/payment callback idempotency
- admin and public UX include loading/error/empty states
- typecheck, lint, build, migration drift, unit/integration and E2E are green
- independent `dh-release-review` passes before merge
