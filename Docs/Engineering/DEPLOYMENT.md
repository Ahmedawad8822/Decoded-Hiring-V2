# Deployment — Cloudflare Workers via OpenNext

Status: **prepared, not deployed.** Nothing in this repo has been provisioned on
Cloudflare. Every production value in `wrangler.jsonc → env.production` is a
`<PLACEHOLDER>`.

## How it fits together

| Piece | What it does |
|---|---|
| `@opennextjs/cloudflare` (pinned **1.20.12**) | Turns the `next build` output into a Worker (`.open-next/worker.js`) plus static assets (`.open-next/assets`). 1.20.12 needs Next ≥ 16.4.1 and wrangler ^4.148; we run Next 16.4.2 and wrangler 4.151.1. |
| `open-next.config.ts` | R2 incremental cache (`NEXT_INC_CACHE_R2_BUCKET`) for ISR pages, plus the D1 tag cache (`NEXT_TAG_CACHE_D1`, bound to the same D1 database as `DB`). Without a tag cache, `revalidatePath()`/`revalidateTag()` from Studio publish actions would do nothing on Workers. OpenNext's cache population, which runs during `opennextjs-cloudflare deploy`, creates its own `revalidations` table in that D1; it is not a Drizzle migration. |
| `src/lib/cloudflare/bindings.ts` | On Workers, bindings come from `getCloudflareContext().env`. In local Node (`next dev`, `next build`, tests, scripts), it falls back to wrangler's `getPlatformProxy` with persist path `DH_LOCAL_STATE_DIR` or `.wrangler/state/v3`. wrangler is imported with a computed specifier, so it is never bundled. |
| `wrangler.jsonc` | Top level = **local** config (dev, tests, `npm run preview`). `env.production` = real resources (placeholders). Bindings: `DB` (D1), `MEDIA_BUCKET` (R2), `NEXT_INC_CACHE_R2_BUCKET` (R2), `WORKER_SELF_REFERENCE` (service), `ASSETS`. |

## Scripts

| Script | Use |
|---|---|
| `npm run cf:build` | OpenNext build (runs `next build` first). Needs `BETTER_AUTH_SECRET` set and a migrated local DB (`npm run db:migrate:local`), because `/guides` and `/field-notes` prerender from D1. |
| `npm run cf:size` | Runs `wrangler deploy --dry-run` (no credentials), parses the uncompressed `Total Upload` size and fails above `WORKER_UNCOMPRESSED_BUDGET_KIB` (default 20480 KiB / 20 MiB; Free and Paid limit 64 MiB). Gzip is printed for information only. Run after `cf:build`. Runs in CI as the `worker-size` job. |
| `npm run preview` | Build, then run the real Worker locally in `wrangler dev` against local D1/R2. Put local-only secrets in `.dev.vars` (git-ignored), e.g. `BETTER_AUTH_SECRET=...`. |
| `npm run db:migrate:remote` | `wrangler d1 migrations apply DB --env production --remote` |
| `npm run deploy` | Build and deploy with `--env production`. **Fails until the placeholders are filled.** |

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
- **CPU time.** Workers Free allows **10 ms CPU** per request. SSR of dynamic pages (learner, Studio, booking) is likely to exceed that. Expect to need Workers Paid, or measure before deciding.
- **Build-time data.** `/guides` and `/field-notes` are statically prerendered from the build machine's local D1, so the first deploy ships whatever that DB contains (usually nothing). They refresh when a publish action calls `revalidatePath()`. Before launch, decide between:
  - `export const revalidate = <seconds>`
  - rendering them dynamically
  - running `opennextjs-cloudflare populateCache` after deploy
- **Image resizing.** No `IMAGES` binding yet, so `next/image` serves originals. Add Cloudflare Images if resizing is needed (it has its own pricing).
- **Local `npm run preview` state.** It shares `.wrangler/state/v3` with `next dev`.

## Follow-ups

- A remote-safe admin seed script.
- A staging environment and a CI deploy job (preview deploys per PR) once an account exists.
