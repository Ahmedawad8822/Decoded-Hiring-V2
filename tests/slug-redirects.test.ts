import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.
import { eq } from "drizzle-orm";
import { getDb, slugRedirects } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import {
  createGuide,
  publishGuide,
  unpublishGuide,
  updateGuide,
} from "../src/features/guides/service";
import {
  createFieldNote,
  publishFieldNote,
  updateFieldNote,
} from "../src/features/field-notes/service";
import {
  createCourse,
  createLesson,
  createSection,
  publishCourse,
  publishLesson,
  updateCourse,
  updateLesson,
} from "../src/features/courses/service";
import {
  resolveCourseRedirect,
  resolveFieldNoteRedirect,
  resolveGuideRedirect,
  resolveLessonRedirect,
} from "../src/features/slug-redirects/service";
import { buildSitemapEntries } from "../src/lib/sitemap-entries";

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

const uid = () => crypto.randomUUID().slice(0, 8);

async function redirectRows(entityId: string) {
  const db = await getDb();
  return db.select().from(slugRedirects).where(eq(slugRedirects.entityId, entityId));
}

test("renaming a published guide records a redirect to the new URL", async () => {
  const a = `rg-a-${uid()}`;
  const b = `rg-b-${uid()}`;
  const g = await createGuide({ title: "Guide", slug: a, author: "Test", body: [] });
  await publishGuide(g.id);
  await updateGuide(g.id, { id: g.id, slug: b });
  assert.equal(await resolveGuideRedirect(a), `/guides/${b}`);
  assert.equal(await resolveGuideRedirect(b), null, "current slug is not a redirect");
  assert.equal(await resolveGuideRedirect(`nope-${uid()}`), null);
});

test("redirect chain A -> B -> C resolves A and B to C", async () => {
  const [a, b, c] = [`ch-a-${uid()}`, `ch-b-${uid()}`, `ch-c-${uid()}`];
  const n = await createFieldNote({ title: "Note", slug: a, author: "Test", body: [] });
  await publishFieldNote(n.id);
  await updateFieldNote(n.id, { id: n.id, slug: b });
  await updateFieldNote(n.id, { id: n.id, slug: c });
  assert.equal(await resolveFieldNoteRedirect(a), `/field-notes/${c}`);
  assert.equal(await resolveFieldNoteRedirect(b), `/field-notes/${c}`);
});

test("renaming back to an old slug removes that redirect (no loop)", async () => {
  const [a, b] = [`bk-a-${uid()}`, `bk-b-${uid()}`];
  const g = await createGuide({ title: "Back", slug: a, author: "Test", body: [] });
  await publishGuide(g.id);
  await updateGuide(g.id, { id: g.id, slug: b });
  await updateGuide(g.id, { id: g.id, slug: a });
  assert.equal(await resolveGuideRedirect(a), null);
  assert.equal(await resolveGuideRedirect(b), `/guides/${a}`);
});

test("a slug reused by a new entity prefers the live entity", async () => {
  const [a, b] = [`ru-a-${uid()}`, `ru-b-${uid()}`];
  const g = await createGuide({ title: "Old", slug: a, author: "Test", body: [] });
  await publishGuide(g.id);
  await updateGuide(g.id, { id: g.id, slug: b });
  assert.equal(await resolveGuideRedirect(a), `/guides/${b}`);
  // A new guide takes the freed slug: the redirect row is deleted.
  const fresh = await createGuide({ title: "New", slug: a, author: "Test", body: [] });
  assert.equal(await resolveGuideRedirect(a), null);
  assert.equal((await redirectRows(g.id)).filter((r) => r.oldSlug === a).length, 0);
  // Renaming onto an old slug also wins.
  const [x, y] = [`ru-x-${uid()}`, `ru-y-${uid()}`];
  const h = await createGuide({ title: "H", slug: x, author: "Test", body: [] });
  await publishGuide(h.id);
  await updateGuide(h.id, { id: h.id, slug: y });
  assert.equal(await resolveGuideRedirect(x), `/guides/${y}`);
  await updateGuide(fresh.id, { id: fresh.id, slug: x });
  assert.equal(await resolveGuideRedirect(x), null);
});

