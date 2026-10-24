# Deployment — Cloudflare Workers via OpenNext

Status: **prepared, not deployed.** Nothing in this repo has been provisioned on
Cloudflare. Every production value in `wrangler.jsonc → env.production` is a
`<PLACEHOLDER>`.

## How it fits together

| Piece | What it does |
|---|---|
| `@opennextjs/cloudflare` (pinned **1.20.9**) | Turns the `next build` output into a Worker (`.open-next/worker.js`) plus static assets (`.open-next/assets`). 1.20.9 is the newest release that supports Next 16.3.8 and wrangler 4.131. Newer adapter releases need Next ≥ 16.4.1 (see "Follow-ups"). |
| `open-next.config.ts` | R2 incremental cache (`NEXT_INC_CACHE_R2_BUCKET`), so ISR pages and `revalidatePath()` from Studio publish actions work on Workers. |
| `src/lib/cloudflare/bindings.ts` | On Workers, bindings come from `getCloudflareContext().env`. In local Node (`next dev`, `next build`, tests, scripts), it falls back to wrangler's `getPlatformProxy` with persist path `DH_LOCAL_STATE_DIR` or `.wrangler/state/v3`. wrangler is imported with a computed specifier, so it is never bundled. |
| `wrangler.jsonc` | Top level = **local** config (dev, tests, `npm run preview`). `env.production` = real resources (placeholders). Bindings: `DB` (D1), `MEDIA_BUCKET` (R2), `NEXT_INC_CACHE_R2_BUCKET` (R2), `WORKER_SELF_REFERENCE` (service), `ASSETS`. |

## Scripts

| Script | Use |
|---|---|
| `npm run cf:build` | OpenNext build (runs `next build` first). Needs `BETTER_AUTH_SECRET` set and a migrated local DB (`npm run db:migrate:local`), because `/guides` and `/field-notes` prerender from D1. |
| `npm run cf:size` | Runs `wrangler deploy --dry-run` (no credentials), parses the gzip size and fails above `WORKER_GZIP_BUDGET_KIB` (default 2950; Free limit 3072). Run after `cf:build`. Runs in CI as the `worker-size` job. |
| `npm run preview` | Build, then run the real Worker locally in `wrangler dev` against local D1/R2. Put local-only secrets in `.dev.vars` (git-ignored), e.g. `BETTER_AUTH_SECRET=...`. |
| `npm run db:migrate:remote` | `wrangler d1 migrations apply DB --env production --remote` |
| `npm run deploy` | Build and deploy with `--env production`. **Fails until the placeholders are filled.** |

## Verified locally (2026-10-24)

- `npm run cf:build`: OpenNext build complete.
- `wrangler deploy --dry-run`: total upload **12.3 MiB, 2.78 MiB gzipped**.
- `opennextjs-cloudflare preview` (built Worker in `wrangler dev`):
  - 200 on `/`, `/guides`, `/field-notes`, `/coaching`, `/workshop`, `/admin/login` and `/sitemap.xml` (dynamic, reads D1).
  - `/learn` redirects anonymous users to `/login`.
  - `/api/auth/get-session` returns `null` when anonymous.
  - Email sign-up wrote to D1, and the session cookie then opened `/learn`.
  - `/_next/image` returns the original WebP (no `IMAGES` binding, so no resizing).

## First deploy checklist (needs Ahmed's decisions)

1. **Account and plan.** Choose the Cloudflare account. See the risks below about the free plan's script size and CPU limits.
2. **Provision:**
   - `wrangler d1 create <name>`
   - `wrangler r2 bucket create <media>`
   - `wrangler r2 bucket create <next-cache>`

   Put the names and the D1 id into `env.production`.
3. **Secrets:**
   - `wrangler secret put BETTER_AUTH_SECRET --env production` (32+ random characters)
   - provider secrets later, when providers are activated
4. **Vars:** set `BETTER_AUTH_URL` and `NEXT_PUBLIC_SITE_URL` to the real origin.
5. **Migrations:** `npm run db:migrate:remote`.
6. **Admin account:** create the first admin in remote D1 with the script (credentials come from the environment, never argv; password at least 12 characters; idempotent, an existing email is only promoted unless `--reset-password` is added):

   ```bash
   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<12+ chars>' ADMIN_NAME='Your Name' \
     npm run admin:create -- --remote --env production
   ```

   `--remote` without `--env` is refused. Without flags it targets local D1 (honours `DH_LOCAL_STATE_DIR`). Run it after step 5, then sign in at `/admin/login` to confirm.
7. **Deploy:** `npm run deploy`. Prefer a staging environment first (`env.staging`, same shape).
8. **Domain:** add a custom domain or route in Cloudflare. DNS cutover from V1 is a Phase 8 launch step.

## Risks and open decisions

- **Script size.** 2.78 MiB gzipped against the Workers **Free 3 MiB** limit, so about 7% headroom. Paid allows 10 MiB. The `worker-size` CI job now enforces a 2950 KiB gzip budget (`npm run cf:size`, override with `WORKER_GZIP_BUDGET_KIB`), so a PR cannot silently cross the limit. It parses wrangler's `Total Upload` line, so a wrangler output format change fails the job loudly (exit 2) rather than passing.
- **CPU time.** Workers Free allows **10 ms CPU** per request. SSR of dynamic pages (learner, Studio, booking) is likely to exceed that. Expect to need Workers Paid, or measure before deciding.
- **Build-time data.** `/guides` and `/field-notes` are statically prerendered from the build machine's local D1, so the first deploy ships whatever that DB contains (usually nothing). They refresh when a publish action calls `revalidatePath()`. Before launch, decide between:
  - `export const revalidate = <seconds>`
  - rendering them dynamically
  - running `opennextjs-cloudflare populateCache` after deploy
- **Image resizing.** No `IMAGES` binding yet, so `next/image` serves originals. Add Cloudflare Images if resizing is needed (it has its own pricing).
- **Local `npm run preview` state.** It shares `.wrangler/state/v3` with `next dev`.

## Follow-ups

- Upgrade Next to ≥ 16.4.1 together with `@opennextjs/cloudflare` 1.20.13+ and wrangler ≥ 4.148.
- A remote-safe admin seed script.
- A staging environment and a CI deploy job (preview deploys per PR) once an account exists.
