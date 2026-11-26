import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.
process.env.ADMIN_REQUIRE_2FA = "false";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { markEmailVerified } from "./helpers/verified";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { adminAuditLog, getDb, landingPages, leadSubmissions } from "../src/lib/db";
import {
  appendUtmsToHref,
  getLandingScheduleState,
  landingSectionsSchema,
  parseUtmParams,
} from "../src/features/landing-pages/types";

const nodeRequire = createRequire(__filename);
let cookieHeader = "";

function stubModule(id: string, exports: Record<string, unknown>) {
  const resolved = nodeRequire.resolve(id);
  nodeRequire.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
}

const uid = () => crypto.randomUUID().slice(0, 8);

type Mods = {
  landing: typeof import("../src/features/landing-pages/actions");
  service: typeof import("../src/features/landing-pages/service");
  guides: typeof import("../src/features/guides/service");
  leads: typeof import("../src/features/leads/actions");
  analytics: typeof import("../src/features/analytics/public-actions");
  events: typeof import("../src/features/analytics/service");
  auth: typeof import("../src/lib/auth");
  users: typeof import("../src/lib/db");
};
let m: Mods;

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers(cookieHeader ? { cookie: cookieHeader } : {}) });
  stubModule("next/cache", {
    revalidatePath: () => {},
    revalidateTag: () => {},
    unstable_cache: <T>(fn: T) => fn,
  });

  m = {
    landing: await import("../src/features/landing-pages/actions"),
    service: await import("../src/features/landing-pages/service"),
    guides: await import("../src/features/guides/service"),
    leads: await import("../src/features/leads/actions"),
    analytics: await import("../src/features/analytics/public-actions"),
    events: await import("../src/features/analytics/service"),
    auth: await import("../src/lib/auth"),
    users: await import("../src/lib/db"),
  };

  const auth = await m.auth.getAuth();
  const email = `lp-admin-${uid()}@example.com`;
  const created = await auth.api.signUpEmail({ body: { email, password: "LandingAdmin123!", name: "LP Admin" } });
  const db = await getDb();
  await db.update(m.users.users).set({ role: "admin" }).where(eq(m.users.users.id, created.user.id));
  await markEmailVerified(created.user.id);
  const signIn = await auth.api.signInEmail({ body: { email, password: "LandingAdmin123!" }, returnHeaders: true });
  cookieHeader = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  assert.ok(cookieHeader, "sign-in must yield a session cookie");
});

test.after(async () => {
  await disposeCloudflareBindings();
});

async function createPublishedGuide(suffix: string) {
  const slug = `lp-guide-${suffix}`;
  const guide = await m.guides.createGuide({ title: `LP Guide ${suffix}`, slug, author: "Decoded Editorial", body: [] });
  return m.guides.publishGuide(guide.id);
}

function basePayload(targetGuideId: string, slug: string) {
  return {
    title: `Campaign ${slug}`,
    slug,
    campaignName: `Campaign ${slug}`,
    targetKind: "guide" as const,
    targetOfferId: null,
    targetCourseId: null,
    targetGuideId,
    ctaLabel: "Start now",
    sections: [{ id: "s1", type: "hero" as const, heading: "Hello" }],
    seoTitle: null,
    seoDescription: null,
    noindex: true,
    startsAt: undefined,
    endsAt: undefined,
  };
}

function leadForm(overrides: Record<string, string> = {}) {
  const form = new FormData();
  form.set("idempotencyKey", crypto.randomUUID());
  form.set("fullName", "Sara Naguib");
  form.set("email", `sara-${uid()}@example.com`);
  form.set("countryCode", "EG");
  form.set("problemSummary", "Our hiring process takes too long and loses good people.");
  form.set("privacyAcknowledged", "on");
  form.set("website", "");
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return form;
}

// --- Block validation: unknown blocks rejected ---

test("LP-1: unknown section blocks are rejected", async () => {
  const bad = [{ id: "x", type: "video_carousel", heading: "Nope" }];
  assert.throws(() => landingSectionsSchema.parse(bad));
  const twoForms = [
    { id: "a", type: "lead_form", heading: "One" },
    { id: "b", type: "lead_form", heading: "Two" },
  ];
  assert.throws(() => landingSectionsSchema.parse(twoForms), /at most one lead form/);
  const ok = landingSectionsSchema.parse([
    { id: "a", type: "hero", heading: "Hello there" },
    { id: "b", type: "lead_form", heading: "Talk to us" },
    { id: "c", type: "target_summary" },
  ]);
  assert.equal(ok.length, 3);
});

