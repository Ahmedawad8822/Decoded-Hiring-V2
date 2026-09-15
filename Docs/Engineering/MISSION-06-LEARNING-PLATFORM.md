# Mission 06 — Learning Platform Foundation + Free Course Vertical Slice

Starting baseline: `122ea15514fa1699c0ce1b5fda399d82ef84d06c` (origin/main,
Mission 05 merge). No V1 changes. No production actions. No DNS/credential changes.

## 1. What was built

One complete production vertical slice: Studio creates a course with sections
and lessons and publishes it; a learner signs up, enrolls free, opens lessons,
downloads authorized PDFs, completes lessons, and finishes the course — with
server-authoritative progress throughout.

## 2. Data model (D1-native, Drizzle)

Migration `drizzle/migrations/0003_mission_06_learning_platform.sql`
(hand-authored SQL in the Mission 04/05 style; journal updated — drizzle-kit
could not run codegen in this environment, so `meta/0003_snapshot.json` was
not regenerated; a future `db:generate` will reconcile it):

- `courses` — id, title, slug UNIQUE, description, status
  (draft/published/archived), accessMode
  (FREE/PAID_ONE_TIME/MANUAL_INVOICE/PAYMENT_DISABLED), coverImage,
  createdAt/updatedAt/publishedAt.
- `course_sections` — id, courseId (cascade), title, position, timestamps.
- `lessons` — id, courseId (cascade), sectionId (cascade), title, slug
  (UNIQUE per course via `lessons_course_slug_unique`), body
  (JSON ContentBlock[]), videoUrl nullable, required boolean, position,
  status (draft/published/archived), timestamps.
- `lesson_resources` — id, courseId/lessonId (cascade), title, storageKey
  UNIQUE, filename, contentType, size, position.
- `enrollments` — id, userId (cascade), courseId (cascade), status
  (active/completed/cancelled), accessSource, enrolledAt, completedAt
  nullable. Uniqueness userId+courseId enforced in service + idempotent
  enroll (unique index present).
- `lesson_progress` — id, enrollmentId (cascade), lessonId (cascade),
  completedAt. Uniqueness enrollmentId+lessonId enforced in service +
  idempotent complete (unique index present).

## 3. Course lifecycle

draft → published → archived, reusing the shared `publishing/lifecycle.ts`
timestamp helpers (first-publish-wins publishedAt). Archived is terminal for
NEW enrollments; **existing enrolled learners retain access** (explicit
decision: archiving hides the sales path, it never revokes learning already
granted). No permanent delete is exposed in Mission 06 — the curriculum
danger zone renders a disabled, explained control instead.

## 4. Section/lesson ordering

Explicit integer `position` per parent scope. Admin moves entries with ↑/↓
buttons (swap positions; no drag dependency). Learner ordering derives from
section.position then lesson.position — never createdAt.

## 5. Enrollment model + FREE access behavior

- Only `FREE` + `published` courses auto-enroll, for authenticated users only.
- `enrollFree` is idempotent (existing enrollment returned; unique
  userId+courseId makes duplicates impossible, race-safe second read).
- Draft courses reject enrollment; archived courses reject NEW enrollments.
- Deferred modes return honest copy, no fake commerce:
  PAID_ONE_TIME → "checkout not available yet, contact us";
  MANUAL_INVOICE → "enrolled by manual invoice, contact us";
  PAYMENT_DISABLED → "enrollment disabled".
- No Stripe / Lemon Squeezy / card data anywhere.

## 6. Learner auth

Better Auth email/password (existing instance, existing user model).
New routes `/login` + `/signup` (Mission 04.5's dangling `/login` prefetch
now resolves to a real route). Signup collects name/email/password (min 8);
login collects email/password; success redirects to `/learn` (safe
`?redirect=` honored, same-origin only). New accounts default to `user`
(Better Auth admin plugin `defaultRole`); admin stays explicit.
Narrow `requireUser()` helper added next to `requireAdmin()`.
`/admin/login` untouched. No magic links, OAuth, reset, or verification.

## 7. Admin course management

- `/admin/courses` (Studio shell, force-dynamic): search (title/slug),
  status filter, create draft, edit basics + access mode, publish /
  unpublish / archive, per-course enrollment counts, link to curriculum.
- `/admin/courses/[courseId]/curriculum`: sections (add/rename/move),
  lessons (add/edit/move/required-toggle/publish/unpublish), completion
  counts, per-lesson PDF upload, delete-blocked danger zone.
- Lesson body reuses the shared `StructuredBlockEditor`
  (heading/paragraph/blockquote/callout/list — no `resource` blocks; lesson
  downloads are real uploaded PDFs, not inline CTAs) and
  `ContentBlockRenderer`. No new editor ecosystem, no `dangerouslySetInnerHTML`.

## 8. Progress + completion calculation

Server-authoritative (`src/features/progress/service.ts`):
percentage = completed REQUIRED PUBLISHED ÷ total REQUIRED PUBLISHED.
Optional lessons never enter the denominator; draft/unpublished lessons are
invisible to the math. `markLessonComplete` is idempotent (one row per
enrollment+lesson) and resolves ownership server-side (enrollment must
belong to the caller; lesson must belong to the enrollment's course and be
published). When all required published lessons complete,
`enrollment.completedAt` is set and status → completed. Curriculum edits
re-evaluate deterministically from the current required-published set —
historical rows are never rewritten.

