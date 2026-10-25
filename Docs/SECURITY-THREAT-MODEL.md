# Security threat model

Blueprint §8 (security), §17.4 (high-risk changes), §18.6 (repository knowledge contract). Status: **living document**, written against `main` at 0347047. A control is listed only if it was found in code; everything else is a gap. If code and this file disagree, the code wins; fix this file.

## 1. Assets

| Asset | Where it lives | Sensitivity |
|---|---|---|
| Learner accounts, sessions, password hashes | D1 `user`, `session`, `account`, `verification` (Better Auth) | High |
| Admin accounts (`role: admin`) | Same tables | Critical: can publish, upload, run commerce operations |
| Private course resources (PDFs) | R2 `MEDIA_BUCKET`, keys `course-resources/<courseId>/<uuid>.pdf`; D1 `lesson_resources` | High |
| Knowledge sources (text/Markdown) | R2 private object plus D1 `knowledge_sources`, `knowledge_chunks` | High (admin-only) |
| Public editorial media | R2 `guides/`, `field-notes/`; D1 `media` | Low (public by design) |
| Lead and booking PII (name, email, notes) | D1 `lead_submissions`, `bookings`, `booking_history`, `slot_holds` | High |
| Orders and payment state | D1 `orders`, `order_history`, `payment_events`, `orchestration_*` | High (no live payment provider yet) |
| Enrolments and progress | D1 `enrollments`, `lesson_progress` | Medium |
| Editorial AI memory, drafts, audit log | D1 `editorial_*` | Medium |
| Business events | D1 `business_events` (no PII by design) | Low |
| Auth secret | `BETTER_AUTH_SECRET` (Worker secret / env) | Critical |
| LLM provider key | `EDITORIAL_MODEL_API_KEY` env (read in `editorial-ai/providers/index.ts`) | High (cost) |
| Payment, calendar, mailbox credentials | **Future.** Only contracts exist (`src/features/scheduling/providers.ts`); nothing stored | Critical once added |

## 2. Actors and trust boundaries

```
 Anonymous / Learner / Admin browser
            |  HTTPS
            v
 Cloudflare edge (TLS, DDoS; no WAF/Turnstile rules in this repo)
            |
            v
 Worker (OpenNext, Next 16.4)    <== trust boundary: all input is untrusted
   |-----------|------------|-------------------|
   v           v            v                   v
  D1 (DB)   R2 MEDIA     R2 NEXT_INC_CACHE   LLM provider (OpenAI-compatible HTTPS)
                                              + future payment/calendar/mailbox
```

| Actor | Trust | Notes |
|---|---|---|
| Anonymous visitor | None | Public pages, lead/booking/analytics actions, sign-in/up, `GET /api/media/*` |
| Learner (`role: user`) | Low | `/learn/*`, enrol/progress actions, enrolled resource download |
| Admin (`role: admin`) | High | `/admin/*`, all upload routes, all admin actions |
| Cloudflare edge | Trusted platform | Supplies `cf-connecting-ip` |
| Worker code | Ours | Resolves bindings per request (`src/lib/cloudflare/bindings.ts`) |
| D1 / R2 | Trusted stores | Reached only via `src/lib` and `src/features` |
| LLM provider | Semi-trusted | Output is untrusted text; becomes a draft a human must approve |
| Future providers | Not integrated | Fail closed when unconfigured |

## 3. Attack surfaces