// --- Target validation ---

test("LP-2: exactly one target is required", async () => {
  const guide = await createPublishedGuide(`t2-${uid()}`);
  const none = basePayload(null as unknown as string, `lp-none-${uid()}`);
  const noneRes = await m.landing.createLandingPageAction(none);
  assert.equal(noneRes.ok, false);

  const both = { ...basePayload(guide.id, `lp-both-${uid()}`), targetKind: "guide" as const, targetCourseId: "course_x" };
  const bothRes = await m.landing.createLandingPageAction(both);
  assert.equal(bothRes.ok, false);

  const mismatch = { ...basePayload(guide.id, `lp-mismatch-${uid()}`), targetKind: "offer" as const };
  const mismatchRes = await m.landing.createLandingPageAction(mismatch);
  assert.equal(mismatchRes.ok, false);

  const missing = { ...basePayload("guide_missing", `lp-missing-${uid()}`) };
  const missingRes = await m.landing.createLandingPageAction(missing);
  assert.equal(missingRes.ok, false);
  if (!missingRes.ok) assert.match(missingRes.error, /Linked guide not found/);
});

// --- UTM helpers ---

test("LP-3: UTM pass-through appends only utm_* and preserves query and hash", async () => {
  const utms = parseUtmParams(
    new URLSearchParams("utm_source=newsletter&utm_medium=email&foo=bar&utm_campaign="),
  );
  assert.deepEqual(utms, { utm_source: "newsletter", utm_medium: "email" });
  assert.equal(appendUtmsToHref("/courses/x", utms), "/courses/x?utm_source=newsletter&utm_medium=email");
  assert.equal(
    appendUtmsToHref("/courses/x?ref=1#top", utms),
    "/courses/x?ref=1&utm_source=newsletter&utm_medium=email#top",
  );
  assert.equal(appendUtmsToHref("/contact", {}), "/contact");
});

// --- Schedule states ---

test("LP-4: schedule gates the public resolver", async () => {
  const guide = await createPublishedGuide(`t4-${uid()}`);
  const now = new Date();
  const liveSlug = `lp-live-${uid()}`;
  const live = await m.landing.createLandingPageAction(basePayload(guide.id, liveSlug));
  assert.equal(live.ok, true);
  if (!live.ok) return;
  await m.landing.publishLandingPageAction(live.data.id);

  const resolved = await m.service.resolvePublicLandingPage(liveSlug, now);
  assert.ok(resolved);
  assert.equal(resolved.scheduleState, "live");

  const futureSlug = `lp-future-${uid()}`;
  const future = await m.landing.createLandingPageAction({
    ...basePayload(guide.id, futureSlug),
    startsAt: new Date(now.getTime() + 3600_000),
  });
  assert.equal(future.ok, true);
  if (!future.ok) return;
  await m.landing.publishLandingPageAction(future.data.id);
  assert.equal(await m.service.resolvePublicLandingPage(futureSlug, now), null);

  const pastSlug = `lp-past-${uid()}`;
  const past = await m.landing.createLandingPageAction({
    ...basePayload(guide.id, pastSlug),
    startsAt: new Date(now.getTime() - 7200_000),
    endsAt: new Date(now.getTime() - 3600_000),
  });
  assert.equal(past.ok, true);
  if (!past.ok) return;
  await m.landing.publishLandingPageAction(past.data.id);
  const ended = await m.service.resolvePublicLandingPage(pastSlug, now);
  assert.ok(ended);
  assert.equal(ended.scheduleState, "ended");

  assert.equal(getLandingScheduleState({ startsAt: null, endsAt: null }, now), "live");
});

// --- Lifecycle incl. trash ---

