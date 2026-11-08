# Deployment — Cloudflare Workers via OpenNext

Status: **prepared, not deployed.** Nothing in this repo has been provisioned on
Cloudflare. Every production value in `wrangler.jsonc → env.production` is a
`<PLACEHOLDER>`.

## How it fits together

| Piece | What it does |
|---|---|
| `@opennextjs/cloudflare` (pinned **1.20.15**) | Turns the `next build` output into a Worker (`.open-next/worker.js`) plus static assets (`.open-next/assets`). We run Next 16.4.3 and wrangler 4.156.0. |
| `open-next.config.ts` | `enableCacheInterception: true` serves ISR/SSG hits in the routing layer after rewrites, bypassing server actions and draft-mode cookies. R2 incremental cache (`NEXT_INC_CACHE_R2_BUCKET`) uses our render-timestamp wrapper so an old render uploaded after a mutation cannot undo its invalidation. D1 persists tag expiry (`NEXT_TAG_CACHE_D1`, same database as `DB`); without it, `revalidatePath()`/`revalidateTag()` would do nothing on Workers. OpenNext population creates its own `revalidations` table; it is not a Drizzle migration. See [cache race analysis](CACHE-INTERCEPTION.md). |
| `src/lib/cloudflare/bindings.ts` | On Workers, bindings come from `getCloudflareContext().env`. In local Node (`next dev`, `next build`, tests, scripts), it falls back to wrangler's `getPlatformProxy` with persist path `DH_LOCAL_STATE_DIR` or `.wrangler/state/v3`. wrangler is imported with a computed specifier, so it is never bundled. |
| `wrangler.jsonc` | Top level = **local** config (dev, tests, `npm run preview`). `env.production` = real resources (placeholders). Bindings: `DB` (D1), `MEDIA_BUCKET` (R2), `NEXT_INC_CACHE_R2_BUCKET` (R2), `WORKER_SELF_REFERENCE` (service), `ASSETS`. |

## Scripts

| Script | Use |
|---|---|
| `npm run cf:build` | OpenNext build (runs `next build` first). Needs `BETTER_AUTH_SECRET` set and a migrated local DB (`npm run db:migrate:local`), because `/guides` and `/field-notes` prerender from D1. |
| `npm run cf:size` | Runs `wrangler deploy --dry-run` (no credentials), parses the uncompressed `Total Upload` size and fails above `WORKER_UNCOMPRESSED_BUDGET_KIB` (default 20480 KiB / 20 MiB; Free and Paid limit 64 MiB). Gzip is printed for information only. Run after `cf:build`. Runs in CI as the `worker-size` job. |
| `npm run preview` | Build, then run the real Worker locally in `wrangler dev` against local D1/R2. Put local-only secrets in `.dev.vars` (git-ignored), e.g. `BETTER_AUTH_SECRET=...`. |
| `npm run test:e2e:worker` | Builds and tests the real local Worker with cache interception; fresh disposable D1/R2 and test-only admin credentials. See below. |
| `npm run db:migrate:remote` | `wrangler d1 migrations apply DB --env production --remote` |
| `npm run deploy` | Build and deploy with `--env production`. **Fails until the placeholders are filled.** |

## Worker cache regression suite

Run `npm run test:e2e:worker` (Chromium installed via `npx playwright install chromium`).
Use `E2E_WORKER_PORT=3151 npm run test:e2e:worker` if the default loopback port
3107 is occupied. An existing server is never reused. Playwright arguments can
be appended, e.g. `npm run test:e2e:worker -- --headed`.

`playwright.worker.config.ts` starts `scripts/worker-e2e-server.ts`, which reuses
`e2e-bootstrap.ts`, the baseline guide seed and OpenNext's pinned cache population
implementation. It runs `opennextjs-cloudflare build`, populates R2 and the D1 tag
table, then runs `wrangler dev --local`. The generated config copies
`wrangler.preview.jsonc`, including its self-reference service. A fresh OS temp
directory holds `.dev.vars` (random auth secret, fixture origin and
`ADMIN_REQUIRE_2FA=false`), Wrangler config/logs and `.wrangler/state`.
`DH_LOCAL_STATE_DIR` points to that directory's `state/v3`; `--persist-to` points
to `state`. OpenNext cache population runs from that same temp cwd, since it
has no persistence-path option. The harness stops the Worker and deletes the
temp directory on completion/interruption; it never uses the developer's
`.wrangler/state` or credentials. It rebuilds `.next`/`.open-next`, so do not run
another build or dev server in this worktree concurrently.

The suite checks routing-layer `x-opennext-cache: HIT`, security headers and
HEAD, real Studio guide/field-note actions (publish, edit, rename, unpublish,
archive), authenticated and anonymous draft preview, Link/RSC navigation,
contact lead persistence and the coaching shell's live slots. Mutation checks
assert the **first** subsequent GET; only cache-write preconditions poll.
Failures retain screenshots/traces in `test-results/worker`.

HTTP-only: `npm run test:e2e:worker:http`. This launches no browser. The final
clean build passed **4/4** (42.8 s including setup), covering headers/HEAD,
HTML/RSC, preview rewrites, live slots, both article lifecycles, and first-GET
commerce freshness on all four public offer pages.

