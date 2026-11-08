# Dependency audit triage

## Development-tool fixes (2026-11-08)

Scoped npm overrides address minimatch's globparts amplification
([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249),
`>=7.0.0 <11.0.1`) and esbuild's development-server request exposure
([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99),
`<=0.24.2`). These dependencies are development/build tools.

| Consumer | Before | After | Reason |
|---|---|---|---|
| `@node-minify/core@9.0.2` (OpenNext AWS) | glob 10.5.0 / minimatch 9.0.9 | glob 14.0.3 / minimatch 11.0.3 | Glob 10's processor checks `instanceof RegExp`; minimatch 11 returns matcher objects. Overriding only minimatch silently loses wildcard matches. Glob 14 supports the new matchers and already requires patched minimatch (`^11.0.2`). |
| `@opennextjs/cloudflare@1.20.15` | glob 13.0.6 / minimatch 10.2.6 | glob 14.0.3 / minimatch 11.0.3 | Move to the parent release supporting minimatch 11. This also fixes glob's AbortSignal cancellation advisory (GHSA-3g3m-2fjr-6pw4, affected through 14.0.1). |
| `@typescript-eslint/typescript-estree@8.70.0` | minimatch 10.2.6 | minimatch 11.0.3 | Latest typescript-eslint 8.72.1 still requires minimatch `^10.2.2`; its named `minimatch(filePath, pattern, { dot: true })` call is compatible with v11. |
| `@esbuild-kit/core-utils@3.3.2` (drizzle-kit) | esbuild 0.18.20 | esbuild 0.25.12 (shared with drizzle-kit) | Latest stable drizzle-kit 0.31.11 still depends on the deprecated loader. Core-utils uses `version`, `transformSync` and `transform`, which remain compatible. |

Minimatch 3.1.5 used by ESLint is outside the advisory range and is unchanged.
Next 16.4.3, OpenNext Cloudflare 1.20.15 / AWS 4.1.14, wrangler 4.156.0,
Better Auth 1.7.15 and drizzle-kit 0.31.11 remain unchanged.

The pins respect the seven-day publication rule: glob 14.0.3 was published
2026-10-28, minimatch 11.0.3 on 2026-10-28, and esbuild 0.25.12 on 2025-11-01.
The new minimatch dependency `@isaacs/nonrecursive-glob-match` is constrained to
1.0.3 (2026-10-28); 1.1.0 was published 2026-11-05 and is too recent.

Compatibility checks exercise both consumers' glob CJS/ESM entry points, sync
and async traversal, streams/iterators, brace expansion, extglobs, ignore rules,
dotfiles and basename matching. TypeScript ESLint's project-service default
project path and core-utils' CJS/ESM transforms and source maps are also checked.
These checks supplement the application lint, typecheck, tests, Next/OpenNext
builds, Worker size gate, Drizzle generation and local Worker HTTP tests.

Full `npm audit` reports zero vulnerabilities with this dependency tree. The
overrides cross declared dependency ranges and need maintenance: remove them
when the pinned parents adopt compatible patched dependencies. Recheck the
publication dates when relaxing the exact pins.

## Historical triage (2026-10-24)

Date: 2026-10-24 (branch `security/npm-audit`)

| | Total | Critical | High | Moderate |
|---|---|---|---|---|
| Before | 22 | 1 | 11 | 10 |
| After | 4 | 0 | 0 | 4 |

"Runtime" = ships in the production Worker bundle. "Dev/build" = tooling only, never deployed.

Key finding: the production `better-auth` (1.7.5) and `drizzle-orm` (0.45.2) were **not** vulnerable. The critical and drizzle-orm findings were
for copies nested under `@better-auth/cli` (better-auth 1.4.22, drizzle-orm 0.41.0), a dev-only CLI that no script, source file or CI step uses.

## Decisions