test("LP-5: full lifecycle with trash, restore and permanent delete", async () => {
  const guide = await createPublishedGuide(`t5-${uid()}`);
  const slug = `lp-life-${uid()}`;
  const created = await m.landing.createLandingPageAction(basePayload(guide.id, slug));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const id = created.data.id;

  // Published pages cannot go straight to Trash.
  await m.landing.publishLandingPageAction(id);
  const trashLive = await m.landing.moveLandingPageToTrashAction(id);
  assert.equal(trashLive.ok, false);

  await m.landing.archiveLandingPageAction(id);
  const trashed = await m.landing.moveLandingPageToTrashAction(id);
  assert.equal(trashed.ok, true);

  const db = await getDb();
  const listed = await m.service.getAllAdminLandingPages();
  assert.ok(!listed.some((p) => p.id === id), "trashed rows stay out of Studio lists");
  const trash = await m.service.listTrashedLandingPages();
  assert.ok(trash.some((p) => p.id === id));
  assert.equal(await m.service.resolvePublicLandingPage(slug), null);

  // Editing a trashed row is blocked.
  const editBlocked = await m.landing.updateLandingPageAction({ ...basePayload(guide.id, slug), id });
  assert.equal(editBlocked.ok, false);

  const restored = await m.landing.restoreLandingPageFromTrashAction(id);
  assert.equal(restored.ok, true);
  const afterRestore = await m.service.getAdminLandingPageById(id);
  assert.equal(afterRestore?.status, "archived");
  assert.equal(afterRestore?.trashedAt, null);

  // Permanent delete needs Trash + the exact title.
  const earlyDelete = await m.landing.deleteLandingPagePermanentlyAction(id, `Campaign ${slug}`);
  assert.equal(earlyDelete.ok, false);
  await m.landing.moveLandingPageToTrashAction(id);
  const wrongTitle = await m.landing.deleteLandingPagePermanentlyAction(id, "Wrong title");
  assert.equal(wrongTitle.ok, false);
  const deleted = await m.landing.deleteLandingPagePermanentlyAction(id, `Campaign ${slug}`);
  assert.equal(deleted.ok, true);
  assert.equal(await m.service.getAdminLandingPageById(id), null);

  const audits = await db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, id));
  const actions = audits.map((a) => a.action);
  assert.ok(actions.includes("landing_page.delete_permanently"));
  const snapshot = audits.find((a) => a.action === "landing_page.delete_permanently");
  assert.ok(snapshot?.details?.includes(slug), "audit keeps a title/slug snapshot");
});

// --- Cron backstops: purge + archive ended ---

test("LP-6: purge removes only long-trashed rows; archive ends campaigns", async () => {
  const guide = await createPublishedGuide(`t6-${uid()}`);
  const now = new Date();

  const oldSlug = `lp-old-${uid()}`;
  const old = await m.landing.createLandingPageAction(basePayload(guide.id, oldSlug));
  assert.equal(old.ok, true);
  if (!old.ok) return;
  await m.landing.moveLandingPageToTrashAction(old.data.id);
  const db = await getDb();
  await db
    .update(landingPages)
    .set({ trashedAt: new Date(now.getTime() - 31 * 24 * 3600_000) })
    .where(eq(landingPages.id, old.data.id));

  const freshSlug = `lp-fresh-${uid()}`;
  const fresh = await m.landing.createLandingPageAction(basePayload(guide.id, freshSlug));
  assert.equal(fresh.ok, true);
  if (!fresh.ok) return;
  await m.landing.moveLandingPageToTrashAction(fresh.data.id);

  const purged = await m.service.purgeExpiredLandingPages(now, 20);
  assert.ok(purged.includes(old.data.id));
  assert.ok(!purged.includes(fresh.data.id));
  assert.equal(await m.service.getAdminLandingPageById(old.data.id), null);
  assert.ok(await m.service.getAdminLandingPageById(fresh.data.id));

  const endSlug = `lp-end-${uid()}`;
  const ending = await m.landing.createLandingPageAction({
    ...basePayload(guide.id, endSlug),
    endsAt: new Date(now.getTime() - 1000),
  });
  assert.equal(ending.ok, true);
  if (!ending.ok) return;
  await m.landing.publishLandingPageAction(ending.data.id);
  const archived = await m.service.archiveEndedCampaigns(now, 50);
  assert.ok(archived.includes(ending.data.id));
  const afterArchive = await m.service.getAdminLandingPageById(ending.data.id);
  assert.equal(afterArchive?.status, "archived");
});

// --- Admin-only ---

test("LP-7: mutations require an admin session", async () => {
  const saved = cookieHeader;
  cookieHeader = "";
  try {
    const signedOut = await m.landing.createLandingPageAction({
      ...basePayload("guide_x", `lp-anon-${uid()}`),
      targetGuideId: "guide_x",
    });
    assert.equal(signedOut.ok, false);
    if (!signedOut.ok) assert.match(signedOut.error, /signed in/i);
    const signedOutTrash = await m.landing.moveLandingPageToTrashAction("lp_missing");
    assert.equal(signedOutTrash.ok, false);
  } finally {
    cookieHeader = saved;
  }
});