### 3.1 Route handlers (`src/app/api`)

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/api/auth/[...all]` | GET, POST | Better Auth | Sign-in/up, session, admin plugin. D1 rate limited |
| `/api/media/[...key]` | GET | None | Only `guides/` and `field-notes/` keys; `public, max-age=31536000, immutable` |
| `/api/media/upload` | POST | `requireAdmin` | Images, 5 MB, magic bytes |
| `/api/course-resources/upload` | POST | `requireAdmin` | PDF, 10 MB, magic bytes |
| `/api/course-resources/[resourceId]` | GET | Session plus enrolment or admin | `private, no-store`, attachment |
| `/api/editorial-ai/knowledge/upload` | POST | `requireAdmin` | text/plain, text/markdown, 2 MB |
| `/api/og` | GET | None | Static card, no user input |

### 3.2 Server actions (`"use server"`)

| Group | Files | Gate |
|---|---|---|
| Admin content | `guides`, `field-notes`, `courses` `actions.ts` | `requireAdmin()` in every exported action (5/5, 6/6, 13/13) |
| Admin editorial AI | `editorial-ai/{drafts,knowledge,memory}/actions.ts` | `requireAdmin()` in every action (8/8, 4/4, 4/4) |
| Admin commerce | `commerce/admin-actions.ts` | Guard injected: `createCommerceAdminOperations(requireAdmin)`; not called inline (covered by `tests/mission-08-studio-commerce.test.ts`, not re-verified line by line) |
| Learner | `enrollments/actions.ts`, `progress/actions.ts` | `requireUser()` |
| Public | `leads/actions.ts` (`submitLead`), `scheduling/public-actions.ts` (`submitPublicBooking`), `analytics/public-actions.ts` | None; Zod validation plus D1 rate limits |

Page gates: `requireAdminPage()` on admin pages (redirect), session redirect in `src/app/learn/layout.tsx`. `admin/layout.tsx` is intentionally not the gate (`/admin/login` lives under it). There is no `middleware`/`proxy` file.

## 4. Threats and current controls

| # | Surface | Threat (STRIDE) | Current control | Where |
|---|---|---|---|---|
| T1 | Auth endpoints | Brute force, credential stuffing (S) | Per-IP-per-path fixed window on D1: sign-in/up 5/min, password flows 5/min, default 120/min; `/get-session` unthrottled; bucket key SHA-256 hashed | `src/lib/auth/rate-limit.ts`, `features/public-intake/rate-limit.ts` |
| T2 | Auth | Weak/missing secret (S) | `resolveAuthSecret()` throws without `BETTER_AUTH_SECRET`, all environments; no committed fallback | `src/lib/auth/index.ts` |
| T3 | Auth | Limiter disabled in prod (T) | `DH_AUTH_RATE_LIMIT_DISABLED` ignored when `NODE_ENV=production` | `rate-limit.ts` |
| T4 | Login redirect | Open redirect (T) | `safeRedirectPath()` rejects `//`, backslash, control characters, off-origin | `src/lib/safe-redirect.ts` |
| T5 | Admin actions/routes | Privilege escalation, IDOR (E) | Server-side role check on every admin action and upload route; role never taken from input | `requireAdmin`, `requireAdminPage`; `tests/auth-gates.test.ts` |
| T6 | Learner resources | Unauthorised PDF download (I) | Session; admin, or active enrolment plus lesson `published`; unpublished gives 404 (no existence leak); `no-store`; `nosniff`; filename sanitised | `api/course-resources/[resourceId]/route.ts`, `lib/course-resources/access.ts` |
| T7 | Public media route | Private R2 object served publicly (I) | `getMedia()` allows only `guides`/`field-notes`, regex key check, no `..` | `lib/media/service.ts` |
| T8 | Uploads | Hostile file, XSS via SVG (T) | Media: MIME allowlist (jpeg/png/webp/avif/gif, no SVG) plus magic-byte sniffing that must match the declared type; the sniffed type is stored. PDF: `%PDF-` magic check. Knowledge: text/markdown only. Server-minted UUID keys, sanitised filename | `lib/media/service.ts`, `lib/uploads/sniff.ts`, `lib/course-resources/service.ts`, `knowledge/storage.ts` |
| T9 | Uploads | Memory exhaustion (D) | Three layers: Content-Length plus 256 KiB envelope, `File.size`, service `byteLength` | `lib/upload-limits.ts`, upload routes |
| T10 | Uploads | Orphaned R2 object (R) | Best-effort `bucket.delete` when the D1 insert fails | `uploadMedia` |
| T11 | All actions/routes | Internal detail leak (I) | `AppError` message is user-safe; any other error is logged and replaced by a fallback; actions return `ActionResult` instead of throwing | `src/lib/errors.ts`, `src/lib/action-result.ts` |
| T12 | Public intake | Spam, flooding (D) | Atomic D1 upsert limits: leads 5 per email and 40 per kind per 15 min; bookings 3 per email and 8 per booking type per 15 min; analytics 50 global per 15 min; honeypot `website`; lead idempotency key | `leads/service.ts`, `scheduling/public-scheduling.ts`, `analytics/types.ts`, `leads/actions.ts` |
| T13 | Bookings | Double booking, races (T) | Overlap trigger (migration 0012), slot holds with CSPRNG tokens, conditional-WHERE state transitions | `drizzle/migrations/0012_*`, `scheduling/holds.ts`, `bookings.ts` |
| T14 | Orders | Replayed/duplicate effects (T, R) | Orchestration effects keyed by idempotency key; provider calls fail closed while unconfigured | `commerce/orchestration.ts`, `scheduling/providers.ts` |
| T15 | Browser | Clickjacking, sniffing, referrer leak, downgrade | `X-Frame-Options: SAMEORIGIN`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP `same-origin`, HSTS 2 years with preload; `poweredByHeader: false` | `next.config.ts` |
| T16 | Analytics | PII in event metadata (I) | Metadata keys matching email, name, phone, note, message, etc. are rejected | `analytics/service.ts` |
| T17 | Editorial AI | Prompt injection, unreviewed publish (T) | Provider fail-closed without config; drafts need `IN_REVIEW` then `APPROVED` by an admin; audit log of key steps | `editorial-ai/providers/index.ts`, `drafts/`, `audit/service.ts` |
| T18 | CI | Real secrets exposed (I) | CI uses clearly fake values and local Miniflare only | `.github/workflows/ci.yml` |
| T19 | Test seams | Test hooks active in prod (E) | `DH_COMMERCE_TEST_SEAM`, `DH_BOOKING_LIFECYCLE_TEST_SEAM`, `DH_LEADS_TEST_SEAM` are opt-in env flags; `setD1DatabaseForTest` is never set by production code | `commerce/orders.ts`, `scheduling/bookings.ts`, `leads/service.ts`, `bindings.ts` |

