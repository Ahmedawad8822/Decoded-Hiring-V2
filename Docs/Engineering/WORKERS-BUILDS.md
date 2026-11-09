# Workers Builds — test environment only

> **Status (2026-11-08):** connected. `dh-cputest` builds from `main`; preview builds are off. The Cloudflare GitHub app is installed on this repository only.

This connects **only `dh-cputest`**, at https://dh-cputest.hdv2.workers.dev,
to GitHub. Production is provisioned on workers.dev and remains unconnected;
its coordinator deploys manually after owner GO (see [deployment](DEPLOYMENT.md)).
Never connect production to Workers Builds. Stay on Workers
Free. These instructions were checked against Cloudflare documentation and the
installed OpenNext 1.20.15 / Wrangler 4.156.0 sources on 2026-11-08; no remote
settings or resources were changed during preparation.

## Before connecting

Merge the public-repository hardening and ISR queue changes into `main` first.
The `fix/isr-queue` branch must add its Durable Object binding and migration to
**`env.cputest`** as well as its other environments. The current public-repo
change deliberately adds only the test D1/R2/self-reference bindings. Without
the queue, time-based ISR can remain stale; prewarming does not fix that.

`wrangler.jsonc` records resource selectors, not access credentials. D1's API
separates its database UUID from its required authorization token; R2 access
requires a Worker binding or authenticated API credentials. Publishing a UUID
or bucket name does not grant data access. Keep API tokens and runtime secrets
out of source control; keep R2 public access disabled for private media/cache.
See [D1 query authentication](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/),
[R2 authentication](https://developers.cloudflare.com/r2/api/tokens/) and
[R2 Worker bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/).

## Dashboard settings

1. In Cloudflare, open **Workers & Pages → dh-cputest → Settings → Builds →
   Connect**. Authorize GitHub access to `Ahmedawad8822/Decoded-Hiring-V2` only.
   Cloudflare documents this [existing-Worker connection flow](https://developers.cloudflare.com/workers/ci-cd/builds/#connect-an-existing-worker).
2. Select **main** as the dashboard's **production branch**. This label means
   the deployment branch for this test Worker; it does not select
   `env.production` or create a production Worker. Set the root directory to
   the repository root (`/`).
3. Set the **build command** to:

   ```sh
   npm ci && npx tsx scripts/build-cputest.ts
   ```

4. Set the **deploy command** to this single line:

   ```sh
   npx wrangler d1 migrations apply DB --env cputest --remote && npx opennextjs-cloudflare deploy --env cputest && npm run prewarm -- --base-url https://dh-cputest.hdv2.workers.dev
   ```

   Use OpenNext's deploy command so cache population runs before Wrangler.
   Do not use `npm run deploy` or `npm run db:migrate:remote`: those select
   production. Do not substitute bare `wrangler deploy` and omit population.
5. Under **Branch control**, turn **Enable Preview Builds OFF** (older UI:
   non-production branch builds). Leave all other branch/PR deployments off.
   GitHub Actions still verifies every PR without Cloudflare credentials.
   See [branch behavior](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/).
6. Under **Build watch paths**, use include `*`; exclude `Docs/*`, `internal/*`,
   `README.md`, `SECURITY.md`, `AGENTS.md`, `CLAUDE.md`. All application, config,
   migration, dependency and workflow changes then trigger a build. Exclusions
   are evaluated before inclusions; see [watch-path syntax](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/).

Cloudflare runs the build and deploy commands separately. Build variables do
not become Worker runtime variables. Cloudflare supplies the deployment token;
no Cloudflare token belongs in GitHub Actions. Its default token permission
list does **not** include D1: in Cloudflare, ensure the selected Builds token
also has account **D1 Edit** (API permission `D1 Write`) for migrations and
OpenNext's D1 tag-cache population. Retain R2 edit and Worker deploy access.
See [Build configuration/token permissions](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
and [D1 authorization](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).

The connected Worker name and effective Wrangler name must both be
`dh-cputest`. Both commands explicitly select `--env cputest`, whose name is
set in source. Wrangler Builds also supplies `WRANGLER_CI_OVERRIDE_NAME`;
do not override that variable yourself. Verify the first build log's selected
Worker before accepting the integration. See [name validation](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#workers-name-requirement).

## Build variables versus runtime secrets

Set these **Build variables**:

| Variable | Value / purpose |
|---|---|
| `NODE_VERSION` | `22` to match GitHub CI |
| `SKIP_DEPENDENCY_INSTALL` | `1`; the build command uses `npm ci` explicitly |
| `NEXT_TELEMETRY_DISABLED` | `1` |
| `BETTER_AUTH_URL` | `https://dh-cputest.hdv2.workers.dev` |
| `NEXT_PUBLIC_SITE_URL` | `https://dh-cputest.hdv2.workers.dev`; public client/SEO origin |

The build helper pins the two origins again, creates an ephemeral build-only
auth secret in memory, applies **local** migrations and builds `--env cputest`.
It does not seed users, use remote D1 or deploy. No real auth/provider secret is
needed in Builds. Do not set `NODE_ENV=production` before `npm ci` (dev tools
must be installed), or set `CF_PAGES` / `CLOUDFLARE=1` (the local migration
script intentionally refuses hosted runtime execution).

Under **dh-cputest → Settings → Variables & Secrets**, set a fresh random
**runtime secret** `BETTER_AUTH_SECRET` (at least 32 random characters).
Retain it across builds. Do not copy the example or CI secret; hosted auth
rejects them. `env.cputest.vars` supplies the two runtime origins. Leave
`ADMIN_REQUIRE_2FA` unset and provider integrations dormant. Do not set any
`ADMIN_INITIAL_*` build variables or run fixture seeds against the remote DB.
The existing test DB has no auth users; deploying does not create one.

Cloudflare's [build-image documentation](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)
explains Node selection and disabling automatic dependency installation.

## Migrations, failures and prewarming

The test deploy command intentionally applies pending D1 migrations **before**
cache population and deployment, with `&&` so a failure stops later steps.
This is needed for an empty database and subsequent schema changes; with none
pending it is a no-op. Noninteractive CI skips the migration confirmation.
D1 rolls back a failing migration, while earlier successful migrations remain.
A Worker deploy failure does not undo successful schema migrations, so every
migration on auto-deployed `main` must be compatible with the currently serving
Worker. Do not reuse this command for production without a separate release
policy. See [D1 migration behavior](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply).

OpenNext also creates/uses its own tag-cache table; that is separate from the
Drizzle migrations. After deploy, prewarming GETs the anonymous sitemap,
public routes and articles. It uses request quota, can fail on Free-plan cold
CPU, and failure does not roll back deployment. Fix the cause and rerun the
prewarm command. Confirm public pages, cache HITs, publication invalidation
and time-based ISR on the deployed test Worker before treating it as verified.
See [deployment/prewarm details](DEPLOYMENT.md).

## Installed CLI evidence

These are local installed-source paths relative to the project, pinned by
`package-lock.json`; inspect again when upgrading:

| File | Verified behavior |
|---|---|
| `node_modules/@opennextjs/cloudflare/dist/cli/commands/build.js` | `build` accepts Wrangler options and builds the selected config |
| `node_modules/@opennextjs/cloudflare/dist/cli/commands/deploy.js` | `deploy` consumes an existing build, populates **remote** cache with `args.env`, then invokes Wrangler deploy |
| `node_modules/@opennextjs/cloudflare/dist/cli/commands/utils/utils.js` | `getWranglerArgs` forwards `--env` / `--config` to Wrangler |
| `node_modules/@opennextjs/cloudflare/dist/cli/commands/utils/helpers.js` | `getEnvFromPlatformProxy` combines process variables and selected config vars |
| `node_modules/@opennextjs/cloudflare/dist/cli/commands/populate-cache.js` | cache setup is a distinct step before deployment |
| `scripts/build-cputest.ts` | local migrations plus test-environment build, with no seed or deploy |

## Workers Free build limits

Cloudflare currently includes **3,000 build minutes/month**, **one concurrent
build** and a **20-minute build timeout** on Free. Exhausting included minutes
blocks further builds until reset or a plan change; this setup does not enable
a paid plan. These build quotas are separate from Worker request/CPU, D1 and R2
quotas. See [Build limits and pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/).