| Package (advisory) | Sev | Scope | Vulnerable range -> fix | Exposure / decision |
|---|---|---|---|---|
| better-auth nested in @better-auth/cli 1.4.22 (GHSA-wxw3-q3m9-c3jr, 2vg6-77g8-24mp, 9h47-pqcx-hjr4, 86j7-9j95-vpqj, 7w99-5wm4-3g79, 392p-2q2v-4372, g38m-r43w-p2q7, fmh4-wcc4-5jm3, pw9m-5jxm-xr6h, qq9h-g4jm-xgf3) | critical | dev only (nested copy) | <1.6.22 -> n/a for CLI | Runtime better-auth is 1.7.5 (fixed). Removed `@better-auth/cli` (unused; latest 1.4.21/1.4.22 has no fix). |
| @better-auth/cli | high | dev | no fix | Removed (unused). Re-add only if schema generation is needed, accepting findings. |
| drizzle-orm 0.41.0 nested in cli (GHSA-gpj5-g38j-94v9, SQL identifier escaping) | high | dev only (nested) | <0.45.2 | Runtime drizzle-orm is 0.45.2 (fixed). Nested copy gone with CLI removal. |
| lodash, chevrotain, @chevrotain/*, @mrleebo/prisma-ast (GHSA-r5fr-rjxr-66jc, f23m-r3pf-42rh, xxjr-mmjv-4gpg) | high/mod | dev (via cli) | - | Removed with CLI. |
| zod (GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized constrained collections) | high | RUNTIME (direct, and better-auth copy) | <4.6.6 -> 4.6.7 | Bumped exact pin 4.4.3 -> 4.6.7 (published 2026-10-12, 12 days old). Same major. better-auth's nested 4.6.5 copy deduped to 4.6.7. Exposure: our schemas validate request bodies, so a large array/set with length constraints could hit it; upgraded regardless. |
| source-map-js (GHSA-68fv-2mgg-jv7q, event-loop DoS via source-map sections) | high | build only (tailwind/postcss CSS pipeline) | <1.2.2 -> 1.2.2 | Not in Worker. `npm audit fix` bump 1.2.1 -> 1.2.2 (published 2026-09-30). |
| undici 7.29.1 in miniflare (GHSA-4qv8-2p9j-2685, f72v-6w45-q472, xjj6-f33q-929c) | high | dev (wrangler local runtime) | <7.30.1 -> 7.30.1 | miniflare pins undici exactly (7.29.1) in every release, no parent fix. **Override** `"undici@7.29.1": "7.30.1"` (patch bump, published 2026-10-15, 9 days old). Remove once miniflare ships with undici >=7.30.1. @dotenvx's undici 6.29.1 is unaffected and untouched. |
| miniflare, wrangler (via undici) | mod | dev | - | Cleared by the override. wrangler stays at 4.151.1. |
| glob 10.3.3 in @node-minify/core (GHSA-5j98-mcp5-4vw2, CLI `-c` command injection) | high | build (OpenNext) | <10.5.0 -> 10.5.0 | @node-minify/core 9.0.2 pins glob exactly. **Override** `"@node-minify/core": {"glob": "10.5.0"}` (same major). Advisory concerns the glob CLI, which is not invoked. Remove once OpenNext moves off node-minify 9.0.2. |
| @node-minify/core, @opennextjs/aws, @opennextjs/cloudflare | high | build | - | Cleared by the glob override. `npm audit`'s suggested fix (cloudflare 1.20.9) is a downgrade and was not applied. |
| brace-expansion 1.1.18 / 5.0.10 (GHSA-q2hr-2g5m-vwhr, qhr7-859c-m2p7, 6j4f-fj2g-mc7p) | high | dev (eslint, typescript-eslint) | -> 1.1.21 / 5.0.12 | `npm audit fix` lockfile-only bump. |
| esbuild 0.18.20, @esbuild-kit/core-utils, @esbuild-kit/esm-loader, drizzle-kit (GHSA-67mh-4wv8-2f99, dev-server request exposure) | moderate | dev only | no fix | **Remaining (4).** drizzle-kit 0.31.x still depends on the deprecated @esbuild-kit loader. Only exploitable against a running esbuild dev server, which drizzle-kit does not start. Suggested "fix" is a downgrade to drizzle-kit 0.18.1. Accepted; revisit on the next drizzle-kit release. |

## Other changes

- `jackspeak` 2.3.6 -> 3.4.3 and glob 10.3.3 -> 10.5.0 are transitive consequences of the glob override.
- `npm audit fix --force` was not used. Unrelated bumps made by `npm audit fix` (wrangler 4.152.0, drizzle-kit 0.31.11) were reverted to the prior locked versions.

## Automated supply-chain checks

- **Dependabot** (`.github/dependabot.yml`): weekly `npm` and `github-actions` updates. Minor/patch bumps are grouped into one PR per ecosystem, max 5 open PRs, and `cooldown.default-days: 7` enforces the "only adopt versions at least 7 days old" rule. Major bumps of `next`, `react`, `react-dom`, `@opennextjs/cloudflare`, `wrangler`, `better-auth` and `drizzle-orm` are ignored; upgrade those manually.
- **CodeQL** (`.github/workflows/codeql.yml`): `javascript-typescript` analysis on manual `workflow_dispatch` runs. Results appear under Security -> Code scanning.
- **npm audit gate** (`.github/workflows/audit.yml`): `npm audit --omit=dev --audit-level=high` on PRs, pushes to `main` and weekly. Fails on high/critical production advisories. The historical esbuild / drizzle-kit findings above are now resolved by the scoped override; drizzle-kit is a development dependency.
- Dependabot is enabled; changes still pass the normal pull-request checks.
