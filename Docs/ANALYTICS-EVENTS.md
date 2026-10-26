# Analytics Events

Blueprint §16.4 and §18.6. Status: **inventory of what the code records today, plus what is still missing.** Written against `main` at `b902784`. If code and this file disagree, the code wins; fix this file. Vocabulary: `Docs/CONTEXT.md`. Provider activation (PostHog, GA4, Zaraz, consent) is a pending Ahmed decision (`PROJECT-STATUS.md` §7) and is **not designed here**.

## 1. What exists

Only one mechanism: the first-party **business-event ledger**, table `business_events` (migration `0018_business_events.sql`). It is a projection for observability and the Studio commerce panel; business truth stays in `bookings`, `orders`, `*_history`. No browser analytics, tag layer, consent banner, page-view tracking or third-party script exists in `src` (the only `<script>` is JSON-LD in `src/lib/seo.tsx`), and the CSP `connect-src 'self'` would block one.

| Piece | Code |
|---|---|
| Event names and types | `src/features/analytics/types.ts` (`BUSINESS_EVENT_NAMES`) |
| Write path | `src/features/analytics/service.ts`: `recordBusinessEvent` (throws) and `recordBusinessEventBestEffort` (swallows failure, returns boolean). Production call sites use only the best-effort one |
| Public browser-to-server entry points | `src/features/analytics/public-actions.ts`: `recordPublicOfferCta`, `recordPublicBookingStarted` (server actions called from `components/products/tracked-offer-link.tsx` and `components/products/public-scheduler.tsx`) |
| Read path | `getBusinessEventSummary({ windowDays })` (default 30, clamped 1 to 365) feeds the Studio commerce read model (`features/commerce/admin.ts`, page `/admin/commerce`). `countBusinessEvents(name)` is used by tests |
| Reconstruction | `reconcileDurableBusinessEvents({ since })` re-derives events from `booking_history` and `order_history` with `INSERT OR IGNORE`; it runs inside every `getBusinessEventSummary` call |
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
| `occurred_at`, `created_at` | Unix seconds. Index on (`event_name`, `occurred_at`) |

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

## 6. Gaps against the blueprint (not built)

The blueprint's taxonomy (§16.4) versus the code. No design is proposed here.

| Blueprint group | Blueprint events | In code |
|---|---|---|
| Content | `page_view`, `guide_view`, `field_note_view`, `resource_download`, `content_share`, `related_content_click` | None |
| Conversion | `primary_cta_click`, `workshop_enquiry_started`, `workshop_enquiry_submitted`, `newsletter_signup`, `course_signup`, `login_success` | Only `offer_cta_clicked` (a narrower CTA event). Lead submissions (`lead_submissions`) are stored but emit **no** event. Sign-up, login and free enrollment emit none |
| Learning | `course_started`, `lesson_started`, `lesson_completed`, `course_completed`, `learner_returned` | None. State exists (`enrollments`, `lesson_progress`) but no events |
| Commerce | `checkout_started`, `checkout_completed`, `payment_failed`, `payment_refunded`, `product_unlocked` | `checkout_started` and `payment_failed` match. `payment_confirmed` is the code's name for `checkout_completed`. `payment_refunded` and `product_unlocked` are absent (the `REFUNDED` and `FULFILLED` order states exist) |
| Scheduling | `booking_started`, `slot_held`, `booking_requested`, `booking_approved`, `booking_confirmed`, `booking_rescheduled`, `booking_cancelled`, `booking_completed`, `booking_no_show` | All present except `booking_completed` (the `COMPLETED` status and history action exist, no event) and `booking_no_show` (no status). The code adds `booking_declined` |
| Publishing | `content_draft_created`, `content_approved`, `content_published`, `content_archived` | None as business events. Editorial draft actions are logged separately in `editorial_audit_log` |
| Reliability | `client_error`, `server_error`, `route_failure`, `upload_failure`, `auth_failure`, `broken_link_detected` | None |

Other missing pieces named by the blueprint (§16, §18.6):

- Event properties common to all events: UTM and campaign fields, referrer, anonymous or session id, consent state, content id and type. Today there is no visitor identity and no UTM capture.
- Consent policy, cookie behaviour and regional rules (`/cookies` is a static page only).
- Tag layer (Cloudflare Zaraz), PostHog, GA4, Google Ads, LinkedIn, Meta, Search Console, Bing/IndexNow, Cloudflare analytics ingestion.
- Daily aggregates and KPI definitions for the Command Center, source-of-truth ownership per metric, and the anomaly rules in §17.
- Retention: `business_events` has no pruning or archiving (unlike `public_rate_limits`).
- A conformance test that fails on unknown or near-duplicate event names (the zod enum is the only guard).

## ⚠ Divergences

1. **Naming:** code `payment_confirmed` versus blueprint `checkout_completed`; code `offer_cta_clicked` versus blueprint `primary_cta_click`; code-only `booking_declined`.
2. **Blueprint says D1 stores aggregates and raw data stays in specialist platforms.** Today D1 holds raw first-party events and nothing is aggregated.
3. **`business_events` is not in `schema.ts`:** it exists only as raw SQL in migration 0018 and raw D1 statements (`Docs/CONTENT-MODEL.md` divergence 3).
4. **Reconstructed rows lose detail:** reconstruction writes `{}` (bookings) or `{source}` (orders) metadata, whereas live rows also carry `actor_role`, `confirmation_policy`, `offer_kind`, `access_mode`, `state`. Whichever insert wins the dedupe key sets the stored metadata.
5. **Summary reads write:** `getBusinessEventSummary` runs the reconciliation inserts on every call (every Studio commerce page render), which conflicts with the "reads do not write" direction taken for learner pages in #30.
6. **`ARCHITECTURE.md` and `PERFORMANCE-BUDGET.md`** describe events as written "on order transitions"; only `checkout_started`, `payment_confirmed` and `payment_failed` are recorded, never `FULFILLED`, `CANCELLED` or `REFUNDED`.