test("draft-only renames create no redirect", async () => {
  const [a, b] = [`dr-a-${uid()}`, `dr-b-${uid()}`];
  const g = await createGuide({ title: "Draft", slug: a, author: "Test", body: [] });
  await updateGuide(g.id, { id: g.id, slug: b });
  assert.equal((await redirectRows(g.id)).length, 0);
  assert.equal(await resolveGuideRedirect(a), null);
});

test("ever-published content keeps history; a draft target does not redirect", async () => {
  const [a, b] = [`up-a-${uid()}`, `up-b-${uid()}`];
  const g = await createGuide({ title: "Once", slug: a, author: "Test", body: [] });
  await publishGuide(g.id);
  await updateGuide(g.id, { id: g.id, slug: b });
  await unpublishGuide(g.id);
  assert.equal(await resolveGuideRedirect(a), null, "draft target must 404, not redirect");
  await updateGuide(g.id, { id: g.id, slug: `up-c-${uid()}` }); // ever published, now draft
  assert.equal((await redirectRows(g.id)).length, 2);
});

test("course rename redirects; sitemap lists only current slugs", async () => {
  const [a, b] = [`co-a-${uid()}`, `co-b-${uid()}`];
  const course = await createCourse({ title: "Course", slug: a, accessMode: "FREE" });
  await createSection({ courseId: course.id, title: "S" });
  await publishCourse(course.id);
  await updateCourse(course.id, { id: course.id, slug: b });
  assert.equal(await resolveCourseRedirect(a), `/learn/courses/${b}`);

  const ga = `sm-a-${uid()}`;
  const gb = `sm-b-${uid()}`;
  const g = await createGuide({ title: "Map", slug: ga, author: "T", body: [] });
  await publishGuide(g.id);
  await updateGuide(g.id, { id: g.id, slug: gb });
  const urls = (await buildSitemapEntries()).map((e) => e.url);
  assert.ok(urls.some((u) => u.endsWith(`/guides/${gb}`)));
  assert.ok(!urls.some((u) => u.endsWith(`/guides/${ga}`)));
});

test("lesson redirects are scoped per course and follow course renames", async () => {
  const mk = async (slug: string) => {
    const c = await createCourse({ title: slug, slug, accessMode: "FREE" });
    const s = await createSection({ courseId: c.id, title: "S" });
    await publishCourse(c.id);
    return { c, s };
  };
  const [c1s, c2s] = [`lc1-${uid()}`, `lc2-${uid()}`];
  const one = await mk(c1s);
  const two = await mk(c2s);
  const old = `les-old-${uid()}`;
  const next = `les-new-${uid()}`;
  const l1 = await createLesson({ courseId: one.c.id, sectionId: one.s.id, title: "L", slug: old });
  const l2 = await createLesson({ courseId: two.c.id, sectionId: two.s.id, title: "L", slug: old });
  await publishLesson(l1.id);
  await publishLesson(l2.id);
  await updateLesson(l1.id, { id: l1.id, slug: next });

  assert.equal(await resolveLessonRedirect(c1s, old), `/learn/courses/${c1s}/lessons/${next}`);
  // Course 2 still has a live lesson at the same slug: no redirect.
  assert.equal(await resolveLessonRedirect(c2s, old), null);
  assert.equal(await resolveLessonRedirect(c1s, next), null);

  // Course rename + stale lesson slug resolves in one hop to the current path.
  const renamed = `lc1-renamed-${uid()}`;
  await updateCourse(one.c.id, { id: one.c.id, slug: renamed });
  assert.equal(await resolveLessonRedirect(c1s, old), `/learn/courses/${renamed}/lessons/${next}`);
  assert.equal(await resolveLessonRedirect(c1s, next), `/learn/courses/${renamed}/lessons/${next}`);
});