Regression tests: `tests/{auth-gates,auth-rate-limit,mission-06-security-hardening,security-quick-fixes,foundation-remediation}.test.ts` and `tests/mission-08-*`.

## 5. Gaps (backlog candidates)

| ID | Gap | Risk | Blueprint |
|---|---|---|---|
| G1 | **No Content-Security-Policy** (being added separately) | Larger XSS blast radius | §8 Browser |
| G2 | **Turnstile not wired** on lead, booking, sign-up, sign-in | Bots beyond D1 limits | §8 Edge |
| G3 | **No 2FA/passkeys for admin**; no short-session or re-auth for destructive actions | Admin takeover is the highest-impact event | §8 Identity |
| G4 | **Audit coverage is partial.** `editorial_audit_log` covers editorial actions; orders and bookings have history tables. Guide, Field Note, Course, Lesson, media, offer and booking-type admin mutations have no uniform audit trail (editorial audit writes are best-effort and can be lost) | Weak accountability | §8 Admin |
| G5 | **`public_rate_limits` is never pruned** (no delete path in `src` or `scripts`). Grows with every distinct email/IP fingerprint | D1 storage and write budget | §18.9 |
| G6 | ~~**Public intake limits are not per-IP.**~~ Fixed: salted per-IP buckets (`PUBLIC_IP_LIMITS`) are checked before the shared counters. Residual risk: an attacker rotating many IPs can still drain the shared budget. Leads and bookings key on an email fingerprint plus a global burst counter; analytics uses one global counter. An attacker can exhaust the shared budget (40 leads per kind, 50 analytics events per 15 min) and block real visitors | Intake denial of service | §8 Edge |
| G7 | Auth limiter trusts `cf-connecting-ip`, then `x-forwarded-for`; safe behind Cloudflare, spoofable if the Worker is reachable otherwise (unverified in production) | Limiter bypass | |
| G8 | No explicit CSRF/origin test; relies on Better Auth and Next server-action defaults (unverified) | CSRF | §8 Browser |
| G9 | `requireEmailVerification: false`; no password policy beyond Better Auth defaults (unverified) | Fake sign-ups, weak passwords | |
| G10 | Course PDFs stream through the Worker; no short-lived signed URLs or watermarking | Cost, sharing | §8 Private resources |
| G11 | ~~Image upload trusts client-declared MIME (no magic-byte check as for PDFs)~~ Fixed: `lib/uploads/sniff.ts` | Mislabelled/polyglot file | §8 Input |
| G12 | No hotlink resistance on `/api/media`; no bot controls | Bandwidth, scraping | §8 Content theft |
| G13 | Provider credential storage, rotation and revocation design not specified | Needed before payments/calendar | §8 Commerce |
| G14 | Single flat `admin` role; no editor vs commerce-operator split | Least privilege | §8 |
| G15 | No security alerting; `console.error` only | Slow detection | §17 |
| G16 | No dependency or secret scanning (Dependabot, CodeQL, `npm audit`) in `ci.yml` | Supply chain | |

## 6. High-risk change list (blueprint §17.4)

Never self-promote to production. **Ahmed approval is required** for changes touching:

- authentication or sessions (`src/lib/auth/*`, `/api/auth`);
- authorization and admin permissions (`requireAdmin`, `requireAdminPage`, `requireUser`, `lib/course-resources/access.ts`, role changes);
- payments and orders (`features/commerce/*`, provider adapters, webhooks, refunds);
- database schema or data deletion (`drizzle/migrations/*`, `src/lib/db/schema.ts`, any `DELETE`, permanent deletion);
- security controls (`next.config.ts` headers/CSP, rate limits, upload validation, `safe-redirect`, public media allowlist);
- secrets and provider credentials (`wrangler.jsonc` vars and secrets, `.env*`, `EDITORIAL_MODEL_*`);
- destructive operations (archive/delete/overwrite, `db:migrate:remote`, `deploy`).

Approval-gated at launch (§8): refunds, unusual payment actions, moving or cancelling existing personal calendar events, changing booking policies, changing provider credentials, non-template correspondence outside the booking workflow.