`npm run test:e2e:worker:race` adds 750 ms latency before cache writes, forcing
a pre-mutation render's upload to finish after tag expiry. Strict first-GET
lifecycle/commerce checks passed with this latency on and off. For the off A/B,
use `WORKER_E2E_INTERCEPTION_OFF=1 npm run test:e2e:worker:race`; the default
guard still requires interception on. `WORKER_E2E_ORIGINAL_R2=1` selects the
unwrapped baseline in this disposable harness; with latency it reproduces the
stale 404/index failure. These options only generate a temporary local config.
See [source citations, reproduction and results](CACHE-INTERCEPTION.md).

Chromium cannot launch in this sandbox (`bootstrap_check_in …
MachPortRendezvousServer`, `Permission denied (1100)`). The coordinator's earlier
browser run exposed the late-upload race fixed here; the five browser tests
still need rerunning on the final code outside the sandbox before merge.
Worker shutdown and throwaway-state removal were verified after HTTP runs.

## Verified locally (2026-10-24)

- `npm run cf:build`: OpenNext build complete.
- `wrangler deploy --dry-run`: total upload **12.57 MiB, 2.82 MiB gzipped** (Next 16.4.2, adapter 1.20.12).
- `opennextjs-cloudflare preview` (built Worker in `wrangler dev`):
  - 200 on `/`, `/guides`, `/field-notes`, `/coaching`, `/workshop`, `/admin/login` and `/sitemap.xml` (dynamic, reads D1).
  - `/learn` redirects anonymous users to `/login`.
  - `/api/auth/get-session` returns `null` when anonymous.
  - Email sign-up wrote to D1, and the session cookie then opened `/learn`.
  - `/_next/image` returns the original WebP (no `IMAGES` binding, so no resizing).

## First deploy checklist (needs Ahmed's decisions)

1. **Account and plan.** Choose the Cloudflare account. See the risks below about script size, startup time and request CPU limits.
2. **Provision:**
   - `wrangler d1 create <name>`
   - `wrangler r2 bucket create <media>`
   - `wrangler r2 bucket create <next-cache>`

   Put the names and the D1 id into `env.production`.
3. **Secrets:**
   - `wrangler secret put BETTER_AUTH_SECRET --env production` (32+ random characters)
   - provider secrets later, when providers are activated
4. **Vars:** set `BETTER_AUTH_URL` and `NEXT_PUBLIC_SITE_URL` to the real origin. **Do not set `ADMIN_REQUIRE_2FA` in production.** Admin TOTP 2FA is enforced unless that variable is exactly `false`; it is `false` only in `.env.example` (local dev) and the Playwright web server (CI/e2e). An admin without 2FA is redirected to `/admin/security` (pages) or rejected (actions) until they enroll.
5. **Migrations:** `npm run db:migrate:remote`.
6. **Admin account:** create the first admin in remote D1 with the script (credentials come from the environment, never argv; password at least 12 characters; idempotent, an existing email is only promoted unless `--reset-password` is added):

   ```bash
   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<12+ chars>' ADMIN_NAME='Your Name' \
     npm run admin:create -- --remote --env production
   ```

   `--remote` without `--env` is refused. Without flags it targets local D1 (honours `DH_LOCAL_STATE_DIR`). Run it after step 5, then sign in at `/admin/login`. The first sign-in lands on `/admin/security`: enroll an authenticator app and save the backup codes before anything else works. Lost-device recovery: a backup code, or, with D1 access, delete the user's row in `two_factor` and set `user.two_factor_enabled = 0` (they re-enroll on next sign-in).
7. **Deploy:** `npm run deploy`. Prefer a staging environment first (`env.staging`, same shape).
8. **Domain:** add a custom domain or route in Cloudflare. DNS cutover from V1 is a Phase 8 launch step.

## Risks and open decisions

- **Script size.** Workers Free and Paid both allow **64 MiB uncompressed** (65536 KiB); there is no compressed size limit. Per the [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/) updated 2026-10-29. The historical 12.57 MiB total upload above uses about 20% of that limit; its 2.82 MiB gzip size is informational. CI enforces an early-growth budget of **20480 KiB (20 MiB) uncompressed** (`npm run cf:size`, override `WORKER_UNCOMPRESSED_BUDGET_KIB`). It parses wrangler's `Total Upload` line, so a format change fails loudly (exit 2). The script warns above 90% of the platform's 64 MiB uncompressed limit.
- **Startup time.** Both plans limit global-scope startup to **1 second**. Imported module initialization counts toward startup CPU; load admin-only providers, ingestion code and validation inside the functions that need them. Bundle size checks do not measure startup time; verify it separately with the built Worker before deploying.
- **CPU time.** Workers Free allows **10 ms CPU** per request. On the deployed disposable test Worker (2026-11-08), cache interception reduced cached anonymous public-page CPU p50 from **5–11 ms to 3–5 ms** (p95 **10–26 ms to 6–10 ms**). Cold article renders and dynamic/private routes remain separate risks; the local regression suite verifies behavior, not edge CPU.
- **Build-time data.** `/guides` and `/field-notes` are statically prerendered from the build machine's local D1, so the first deploy ships whatever that DB contains (usually nothing). They refresh when a publish action calls `revalidatePath()`. Before launch, decide between:
  - `export const revalidate = <seconds>`
  - rendering them dynamically
  - running `opennextjs-cloudflare populateCache` after deploy
- **Image resizing.** No `IMAGES` binding yet, so `next/image` serves originals. Add Cloudflare Images if resizing is needed (it has its own pricing).
- **Local `npm run preview` state.** It shares `.wrangler/state/v3` with `next dev`.

## Follow-ups

- A remote-safe admin seed script.
- A staging environment and a CI deploy job (preview deploys per PR) once an account exists.
