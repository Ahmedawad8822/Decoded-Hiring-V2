# Signed-in Worker CPU measurement

`npm run perf:sessions` prepares sessions through the deployed app's own HTTP
flows. Run it only against an authorized test environment. It signs up a learner
if sign-in fails with 401, enrolls through the public free-enrollment action, or
signs in an existing admin and configures/verifies TOTP. It does not create or
promote admins, change course policies, bypass paid access, or use D1 directly.

Provide these variables through your shell's secure credential mechanism:
`CPU_LEARNER_EMAIL`, `CPU_LEARNER_PASSWORD`, `CPU_LEARNER_NAME` (signup only),
`CPU_ADMIN_EMAIL`, `CPU_ADMIN_PASSWORD`. Inputs are never accepted as arguments.
An admin must already exist; its separate provisioning command is
`npm run admin:create -- --remote --env cputest` (uses `ADMIN_EMAIL`,
`ADMIN_PASSWORD`, optional `ADMIN_NAME`; requires separate write authorization).

Choose an existing private directory outside **all** project worktrees. For example,
set `CPU_SESSION_FILE` to an absolute path there. The tool creates/replaces the
file atomically with mode `0600`, refuses symlinks/hardlinks and overly permissive
existing files, and binds it to one origin and account per mode. Do not run two
session preparations against the same state file concurrently.

```sh
export CPU_LEARNER_EMAIL CPU_LEARNER_PASSWORD CPU_LEARNER_NAME
export CPU_ADMIN_EMAIL CPU_ADMIN_PASSWORD
npm run perf:sessions -- learner --url https://dh-cputest.hdv2.workers.dev --state "$CPU_SESSION_FILE"
npm run perf:sessions -- admin --url https://dh-cputest.hdv2.workers.dev --state "$CPU_SESSION_FILE"
npm run perf:cpu:remote -- --url https://dh-cputest.hdv2.workers.dev --sessions "$CPU_SESSION_FILE"
```

Alternatively, export the shell-quoted state assignments before measurement:

```sh
set -a
. "$CPU_SESSION_FILE"
set +a
npm run perf:cpu:remote -- --url https://dh-cputest.hdv2.workers.dev
```

Keep this file private: it contains bearer cookies and the admin's TOTP secret
and recovery codes. Recovery material is saved **before** first verification;
rerunning resumes interrupted setup without rotating it. Later runs sign in and
answer the 2FA challenge using the saved secret. Losing the file requires the
account's normal recovery process; the tool never consumes backup codes. Keep
the machine clock synchronized. Use a dedicated test admin, since enabling 2FA
changes its future login requirements. Neither tool prints credentials or bodies.

The session tool requires HTTPS (only `http://localhost` is exempt), refuses the
configured production host from `wrangler.jsonc` `env.production.vars`, and never
follows HTTP redirects. HTTP 429 stops immediately with no automatic retry; the
auth rules allow five credential/verification requests per minute per IP/path.
The measurement command remains GET-only; preparing sessions performs mutations.

## HTTP contracts and enrollment

Installed Better Auth sources define POST `/api/auth/sign-in/email` (`email`,
`password`), `/api/auth/sign-up/email` (`email`, `password`, `name`) in
`node_modules/better-auth/dist/api/routes/sign-in.mjs` and `sign-up.mjs`.
`api/middlewares/origin-check.mjs` requires a trusted `Origin` for cookie-bearing
mutations; the tool sends the exact target origin and retains response cookies.
`plugins/two-factor/index.mjs` defines `/two-factor/enable` (`password`,
`method: totp`); `plugins/two-factor/totp/index.mjs` defines `/two-factor/verify-totp`
(`code`, `trustDevice: false`). The API prefix is mounted by
`src/app/api/auth/[...all]/route.ts`. Initial verification can return the old user
flag, so the tool confirms the rotated session with GET `/api/auth/get-session`.

TOTP uses Node's HMAC implementation, decoded Base32 provisioning secrets and
RFC 6238 counters. All Appendix B SHA-1/SHA-256/SHA-512 vectors are tested:
<https://www.rfc-editor.org/rfc/rfc6238#appendix-B>.

`src/components/learner/enroll-button.tsx` calls `enrollFreeAction` in
`src/features/enrollments/actions.ts`. It authenticates with `requireUser` and
calls `enrollFree` in `service.ts`, which only grants published, available,
effectively FREE courses and is idempotent. The tool reads `/learn/courses`,
discovers the action ID from the course's deployed JS bundle and the course ID
from its inline Flight props, then posts the same action. It verifies that a
published lesson link becomes accessible, and skips courses already accessible.
No stable public REST enrollment endpoint exists. Discovery deliberately fails
closed if Next's bundle/Flight format changes. Courses with no published lessons
or arranged/paid access fail preparation instead of claiming ready measurements.
For non-free courses, arrange only the test learner's entitlement through the
existing owner-operated commerce/order fulfillment workflow
(`src/features/commerce/admin-actions.ts`, `recordManualPaymentAdminAction`, with
`requireAdmin`; fulfillment writes course enrollment in
`src/features/commerce/orders.ts`, `fulfillPaidOrderFromOrchestration`); do not promote the
learner or edit the course's pricing/access policy for a CPU probe.

## Auth response caching

The auth route sets `Cache-Control: private, no-store` on every response,
including Set-Cookie responses, without merging multiple Set-Cookie headers.
Worker HTTP tests pin that auth responses and protected admin pages are never
served from the shared cache.

A static `/admin/login` (client-side session check) was tried on 2026-11-09 and
reverted: it saved ~4 ms locally on a rarely used page but broke the Mission 06
admin e2e flow. The admin layout keeps `force-dynamic`.

## Edge baseline (dh-cputest, 2026-11-09, main @ 412f202)

12 requests per route, 300 ms apart; CPU from `wrangler tail` (5–8 sampled
events per route). Every sampled outcome was `ok`; no HTTP 1102.

| Route | CPU p50 ms | CPU max ms |
| --- | ---: | ---: |
| `/learn` | 18 | 24 |
| `/learn/courses` | 19 | 30 |
| `/learn/courses/[slug]` | 27 | 33 |
| lesson page | 24 | 84 |
| `/admin/content` | 21 | 29 |
| `/admin/courses` | 19 | 21 |
| `/admin/leads` | 16 | 18 |
| `/admin/commerce` | 35 | 44 |
| `/admin/editorial` | 13 | 87 |
| `GET /api/auth/get-session` | 9 | 9 |
| `/admin/login` | 12 | 69 |
| cached public pages | 2–5 | 6 |

Signed-in pages exceed the Free plan's nominal 10 ms but completed within
Cloudflare's burst allowance at this traffic level. Re-run after changes that
touch auth, D1 queries or the learner/admin layouts, and watch
`npm run edge:health` for `exceededResources` once real users arrive.