// --- Lead attribution with UTMs ---

test("LP-8: landing lead posts carry the page slug and UTMs", async () => {
  const guide = await createPublishedGuide(`t8-${uid()}`);
  const slug = `lp-lead-${uid()}`;
  const created = await m.landing.createLandingPageAction(basePayload(guide.id, slug));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await m.landing.publishLandingPageAction(created.data.id);

  const idempotencyKey = crypto.randomUUID();
  const form = leadForm({
    idempotencyKey,
    utm_source: "newsletter",
    utm_medium: "email",
    utm_campaign: "launch",
  });
  const result = await m.leads.submitLandingLead(slug, undefined, form);
  assert.ok(result);
  assert.equal(result.ok, true);

  const db = await getDb();
  const row = await db.select().from(leadSubmissions).where(eq(leadSubmissions.idempotencyKey, idempotencyKey)).get();
  assert.ok(row);
  assert.equal(row.sourceRoute, `/go/${slug}`);
  assert.equal(row.landingPageId, created.data.id);
  assert.deepEqual(JSON.parse(row.utmParams ?? "{}"), {
    utm_source: "newsletter",
    utm_medium: "email",
    utm_campaign: "launch",
  });

  // Same key + same intent returns the row; unknown campaigns are refused.
  const retry = await m.leads.submitLandingLead(slug, undefined, form);
  assert.ok(retry);
  assert.equal(retry.ok, true);
  const refused = await m.leads.submitLandingLead(`missing-${uid()}`, undefined, leadForm());
  assert.ok(refused);
  assert.equal(refused.ok, false);
});

// --- Business events tagged with the landing page ---

test("LP-9: view and CTA events are recorded with the landing page id", async () => {
  const guide = await createPublishedGuide(`t9-${uid()}`);
  const slug = `lp-events-${uid()}`;
  const created = await m.landing.createLandingPageAction(basePayload(guide.id, slug));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await m.landing.publishLandingPageAction(created.data.id);

  const beforeViews = await m.events.countBusinessEvents("landing_page_viewed");
  await m.analytics.recordLandingPageView({
    eventKey: crypto.randomUUID(),
    landingPageId: created.data.id,
    slug,
  });
  assert.equal(await m.events.countBusinessEvents("landing_page_viewed"), beforeViews + 1);

  const beforeCtas = await m.events.countBusinessEvents("landing_page_cta_clicked");
  await m.analytics.recordLandingPageCta({
    eventKey: crypto.randomUUID(),
    landingPageId: created.data.id,
    slug,
    surface: "hero",
  });
  assert.equal(await m.events.countBusinessEvents("landing_page_cta_clicked"), beforeCtas + 1);

  // Draft/scheduled/unknown pages never emit.
  await m.analytics.recordLandingPageView({
    eventKey: crypto.randomUUID(),
    landingPageId: "lp_missing",
    slug: `missing-${uid()}`,
  });
  assert.equal(await m.events.countBusinessEvents("landing_page_viewed"), beforeViews + 1);
});

// --- Sitemap honours noindex and schedule ---

test("LP-10: sitemap includes only live, indexable landing pages", async () => {
  const guide = await createPublishedGuide(`t10-${uid()}`);
  const now = new Date();
  const mk = async (suffix: string, extra: Record<string, unknown> = {}) => {
    const slug = `lp-map-${suffix}-${uid()}`;
    const res = await m.landing.createLandingPageAction({ ...basePayload(guide.id, slug), ...extra });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("setup failed");
    await m.landing.publishLandingPageAction(res.data.id);
    return slug;
  };

  const indexed = await mk("indexed", { noindex: false });
  const noindexed = await mk("noindexed", { noindex: true });
  const scheduled = await mk("scheduled", { noindex: false, startsAt: new Date(now.getTime() + 3600_000) });

  const entries = await m.service.getSitemapLandingPages(now);
  const slugs = entries.map((p) => p.slug);
  assert.ok(slugs.includes(indexed));
  assert.ok(!slugs.includes(noindexed), "noindex pages stay out of the sitemap");
  assert.ok(!slugs.includes(scheduled), "scheduled pages stay out of the sitemap");
});
