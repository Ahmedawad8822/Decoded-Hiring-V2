# V1 Public Port Notes (Mission 03)

Source (read-only): `/Users/ahmedelrashidy/Documents/ChatGPT/decoded-hiring-cloudflare`
V1 branch: `main`
V1 commit: `1b027cf8a1e7196e13ee4a35b10425ad79d67b3f` (M5B admin insights and operations, #31)
V1 framework: Next.js 16.3.2 + React 19 + Tailwind CSS v4 + next-intl (single `en` locale) + Supabase

## Pages ported (V1 public route -> V2 route, locale prefix dropped)

- `/` homepage (ApprovedHomepage default sections; managed Studio overrides intentionally not ported)
- `/programmes` overview (static cards; Studio-published placements omitted by design)
- `/mission-01` (all sections incl. route map + classroom loop)
- `/workshop` (hero, AHA, system map, programme, brief form)
- `/coaching` (hero, diagnostic, workbench board, brief form)
- `/about` (hero, thesis, story chapters, belief panel)
- `/contact` (+ `?reason=` -> kind mapping preserved)
- `/ai-recruiter-os` (waitlist hero + form)
- `/privacy`, `/terms`, `/cookies` (fallback bodies = full V1 copy)
- Shared: PublicHeader (static), desktop + mobile nav (same component), PublicFooter, CTA sections, 404, robots, sitemap

## Components copied directly (Case A, byte-identical except nothing)

- `src/components/home/*` (7 files), `src/components/products/*` (3 files)
- `src/app/globals.css`, `master-design.css`, `content-design.css`
- `src/lib/seo.tsx`, `src/features/content/homepage-model.ts`
- `public/images/*` (9 files)

## Components adapted (Case B, minimal)

- `site-header-client.tsx`: `@/i18n/navigation` Link -> `next/link`, `usePathname` -> `next/navigation`; account menu kept, Certificates link + legacy signOut action removed (V2 Auth domain owns this)
- `site-header.tsx`: static (no Supabase user lookup, no managed navbar placements); props-compatible for future V2 wiring
- `site-footer.tsx`, `breadcrumbs.tsx`, `legal-page.tsx`: Link import swap only
- `approved-homepage.tsx`: Link import swap only; caller passes `defaultHomeSections`, no managed fetch
- All pages: locale `params`/`setRequestLocale` removed (V1 was single-locale `en` with `localePrefix: as-needed`, so public URLs are unchanged); `getPublishedContent`/`DesignedPageCopy`/`managedPublicMetadata` replaced by the V1 fallback copy inline; `publicMetadata` kept
- Root layout: merged `[locale]/layout.tsx` shell without `NextIntlClientProvider`; keeps `hg-shell`, skip link, header/footer, JSON-LD

## V2 interfaces introduced (Case C, no fake production behavior)

- `src/features/leads/types.ts`: `LeadSubmissionKind`, `LeadActionState` (V2 Leads domain contract)
- `src/features/leads/actions.ts`: `submitLead` server action; same zod validation as V1; honest stub result — validates, then returns `ok: false` with "V2 Leads backend is not connected yet — nothing was sent" + requestId. No Supabase, no Brevo, no BotId
- `src/features/leads/lead-form.tsx`: presentation 1:1, wired to the V2 stub

## Legacy dependencies intentionally excluded (Case D)

Supabase (`@supabase/ssr`, `@supabase/supabase-js`), `next-intl`, `botid`, `posthog-js`/`posthog-node`, `server-only`, legacy `src/lib/supabase/*`, `src/lib/email/*`, `src/lib/analytics/*`, all `supabase/` migrations/RPCs, Guides + Field Notes implementations, admin/dashboard/learner/auth code, `programmes/[slug]` managed presentation route, `certificate-qa`, `template-preview`, `[...contentPath]` CMS route.

Footer links to `/guides`, `/field-notes`, `/admin/login` are kept as forward links for the V2 content/admin systems (currently 404 by design).

## Known differences from V1

1. No locale prefix handling (V1 single-locale `as-needed` => identical public URLs).
2. Homepage + legal pages show default V1 copy; Studio-managed overrides not wired (V2 content system owns this).
3. Programmes overview shows the 4 static cards only (Studio placements omitted).
4. Header renders logged-out state always until V2 Auth wires `user`/`managedProgrammes` props (interface preserved).
5. OG metadata images (`/api/og`) kept as URL references; route not yet implemented in V2.
6. Lead/workshop/coaching/waitlist forms validate but do not persist (stub; see above).

## Content conflicts

- Privacy/Cookies fallback copy names V1 vendors (Supabase, Brevo, PostHog, Google/YouTube) and Vercel hosting. Kept verbatim per port-first rule. Needs Ahmed decision once V2 hosting/data/analytics vendors are chosen.

## Ahmed decisions required

1. V2 vendors (hosting, DB/auth, email, analytics) to unblock privacy/cookies copy + Leads backend.
2. Whether `/guides` + `/field-notes` footer links should 404 until the V2 publishing system lands, or point elsewhere meanwhile.
3. `/login` CTAs (Mission 01) currently dead links pending V2 Auth/learner domain.
