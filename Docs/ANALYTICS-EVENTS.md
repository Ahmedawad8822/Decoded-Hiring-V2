# Analytics Events

Inventory of events recorded by the current implementation. Code takes precedence. No external analytics provider is active.

## 1. What exists

Only one mechanism: the first-party **business-event ledger**, table `business_events` (migration `0018_business_events.sql`; Drizzle table `businessEvents` in `schema.ts`). It is a projection for observability and the Studio commerce panel; business truth stays in `bookings`, `orders`, `*_history`. No browser analytics, tag layer, consent banner, page-view tracking or third-party script exists in `src` (the only `<script>` is JSON-LD in `src/lib/seo.tsx`), and the CSP `connect-src 'self'` would block one.

| Piece | Code |
|---|---|
| Event names and types | `src/features/analytics/types.ts` (`BUSINESS_EVENT_NAMES`) |
| Write path | `src/features/analytics/service.ts`: `recordBusinessEvent` (throws) and `recordBusinessEventBestEffort` (swallows failure, returns boolean). Production call sites use only the best-effort one |
| Public browser-to-server entry points | `src/features/analytics/public-actions.ts`: `recordPublicOfferCta`, `recordPublicBookingStarted` (server actions called from `components/products/tracked-offer-link.tsx` and `components/products/public-scheduler.tsx`) |
| Read path | `getBusinessEventSummary({ windowDays })` (default 30, clamped 1 to 365) feeds the Studio commerce read model (`features/commerce/admin.ts`, page `/admin/commerce`). `countBusinessEvents(name)` is used by tests |
| Reconstruction | `reconcileDurableBusinessEvents({ since })` re-derives events from `booking_history` and `order_history` with `INSERT OR IGNORE`; it is **not** run by reads. It is called from the booking/order event helpers only when the live write failed (recent 2-day window), and by the admin action `reconcileBusinessEventsAdminAction` (`commerce/admin-actions.ts`). `since` is clamped to the retention horizon |
| Tests | `tests/mission-08-observability.test.ts` |

## 2. Storage

| Column | Meaning |
|---|---|
| `id` | `bev_<18 hex>`; reconstructed rows use `bev_recon_<historyId>...` |
| `dedupe_key` | **Unique.** `INSERT OR IGNORE` makes every write idempotent (see section 4) |
| `event_name` | One of the 12 names below. Unknown names are rejected by zod and ignored when summarising |
| `subject_type`, `subject_id` | `OFFER`, `BOOKING_TYPE`, `BOOKING`, `ORDER`, `PUBLIC` and its id |
| `offer_id`, `booking_type_id`, `booking_id`, `order_id` | Denormalised links (indexed except `booking_type_id`) |
| `route`, `surface` | Page and UI placement (max 180 and 120 chars) |
| `metadata` | JSON text, default `{}`. Values are string (max 80), number, boolean or null |
| `occurred_at`, `created_at` | Unix seconds. Indexes on (`event_name`, `occurred_at`) and on `occurred_at` alone (migration 0023, serves pruning) |

Privacy guard (`safeMetadata`): a metadata **key** matching `email|name|phone|note|answer|message|description|reason|candidate|company|title|text|content` (case-insensitive) throws. Rows carry ids only; no email, IP or free text. Guard only checks keys, so a value under an innocent key is not inspected.

## 3. Event inventory

