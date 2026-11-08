# Decoded Hiring V2

A recruitment education website with editorial publishing, courses, scheduling
and an admin workspace. Built with Next.js, Better Auth, Drizzle and Cloudflare
Workers (D1 and R2), using the OpenNext adapter.

## Run locally

Use Node.js 22 or newer and npm. All local data uses Miniflare; Cloudflare
credentials are not needed.

```sh
npm ci
cp .env.example .env.local
```

Replace `BETTER_AUTH_SECRET` in `.env.local` with a fresh local value (for example,
generate one with `openssl rand -hex 32`). The example admin credentials are
local fixtures. Keep all real credentials in ignored environment files.

```sh
npm run db:migrate:local
npm run db:seed
npm run dev
```

Open http://localhost:3000. Local state lives in `.wrangler/`.

## Check changes

```sh
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e:ci
npm run test:e2e:worker
```

E2E bootstrap needs the local admin settings from `.env.example` in the shell
or `.env.local`. See [engineering standards](Docs/ENGINEERING-STANDARDS.md),
[architecture](Docs/ARCHITECTURE.md) and [deployment](Docs/Engineering/DEPLOYMENT.md).
The [Workers Builds guide](Docs/Engineering/WORKERS-BUILDS.md) targets the test Worker.

Report vulnerabilities privately using [SECURITY.md](SECURITY.md).
No project license has been selected; public source visibility does not grant a
license to reuse the code or bundled content.
