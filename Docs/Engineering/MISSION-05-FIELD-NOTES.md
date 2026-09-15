# MISSION 05 — FIELD NOTES PUBLISHING

**Date:** September 15, 2026
**Status:** Complete — ready for ChatGPT review
**Branch:** `decoded-hiring-v2/t_935a0810-mission-05-field-notes-publishing`
(worktree branch; the short name `mission-05-field-notes` from the task body
was not created because Kanban worktrees mandate the deterministic branch.)

---

## 1. Scope

Build Field Notes as the second real publishing vertical in Decoded Hiring V2:
shorter, timely, observation-led tactical notes for recruiters and talent
leaders — reusing the Mission 04 Guide publishing foundation. No second auth,
DB client, media service, admin shell, editor, preview system, SEO stack, or
lifecycle. No generic CMS framework either.

Delivered: shared publishing primitives, `field_notes` + `field_note_revisions`
tables, Field Notes domain/service/actions, tabbed Admin Studio workspace with
a lighter editor, public `/field-notes` + `/field-notes/[slug]` routes with
`BlogPosting` SEO, cache revalidation, review-hub links, unit + browser QA,
and Guide regression verification.

## 2. Starting baseline

- `origin/main` @ `4738eb9` verified present (Mission 04 + 04.5 + Playwright
  tooling). Worktree fast-forwarded `d3f6c61 → 4738eb9` before any changes.
- Working tree was clean at start; `git fetch origin` performed first.

## 3. Final architecture

```
src/features/publishing/          NEW — shared primitives
  types.ts                        ContentStatus, ContentBlock union + zod,
                                  slug helpers, isSafeUrl, estimateReadingTime,
                                  FIELD_NOTE_BLOCK_TYPES subset
  preview.ts                      canPreviewAsAdmin / resolvePreviewAccess
  lifecycle.ts                    publish/unpublish/archive/edit timestamp rules
src/components/publishing/
  ContentBlockRenderer.tsx        shared XSS-safe block renderer
src/features/guides/             REUSE — behavior unchanged
  types.ts                        thin re-export layer (GuideBlock =
                                  ContentBlock, same schemas/helpers)
  service.ts                      same queries, via shared preview/lifecycle
  actions.ts                      untouched
src/app/guides/guide-renderer.tsx thin wrapper over ContentBlockRenderer
src/features/field-notes/        NEW — explicit per-domain access
  types.ts | service.ts | actions.ts (+ getFieldNoteRevisionsAction)
src/lib/db/schema.ts             + fieldNotes, fieldNoteRevisions tables
drizzle/migrations/0001_*.sql    CREATE field_notes + field_note_revisions
drizzle/migrations/0002_*.sql    index on revisions.field_note_id
src/lib/media/service.ts         + optional namespace ("guides" default)
src/app/api/media/upload         + optional namespace form field (validated)
src/app/admin/content/           ContentWorkspaceClient tabs (Guides |
                                 Field Notes) + field-notes-manager-client.tsx
src/app/(site)/field-notes/      public index + [slug] detail (BlogPosting)
src/lib/seo.tsx                  + buildContentJsonLd (Article | BlogPosting)
src/app/(site)/review/page.tsx   PUB-05-IDX link + STU-03-REAL tabs text
e2e/field-notes.spec.ts          permanent public specs (index, 404s)
tests/mission-05-field-notes.test.ts  8 FN unit/security tests
```

## 4. Shared primitives extracted (and why each was justified)

