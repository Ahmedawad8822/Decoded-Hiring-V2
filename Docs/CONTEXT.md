# CONTEXT — Decoded Hiring domain glossary

Canonical vocabulary for Decoded Hiring V2 (blueprint §18.2). **Domain language only**: no implementation notes. Use these words in specs, tickets, UI copy and code review.

- Lifecycle states use the **exact spelling in code** (lowercase `draft`, UPPER_SNAKE `REQUESTED`). Where code and blueprint differ, a **⚠ Conflict** note records it. Conflicts are surfaced here, not resolved.
- **(planned)** = in the blueprint, not built yet.
- If code and this file disagree, the code wins; fix this file.

Contents: [Content](#content) · [Learning](#learning) · [Commerce](#commerce) · [Scheduling](#scheduling) · [Leads](#leads-and-enquiries) · [Editorial AI](#editorial-ai) · [Providers, measurement, reliability](#providers-measurement-and-reliability) · [Surfaces and brand](#surfaces-and-brand-language)

---

## Content

### Guide
Definitive, evergreen authority article; the citation target of the site. Authored in the Studio as structured blocks (never raw HTML or Markdown).
- **States:** `draft` → `published` → `archived` (`ContentStatus`, shared with Field Note).
- **Relations:** can be the target of a Publication from an editorial Draft.
- **Not to be confused with:** Field Note (lighter, faster commentary); Lesson (taught inside a Course).

### Field Note
Short-form editorial commentary for current insight and discovery. Same lifecycle as a Guide, plus saved Revisions.
- **States:** `draft` → `published` → `archived`.
- **Not to be confused with:** Guide.

### Revision
A saved earlier version of a Field Note's content, kept so edits can be reviewed. Exists for Field Notes only.
- ⚠ **Conflict:** the blueprint expects lifecycle and history for every managed entity; Guides, Lessons and Courses have no Revisions.
- **Not to be confused with:** Booking/Order history (append-only business audit, not content versions).

### Landing Page (planned)
Campaign-specific conversion page tied to a Course, Offer or Guide, with its own slug, UTM tracking and optional noindex; archived after the campaign. Not built.
- **Not to be confused with:** Course sales page (planned; the commercial page for one Course) or Standard Page.

### Standard Page (planned)
Governed flexible page for About, legal, contact and similar information. Today these are hand-built site routes, not Studio-managed pages.

### Archive
Take an item out of public/learner navigation while keeping its data, history and relationships. Reversible.
- **Exists as a state:** `archived` on Guide, Field Note, Course, Lesson; `ARCHIVED` on Knowledge Source. An archived Course takes no new Enrollments, but existing learners keep access.
- **Not to be confused with:** Trash (soft-delete, planned) and permanent deletion.
- ⚠ **Conflict:** the blueprint defines Restore as returning an archived item to an editable state. Per `Docs/PROJECT-STATUS.md`, archived Lessons can currently be republished, and slug changes leave no redirects.

### Trash (planned)
Soft-delete: the item disappears from normal views but stays recoverable; the step before permanent deletion. Blueprint lifecycle: `DRAFT → PUBLISHED → ARCHIVED → TRASH → PERMANENTLY DELETED`. No Trash state, restore or permanent delete exists in code.

### Media
Image or file uploaded through the Studio, stored in object storage with metadata, used by editorial pages.
- **Not to be confused with:** Lesson Resource (access-controlled) or Knowledge Source (admin-only).

### Publication
Two meanings; always use the qualified name.
1. **Publishing:** moving content to `published`, making it public.
2. **Editorial Publication:** the record linking an approved editorial Draft to the Guide or Field Note created from it (one per Draft).
- At launch every public publication needs Ahmed's approval.
- **Not to be confused with:** Draft status `PUBLISHED` (the Draft's end state).

### Content Asset / Draft
- **Content Asset** (blueprint term): any piece of site content the system creates, reviews or publishes, carrying provenance of the sources behind it.
- **Draft** (code term): an AI-generated editorial candidate for a Guide or Field Note (content type `GUIDE` or `FIELD_NOTE`).
- **Draft states:** `DRAFT` → `IN_REVIEW` → `APPROVED` → `PUBLISHED`; `IN_REVIEW` → `REJECTED` → `DRAFT` (recoverable). Only `PUBLISHED` is terminal.
- ⚠ **Conflict:** no "Content Asset" entity exists in code. The closest are Draft (pre-publication) and Guide/Field Note (published).
- **Not to be confused with:** a Guide or Field Note in `draft` status (a human-authored, unpublished item). Different state machine, different spelling.

### Source Asset / Knowledge Source
- **Source Asset** (blueprint term): original material in the source library (decks, PDFs, transcripts, frameworks) the editorial agent may draw on.
- **Knowledge Source** (code term): an uploaded text or Markdown source, split into searchable chunks. Admin-only, never public.
- **States:** `UPLOADED` → `INGESTING` → `READY` or `FAILED`; `ARCHIVED`. Only `READY` sources are retrievable.
- ⚠ **Conflict:** code accepts text and Markdown only; the blueprint also lists PDFs, slide decks and transcripts.
- **Not to be confused with:** Media; Lesson Resource.

### Editorial Memory
Admin-managed standing rules injected into every generation. Categories: `POSITIONING`, `VOICE`, `AUDIENCE`, `METHODOLOGY`, `EDITORIAL_RULE`, `AVOID`, `EDITORIAL_NOTE`. Only active, non-archived items apply.

### Skill
A versioned editorial instruction set (for example Aha Authority) used when generating a Draft.

---

## Learning

### Course
Structured learning product made of Sections and Lessons. A separate course sales page (planned) is distinct from the classroom.
- **States:** `draft` → `published` → `archived` (`CourseStatus`).
- Carries a legacy Access Mode that applies until a primary Offer is linked.
- **Not to be confused with:** Offer (how it is presented and sold); Enrollment (a learner's relationship to it).

### Section
An ordered group of Lessons inside a Course; the top level of the curriculum (sections → lessons).
- ⚠ **Conflict:** the blueprint requires every managed entity to define a lifecycle; a Section has no status of its own.

### Lesson
One unit of learning content in a Section: structured text, optional video, a position, and a `required` flag that counts toward Completion.
- **States:** `draft` → `published` → `archived` (`LessonStatus`).
- **Not to be confused with:** Guide (public editorial).

### Lesson Resource
A downloadable file (for example a PDF) attached to a Lesson. Private: delivered only to learners with access.
- **Not to be confused with:** Media; Knowledge Source.

### Enrollment
A learner's access record for one Course (one per learner per Course), including how access was obtained.
- **States:** `active`, `completed`, `cancelled` (`EnrollmentStatus`). `active` and `completed` grant access; `cancelled` grants none.
- ⚠ **Conflict (open decision):** no flow sets `cancelled`, and free enrolment can reactivate it. Policy awaits Ahmed (`Docs/PROJECT-STATUS.md` §7).
- **Not to be confused with:** Order (the purchase); Booking (a scheduled session).

### Progress / Completion
- **Progress:** the Lessons a learner has marked complete within an Enrollment.
- **Completion:** all required Lessons complete; the Enrollment moves to `completed`.
- Optional (non-required) Lessons do not block Completion.

### Classroom
The learner-facing environment (`/learn`): Continue Learning, My Courses, curriculum, lesson view, resources.
- **Not to be confused with:** the public Course page, or the Studio.

---

## Commerce

### Product / Offer
- **Product** (blueprint term): anything Decoded Hiring sells or offers: Courses, Workshops/Programmes, coaching, future products.
- **Offer** (code term): the commercial and public presentation of a Product: title, slug, kind, access mode, price, call-to-action. It points at a Course or Booking Type but does not own enrolment or booking state.
- **Kind:** `COURSE`, `COACHING`, `WORKSHOP`, `PRODUCT`.
- At most one primary Offer per Course or Booking Type.
- ⚠ **Conflict:** the blueprint says "Product"; code and the Studio commerce area say "Offer", and `PRODUCT` is also one Offer kind. Treat Offer as the sellable record until the terms are reconciled.

### Access Mode
How someone obtains an Offer. Declared explicitly; nothing is assumed paid.

| Scope | Values (code spelling) |
|---|---|
| Offer | `FREE`, `PAID_ONE_TIME`, `PAID_SESSION`, `MANUAL_INVOICE`, `PAYMENT_DISABLED`, `COMING_SOON` |
| Course (legacy) | `FREE`, `PAID_ONE_TIME`, `MANUAL_INVOICE`, `PAYMENT_DISABLED` |
| Booking Type | `FREE`, `PAID_SESSION`, `MANUAL_INVOICE`, `PAYMENT_DISABLED` |

- ⚠ **Conflict:** three overlapping value sets. The blueprint's "booking-led" access and "Join Waitlist" CTA have no matching mode.
- When no payment provider is active the UI must not expose a broken checkout.

### Order
Decoded Hiring's own record of a purchase request for an Offer. Business truth lives here; a provider only supplies evidence.
- **States:** `PENDING`, `REQUIRES_ACTION`, `PAID`, `FULFILLED`, `CANCELLED`, `FAILED`, `REFUNDED`.
- `FULFILLED` is set only by Decoded Hiring after the entitlement or booking is delivered, never by a provider.
- **Not to be confused with:** Payment (evidence about the money); Enrollment (the access result).

### Payment
Provider-reported money state for an Order, recorded as append-only payment events from callbacks or webhooks.
- **States:** `PENDING`, `REQUIRES_ACTION`, `PAID`, `CANCELLED`, `FAILED`, `REFUNDED`.
- No payment provider is active; the payment gateway contract is dormant.

### Orchestration Effect
A durable, retried side effect (create checkout, fulfil order, calendar change, send mail) with one stable idempotency key.
- **States:** `PENDING`, `PROCESSING`, `SUCCEEDED`, `RETRYABLE_FAILURE`, `BLOCKED`, `TERMINAL_FAILURE`.

---

## Scheduling

### Booking Type
A bookable service definition: duration, buffers, minimum notice, horizon, timezone, weekly availability windows, meeting method, attendee limit, confirmation policy and access mode. Coaching and workshop discovery calls are Booking Types.
- **Confirmation policy:** `AUTO_CONFIRM`, `AHMED_APPROVAL`, `REQUEST_ONLY`.
- **Meeting method:** `GOOGLE_MEET`, `EXTERNAL_LINK`, `PHONE`, `IN_PERSON`, `TO_BE_CONFIRMED`.

### Slot Hold
A short-lived reservation of one canonical time slot for a single requester while they complete a booking. Expires if unused.
- **States:** `HELD` → `CONSUMED` or `RELEASED`.
- **Not to be confused with:** Booking (the requested or confirmed appointment).

### Booking
A requested or confirmed appointment for a Booking Type, with an append-only history (reschedules keep the previous slot).
- **States:** `REQUESTED`, `PENDING_APPROVAL`, `CONFIRMED`, `COMPLETED`, `CANCELLED`, `DECLINED`.
- ⚠ **Conflict:** the blueprint event list includes `booking_no_show`; there is no no-show state in code. Reschedule is a history action, not a state.
- **Not to be confused with:** Slot Hold; Enrollment.

---

## Leads and enquiries

### Lead / Enquiry
A person's interest submitted through a public form, saved durably for Studio review, with their consent choices (privacy, research, email, WhatsApp, calls). The blueprint says "enquiry/lead"; code says lead submission. Same thing.
- **Kinds:** `workshop`, `coaching`, `ai_os`, `contact`.
- **States:** `NEW` → `REVIEWED` → `CLOSED`.
- No email or CRM notification is sent while mailbox providers are dormant.
- **Not to be confused with:** Booking (a scheduled session); Order.

---

## Editorial AI

### Website Editorial Agent
Website-only agent: source → retrieve → create → review → Ahmed approves → publish. Never handles social channels; no public publication without approval at launch.
- **Not to be confused with:** Hermes + Postiz (local social loop, outside this repo); the Scheduling & Communications Agent.

### Scheduling & Communications Agent (planned)
Separate agent with narrowly scoped calendar and mailbox authority and human-approval policies. Not built.

---

## Providers, measurement and reliability

### Provider
An external system behind an adapter, in four kinds: **payment**, **calendar**, **mailbox**, **meeting**. Each reports whether it is configured and which capabilities it has. All are dormant; none is connected.
- The LLM provider for Editorial AI is a separate adapter (a fake one is used in tests).

### Business Event
A recorded business-funnel fact (for example a booking being requested), de-duplicated, with an optional subject and route.
- **Names in code:** `offer_cta_clicked`, `booking_started`, `slot_held`, `booking_requested`, `booking_approved`, `booking_confirmed`, `booking_declined`, `booking_cancelled`, `booking_rescheduled`, `checkout_started`, `payment_confirmed`, `payment_failed`.
- ⚠ **Conflict:** the blueprint §16.4 taxonomy differs (for example `payment_refunded`, `booking_completed`, `booking_no_show`, `product_unlocked`, content and learning events are not in code; `payment_confirmed`, `booking_declined` and `offer_cta_clicked` are code-only). `ANALYTICS-EVENTS.md` does not exist yet.
- **Not to be confused with:** page analytics (planned: PostHog, Zaraz, GA4).

### Insight (planned)
A measured change in the data that the Command Center surfaces, with evidence. Not built.

### Opportunity (planned)
A ranked recommended action derived from Insights: baseline metric, hypothesis, expected impact, effort, confidence, measurement window. Stored so its outcome can be evaluated later. Not built.
- **Not to be confused with:** Lead (a person).

### Incident (planned)
A detected defect or risk with severity, evidence and acceptance criteria, tracked through triage, fix, review, preview and promotion. A failed post-release health check opens one. Not built.

### Command Center (planned)
The Studio's decision layer: what is happening, why, what is at risk, what to do next. Not built.

---

## Surfaces and brand language

### Studio
The admin environment (`/admin`): content, courses, knowledge, editorial AI and the commerce/scheduling control plane. Requires the admin role.
- **Not to be confused with:** Classroom (learners) or the public site.

### Public site
The editorial, discovery- and conversion-oriented website with the Decoded Hiring identity.

### Hiring Situation Map
Public-copy framework: recruitment problems are not all the same. Four situations: **Simple Hiring**, **Difficult Mass Hiring**, **Specialist Hiring**, **Strategic Hiring**. Logic: WHY → WHAT → HOW; the tool comes after the diagnosis.
- Appears on the homepage as an interactive scenario lab. Keep public copy to the four blueprint names.

### Aha Authority
Ahmed's editorial framework and point of view, implemented as a versioned Skill rather than a one-off prompt.