Resume rule: first incomplete required published lesson in curriculum order;
completed state when none remain. Next/previous derive from the published
flat order.

## 9. Protected resource security

Public `/api/media/[...key]` is untouched and can never serve course files:
uploads mint keys under `course-resources/<course-id>/<uuid>.pdf` and only
PDF ≤ 10 MB is accepted. Admin-only `POST /api/course-resources/upload`
resolves lesson∈course server-side. `GET /api/course-resources/[resourceId]`
looks up by DB id (never a client-supplied key), requires authenticated
user AND (admin OR enrollment in the course), and serves with
`Cache-Control: private, no-store` + `X-Content-Type-Options: nosniff`.
The storage helper rejects any key outside the `course-resources/` namespace.

## 10. YouTube strategy

YouTube only: watch, youtu.be, /embed/, /shorts/, /live/, or bare 11-char
IDs. `extractYouTubeVideoId` normalizes; embeds render through the
privacy-enhanced `youtube-nocookie.com` iframe inside authorized lesson
pages only. Anything else (Vimeo, mp4, embed HTML, javascript:) is rejected
at validation. No Stream, no uploads, no DRM, no private-video claims.

## 11. Learner routes (all auth-gated, force-dynamic)

- `/learn` — Continue Learning spotlight, My courses, Completed, empty state.
- `/learn/courses` — enrolled list + discoverable published catalog.
- `/learn/courses/[courseSlug]` — overview: progress, resume, curriculum
  with completion + required/optional states; FREE enroll CTA or honest
  deferred-mode note for visitors.
- `/learn/courses/[courseSlug]/lessons/[lessonSlug]` — classroom player:
  sticky curriculum rail (desktop), course-contents drawer (mobile, React
  state), body, optional video, authorized PDF downloads, prev/next,
  server-authoritative completion, enrollment-required denial panel for
  unenrolled visitors (lesson body never leaks).
- Anonymous → `/login?redirect=/learn`. Styling reuses the approved
  prototype stylesheets single-sourced via `src/app/learn/classroom.css`
  (`@import` of `/prototypes/*.css`) — real behavior, approved visuals.

## 12. Admin / learner separation

Public site (V1 identity), Admin Studio (`/admin/*`), Learner Classroom
(`/learn/*`, `env-learner`) stay visually and structurally separate.
No public-page redesigns.

## 13. Responsive behavior

Playwright matrix (320/375/430/768/1024/1280/1440/1728) over
/login, /learn, /learn/courses, overview, lesson player asserts zero
horizontal overflow. Mobile keeps completion + prev/next in the sticky
thumb-zone bar; curriculum moves to the drawer. Verified with screenshots
(desktop rail, mobile drawer open state).

## 14. Automated tests

`tests/mission-06-learning-platform.test.ts` — 14 tests: auth-helper
rejection, course slug uniqueness, section ordering/moves, lesson ordering
+ per-course slug rule, FREE idempotency, deferred-mode rejection, draft +
  archived enrollment rules, unenrolled denial, required-only math (incl.
  4/15=27% semantics), optional exclusion, complete idempotency, completion
  timestamp, cross-user denial, draft invisibility, YouTube accept/reject
  matrix + service rejection, resource namespace boundary. Full
  `npm test`: 33/33 (Mission 04: 7, Mission 05: 12, Mission 06: 14).

## 15. Playwright lifecycle (all real, Chromium)

`e2e/mission-06-learning-platform.spec.ts` (serial, workers=1):
admin login → create FREE draft → section → 2 lessons → PDF upload →
publish lessons → publish course → enrollment CTA visible; logout → learner
signup → empty state → enroll → dashboard → lesson 1 → PDF download (200,
.pdf) → complete → progress → Next → complete → course complete 100%;
anon lesson → /login + resource 401; unenrolled learner → denial panel +
resource 403; normal user → /admin/courses → /admin/login; admin regression
(login/content render). Temporary e2e courses archived at the end.
Full `test:e2e`: 8/8.

## 16. Regressions

Guides + Field Notes unit suites pass unmodified; smoke + field-notes e2e
pass; `/admin/login`, `/admin/content`, public media serving untouched.
Review hub extended with GROUP 6 (real Mission 06 routes + seeded demo
links) — prototypes remain reference only.

## 17. Seed data (local-only)

`scripts/seed-mission-06.ts` — deterministic, idempotent, refuses hosted
envs, never auto-runs: demo course `mission-01-demo` (FREE, published),
2 sections, 2 required published lessons, 1 optional published lesson,
1 draft lesson, zero enrollments. Run: `tsx scripts/seed-mission-06.ts`.

## 18. What Mission 06 DOES NOT implement

Payments / gateways / checkout / coupons / subscriptions; corporate cohorts
/ bulk enrollment; workshops / scheduling / bookings; certificates; quizzes
/ assignments; comments / community; AI tutor; recommendations; magic links
/ OAuth / password reset / email verification; Cloudflare Stream / uploads
/ DRM; advanced analytics; permanent course delete; trash/restore;
production deployment. Deferred access modes show honest guidance instead
of fake commerce.

## 19. Quality gates (all natural, no suppression)

npm test 33/33 · test:e2e 8/8 · typecheck clean · lint zero warnings ·
build clean (learn/admin session routes force-dynamic; login/signup static).
