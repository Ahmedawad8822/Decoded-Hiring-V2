// ============================================================================
// CPU PROFILER SEED (local only) — used by scripts/profile-cpu.ts
// ----------------------------------------------------------------------------
// Fills a THROWAWAY local D1 (DH_LOCAL_STATE_DIR) with realistic public
// content so the CPU profiler measures pages with real bodies, not empty
// states: the e2e bootstrap (admin, Mission 06 demo course with lessons,
// Mission 08 booking type + coaching offer) plus the baseline published guide,
// extra published guides, and published field notes with long bodies.
// Idempotent. Refuses to run without DH_LOCAL_STATE_DIR so it can never touch
// the shared dev state by accident.
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, fieldNotes } from "../src/lib/db";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { createGuide, publishGuide, getPublicGuideBySlug } from "../src/features/guides/service";
import { createFieldNote, publishFieldNote } from "../src/features/field-notes/service";

function longBody(topic: string, sections: number) {
  const blocks: Array<Record<string, unknown>> = [];
  for (let s = 0; s < sections; s++) {
    blocks.push({ id: `h${s}`, type: "heading", level: 2, text: `${topic}: section ${s + 1}`, anchor: `s${s + 1}` });
    for (let p = 0; p < 4; p++) {
      blocks.push({
        id: `p${s}-${p}`,
        type: "paragraph",
        text:
          "Most hiring failures are **role failures**, not sourcing failures. A team that cannot say what the first ninety days should deliver will interview for charm and hire for comfort. " +
          "Write the scorecard before the search, agree the evidence you will accept, and revisit it after every shortlist. This is a profiling fixture paragraph, but its size and inline markup match real content.",
      });
    }
    blocks.push({ id: `l${s}`, type: "list", style: "bullet", items: ["**Evidence** over impressions", "One scorecard per role family", "Decide the trade-offs in advance"] });
    blocks.push({ id: `q${s}`, type: "blockquote", text: "The tool comes after the diagnosis." });
  }
  return blocks;
}

async function main() {
  if (!process.env.DH_LOCAL_STATE_DIR) {
    throw new Error("profile-cpu-seed requires DH_LOCAL_STATE_DIR (throwaway state dir).");
  }
  if (process.env.CF_PAGES || process.env.CLOUDFLARE === "1") throw new Error("profile-cpu-seed is local-only");
  if (process.argv.includes("--cache")) {
    const outputDir = process.argv[process.argv.indexOf("--cache") + 1];
    if (!outputDir || !fs.existsSync(path.join(outputDir, "cache"))) throw new Error("--cache needs an OpenNext build directory");
    const { getPlatformProxy } = await import("wrangler");
    const { getCacheAssets } = await import("../node_modules/@opennextjs/cloudflare/dist/cli/commands/populate-cache.js");
    const { computeCacheKey } = await import("@opennextjs/cloudflare/overrides/internal");
    const proxy = await getPlatformProxy<{ NEXT_INC_CACHE_R2_BUCKET: { put: (key: string, value: Buffer) => Promise<unknown> } }>({
      configPath: "wrangler.preview.jsonc", persist: { path: process.env.DH_LOCAL_STATE_DIR },
    });
    try {
      const assets = getCacheAssets({ outputDir } as Parameters<typeof getCacheAssets>[0]);
      for (const asset of assets) await proxy.env.NEXT_INC_CACHE_R2_BUCKET.put(
        computeCacheKey(asset.key, { prefix: undefined, buildId: asset.buildId, cacheType: asset.isFetch ? "fetch" : "cache" }),
        fs.readFileSync(asset.fullPath),
      );
      console.log(`profile-cpu-seed: populated ${assets.length} R2 cache entries in throwaway state`);
    } finally { await proxy.dispose(); }
    return;
  }
  // 1. e2e bootstrap prerequisites (migrations, admin, demo course, booking type + offer)
  const { migrateLocalDb } = await import("../src/lib/db/migrate");
  await migrateLocalDb();
  const { seedDatabase } = await import("../src/lib/db/seed");
  await seedDatabase(); // admin + baseline published guide
  const { seedMission06Demo } = await import("./seed-mission-06");
  await seedMission06Demo();
  const { seedMission08E2E } = await import("./seed-mission-08-e2e");
  await seedMission08E2E();

  // 2. Extra guides + field notes
  for (let i = 1; i <= 5; i++) {
    const slug = `profile-guide-${i}`;
    if (await getPublicGuideBySlug(slug)) continue;
    const g = await createGuide({
      title: `Profile guide ${i}: scorecards that survive contact`,
      slug,
      excerpt: "A fixture guide used to profile CPU time on list and detail pages.",
      author: "Decoded Editorial",
      category: "Strategy",
      tags: "scorecards,hiring",
      metaTitle: undefined,
      metaDescription: undefined,
      coverImage: undefined,
      body: longBody(`Guide ${i}`, 8) as never,
    });
    await publishGuide(g.id);
  }
  const db = await getDb();
  for (let i = 1; i <= 5; i++) {
    const slug = `profile-field-note-${i}`;
    const existing = await db.select().from(fieldNotes).where(eq(fieldNotes.slug, slug)).get();
    if (existing) continue;
    const n = await createFieldNote({
      title: `Profile field note ${i}: what the shortlist hid`,
      slug,
      excerpt: "A fixture field note used to profile CPU time.",
      author: "Decoded Editorial",
      coverImage: undefined,
      metaTitle: undefined,
      metaDescription: undefined,
      body: longBody(`Note ${i}`, 4) as never,
    });
    await publishFieldNote(n.id);
  }
  // 3. A learner enrolled in the (free) demo course, for the signed-in /learn routes.
  const { getAuth } = await import("../src/lib/auth");
  const { users } = await import("../src/lib/db");
  const { courses } = await import("../src/lib/db");
  const { enrollFree } = await import("../src/features/enrollments/service");
  const learnerEmail = process.env.PROFILE_LEARNER_EMAIL || "learner@profile.local";
  const learnerPassword = process.env.PROFILE_LEARNER_PASSWORD || "profile-learner-password-2026!";
  let learner = await db.select().from(users).where(eq(users.email, learnerEmail)).get();
  if (!learner) {
    const auth = await getAuth();
    await auth.api.signUpEmail({ body: { email: learnerEmail, password: learnerPassword, name: "Profile Learner" } });
    learner = await db.select().from(users).where(eq(users.email, learnerEmail)).get();
  }
  const demo = await db.select().from(courses).where(eq(courses.slug, "mission-01-demo")).get();
  if (!learner || !demo) throw new Error("Missing learner or demo course fixture");
  await enrollFree(learner.id, demo.id);
  console.log("profile-cpu-seed: done");
  await disposeCloudflareBindings();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("profile-cpu-seed FAILED:", err instanceof Error ? err.stack : err);
  try {
    await disposeCloudflareBindings();
  } catch {
    // ignore
  }
  process.exit(1);
});