| Primitive | Justification |
|---|---|
| `ContentStatus` (`publishing/types.ts`) | Both verticals implement literally `draft \| published \| archived`; one typo-divergence would break lifecycle assumptions. `GuideStatus` is now an alias. |
| `ContentBlock` union + zod schemas | Verified identical shapes in code (the handoff doc's "7 block types incl. image/key_takeaways/divider" did not match the actual 6-type implementation: heading, paragraph, blockquote, callout, list, resource). Two parallel unions would rot. `GuideBlock` is now an alias. |
| `isSafeUrl` + `slugRegex`/`slugSchema`/`slugifyTitle` | Same XSS boundary and slug rules must hold everywhere; guides re-export them. |
| `ContentBlockRenderer` | Byte-identical rendering extracted; `GuideBlockRenderer` is a wrapper at the original path so all Guide imports keep working. |
| `resolvePreviewAccess` | Both verticals share the exact rule (`?preview=true` + admin session). One function, server-side, no tokens. |
| Lifecycle timestamp builders | `publishedAt` first-publish-wins + `updatedAt` touches were duplicated logic with real bug potential (e.g. resetting `publishedAt` on republish). |
| `buildContentJsonLd` | Shared envelope (title/desc/canonical/OG/Twitter/author/dates); only the schema type differs (`Article` vs `BlogPosting`). |
| Media `namespace` | Same bucket/endpoint/MIME/size rules; only the key prefix differs (`guides/` default preserved, `field-notes/` opt-in). The upload route allow-lists the value. |
| `estimateReadingTime` | New helper (200 wpm, min 1). Guides keep their curated value (see §6). |

No generic repositories, no plugin architecture, no speculative abstraction.

## 5. (Covered in §4 table.)

## 6. Guide-specific code deliberately retained

- `category` / `tags` metadata and taxonomy UI (Field Notes have no categories).
- `resource` block CTA (storage union shared; Field Notes editor doesn't offer it).
- Curated "10 min read" label on Guide detail (Field Notes auto-calculate).
- Inline `Article` JSON-LD payload on Guide detail (works; not refactored to the
  new helper to avoid regression risk).
- Guide editor TOC-adjacent long-form affordances; Guide admin manager untouched.
- `revalidatePath`-based cache strategy (mirrored, not abstracted).
- Media default namespace `guides/` (existing keys/tests unchanged).

## 7. Field Note schema

`field_notes`: id (`fn_*`), title, slug (unique), excerpt (nullable), body
(JSON `ContentBlock[]`), coverImage (nullable), author (default Ahmed Awad),
status (`ContentStatus`, default `draft`), metaTitle, metaDescription,
createdAt, updatedAt, publishedAt (nullable). Dedicated table — not
polymorphic with guides. No category/tags columns by design.

`field_note_revisions`: id (`fnrev_*`), fieldNoteId (FK cascade), title, body
snapshot, status, trigger (`publish|update|unpublish|archive`), createdBy
(admin id, nullable), createdAt; indexed on fieldNoteId.

## 8. Lifecycle

`draft → published → archived`, plus unpublish (`published → draft`) and
republish. Slug uniqueness enforced at domain level on create + slug change.
`publishedAt` set once on first publish and preserved across republish/
unpublish/archive. Server actions are admin-gated via `requireAdmin()`.

## 9. Revision behavior

Snapshots recorded on publish, on every update applied while published, and
on unpublish/archive transitions (post-state, with `createdBy` from the admin
session). Draft edits record nothing and never touch `publishedAt`. Surfaced
in the editor rail (trigger + timestamp + title, newest first).

Note: the Mission 04 handoff claimed a `guideRevision` table, but none exists
in schema or migrations — Guides have no revision history. Field Notes are
therefore the first vertical with revisions; no Guide migration was needed.

## 10. Preview security

`?preview=true` + server-side admin session check via shared
`resolvePreviewAccess`, on both resolvers. Anonymous / `user`-role / missing
flag all resolve to `null` → Next `notFound()` (404). Verified by FN-1/FN-2
unit tests and browser checks 9–10. Hidden buttons are UI only; all mutations
go through `requireAdmin()` server actions.

## 11. Cache / revalidation

Public pages stay cache-friendly: `/field-notes` prerendered static,
`/field-notes/[slug]` server-rendered on demand (same profile as guides; no
`force-dynamic`). Every mutation revalidates `/field-notes`,
`/field-notes/[slug]`, and `/admin/content`. Browser check 15 proved an
edited published note goes live without manual intervention.

## 12. SEO

Canonical, title, description, OpenGraph, Twitter, author, datePublished,
dateModified via shared `publicMetadata` + `buildContentJsonLd` with
`BlogPosting`. Published notes indexable; drafts/archived return 404 with
empty metadata. Sitemap: the current `sitemap.ts` lists static routes only —
guides were never added either — so DB-driven sitemap/RSS remains a deferred
item for both verticals (see §19). No second sitemap system created.

## 13. Admin UX

`/admin/content` now has `Guides (n)` / `Field Notes (n)` tabs above the
existing managers. Field Notes list: search, status filter, status pills,
published/updated dates, Edit/Preview/Publish/Unpublish/Archive, mobile
cards. The editor is lighter: title (auto-slug), excerpt, optional cover
upload, 5 block types (paragraph, heading, pull-quote, callout, list),
publishing rail, SEO quick view, revision history. Same shell, table, dialog,
toast, and block CSS as guides.

## 14. Public UX

Index: editorial newest-first list (date · reading time · title · excerpt ·
read link) in the approved V1 visual language — deliberately list-shaped
rather than guide-cards, so timely notes scan fast. Deliberate empty state
with a pointer to guides. Detail: single 720px column, eyebrow, headline,
dek, concise meta (author · date · auto min-read), optional cover image,
shared renderer, back-to-index footer. No TOC rail, no progress bar, no
long-form scaffolding. Header Explore menu and footer already linked
`/field-notes` (no nav changes needed; 04.5 behavior untouched).

## 15. Media reuse

Same `/api/media/upload` endpoint, same R2 bucket, same MIME whitelist and
5 MB limit — only the key prefix differs (`field-notes/`). Verified by FN-8
unit test and a browser upload→render check (1×1 PNG uploaded through the
editor, rendered unbroken on the public detail page).

## 16. Tests

`npm test` runs Mission 04 (7 tests, unchanged, all pass — Guide regression
at service level) plus Mission 05 (8 tests): FN-1 anon/user preview denial,
FN-2 admin preview + shared helper, FN-3 slug collision, FN-4 full lifecycle
+ `publishedAt` first-publish-wins, FN-5 revision triggers/attribution,
FN-6 draft-edit isolation, FN-7 shared validators/reading time, FN-8 media
namespace rules. Permanent e2e (`e2e/field-notes.spec.ts`): index renders,
unknown slug 404s, draft-probe 404s.

## 17. Playwright / browser verification (local, port 3000)

Full 22-step lifecycle via Chromium (temp spec, removed after run — all PASS):
login → content → Field Notes tab → create draft → title/excerpt/blocks →
save → anon 404 → admin preview + banner → publish → index shows note →
detail renders → edit published → live after revalidation → unpublish → 404 →
republish → 200 → archive → 404 → admin ARCHIVED.

Responsive matrix (temp spec, removed): 320 / 375 / 430 / 768 / 1024 / 1280 /
1440 / 1728 — zero horizontal overflow on index, detail, admin list, and
editor; article measure ≤ 780px; tap-target and keyboard-focus spot-checks;
guides index/detail re-checked at 375/768/1280; zero console errors/pageerrors;
cover-image upload renders unbroken. QA notes and revisions deleted afterwards
(DB verified clean; only the seeded baseline guide remains).

Environment notes: local-only `.env.local` (gitignored) bootstraps the dev
admin; Better Auth requires the default port 3000 (`Invalid origin` on
custom ports); a wedged `next dev` (killed, restarted clean) once stalled the
runner — runner healthy after restart.

## 18. Guide regression results

- Unit: Mission 04 suite 7/7 on refactored code (preview rule, lifecycle,
  slugs, media, default roles).
- Browser: guides index/detail at 375/768/1280 in the matrix — no overflow,
  no console errors; seeded guide detail intact.
- Admin guide manager file untouched; guide service behavior byte-identical
  (shared helpers encode the same rules).
- `npm run test:e2e` 6/6, `typecheck` clean, `lint` clean, `next build` green
  (`/field-notes` static, `/field-notes/[slug]` dynamic — same as guides).

## 19. Deferred items

1. DB-driven sitemap/RSS for guides + field notes (integration point:
   extend `src/app/sitemap.ts` with `getPublishedGuides()` /
   `getPublishedFieldNotes()`; add `rss.xml` route reusing the same queries).
2. Remote Cloudflare provisioning (D1/R2/deploy) — unchanged from M04.
3. Guide revision history (field notes have it; guides predate it).
4. Worker adapter decision, third-party integrations, courses/learner
   productionization — unchanged from M04.

---

## Git discipline

Checkpoint commits: (1) primitives + migration, (2) domain + tests,
(3) admin + public + review + e2e. Final tree clean; `next-env.d.ts` churn
reverted. Branch pushed with normal Git; no merge to main; no deploy; no V1
touch; no production credentials; no fake Ahmed-authored production content
(all QA notes deleted).