| Event | Trigger (code) | Subject | Properties (`metadata` plus columns) | Reconstructible |
|---|---|---|---|---|
| `offer_cta_clicked` | Click on a tracked offer link on `/coaching` or `/workshop`: `recordPublicOfferCta` | `OFFER` | route (`/coaching` or `/workshop`), surface (`hero-primary`, `hero-secondary`, `inline`); metadata `target` (`schedule`, `lead`, `contact`, `checkout`), `offer_kind`, `access_mode`; `offer_id`, `booking_type_id` | No |
| `booking_started` | First interaction with the public scheduler form (once per page load): `recordPublicBookingStarted` | `BOOKING_TYPE` | route, surface `public-scheduler`; metadata `offer_kind`, `access_mode`; offer and booking type ids | No |
| `slot_held` | A public slot hold is acquired, before the booking request is created (`scheduling/public-actions.ts`) | `BOOKING_TYPE` | route, surface `public-scheduler`; metadata `offer_kind`, `offer_slug` | No |
| `booking_requested` | Booking row created (`createBookingRequest`, `scheduling/bookings.ts`) | `BOOKING` | metadata `confirmation_policy`, `initial_status` | Yes (history action `REQUESTED`) |
| `booking_approved` | Admin approves (`APPROVED` confirm path) | `BOOKING` | metadata `actor_role` | Yes |
| `booking_confirmed` | Booking reaches `CONFIRMED` (auto, approved, or explicit confirm) | `BOOKING` | metadata `confirmation_action`, `actor_role` | Yes |
| `booking_declined` | Transition to `DECLINED` | `BOOKING` | metadata `actor_role` | Yes |
| `booking_cancelled` | Transition to `CANCELLED` | `BOOKING` | metadata `actor_role` | Yes |
| `booking_rescheduled` | Reschedule of a `CONFIRMED` booking | `BOOKING` | metadata `actor_role` | Yes |
| `checkout_started` | Order row created (`createOrder`, `commerce/orders.ts`), source `order_created` | `ORDER` | metadata `source`, `offer_kind`, `access_mode`, `state`; offer, booking type, booking, order ids | Yes (first `order_history` row, `PENDING`) |
| `payment_confirmed` | Order reaches `PAID` via callback, webhook, system or `admin_manual` | `ORDER` | metadata `source` (lower-case), `offer_kind`, `access_mode`, `state` | Yes (`to_status = PAID`, metadata `{source}` only) |
| `payment_failed` | Order reaches `FAILED` | `ORDER` | as `payment_confirmed` | Yes (`to_status = FAILED`) |

Booking events fire only when the committed row matches the intended `version` and `transitionKey` (a lost race records nothing). Because providers are dormant, `checkout_started` and `payment_confirmed` currently occur only through orders created in tests or by the admin manual-payment path.

## 4. Dedupe keys

| Event group | Key pattern |
|---|---|
| `offer_cta_clicked` | `public-cta:<eventKey>` (client `crypto.randomUUID()` per click) |
| `booking_started` | `public-booking:<eventKey>:started` (`eventKey` = the form's `requestKey`) |
| `slot_held` | `public-slot:<acquisitionKey>:held` |
| Booking lifecycle | `booking-history:<booking_history.id>:<event_name>` |
| Order lifecycle | `order-history:<order_history.id>:<event_name>` |

Live writes and reconciliation use the **same** history-based keys, so a reconstructed row can never duplicate a live one. The three public events have no history source and are lost if their write fails or is rate-limited.

## 5. Rate limits and abuse controls

Applies to the two browser-triggered events (`offer_cta_clicked`, `booking_started`); `slot_held` is already behind the booking admission limits. Order in `admitPublicAnalytics` (`public-actions.ts`):

| Step | Limit | Scope key |
|---|---|---|
| 1. Validate | `eventKey` must be a UUID; the offer must be active and its kind must match the route (`COACHING` on `/coaching`, `WORKSHOP` on `/workshop`) and, for `booking_started`, its booking type; mismatches return silently | n/a |
| 2. Per-IP bucket | **20 per 15 min** per salted client-IP hash (`ip:analytics:<hash>`, `PUBLIC_IP_LIMITS.analytics`); skipped when no request context | `public_rate_limits` |
| 3. Shared budget | **50 per 15 min**, all visitors (`analytics:public-funnel`, `PUBLIC_ANALYTICS_BUDGET`), sized so analytics cannot exhaust the D1 write allowance | `public_rate_limits` |

An over-limit event is dropped with no error to the visitor. IP hashing: SHA-256 salted with `BETTER_AUTH_SECRET`; raw IPs are never stored (`public-intake/rate-limit.ts`). Each admitted public event costs about 2 to 3 D1 writes (limit counters plus the insert).

## 6. Limitations

D1 stores raw first-party business events; no external analytics transport or
consent layer is active. The retention default is 400 days with bounded pruning
(500 rows per pass, sampled on successful writes). Review retention and consent
before activating external analytics. Order events currently cover checkout
start, payment confirmation and payment failure, not every order transition.
