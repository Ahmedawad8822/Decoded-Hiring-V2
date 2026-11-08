// Exercise compiled Server Actions over HTTP as a second check on freshness.
// The browser suite separately exercises the real Studio controls. Reading the
// build manifest avoids hard-coding action IDs, which change on every build.
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { prewarm } from "../scripts/prewarm";
import { WORKER_ADMIN, WORKER_RUNTIME_GUIDE_SLUG } from "../scripts/worker-e2e-setup";

test("HTTP anonymous prewarmer discovers public sitemap URLs against the built Worker", async ({ baseURL }) => {
  const summary = await prewarm({ baseUrl: baseURL!, concurrency: 2 });
  expect(summary.failed).toEqual([]);
  expect(summary.results.some((result) => new URL(result.url).pathname === `/guides/${WORKER_RUNTIME_GUIDE_SLUG}`), "first sitemap GET reads deployed D1, not the build snapshot").toBe(true);
  expect(summary.requests).toBeGreaterThan(13);
});

test("HTTP server actions keep article lifecycles and commerce fresh on the first GET", async ({ request, playwright, baseURL }) => {
  const admin = await playwright.request.newContext({ baseURL });
  const manifest: Record<string, { exportedName: string }> = JSON.parse(
    fs.readFileSync(".next/server/server-reference-manifest.json", "utf8"),
  ).node;

  async function action(name: string, args: unknown[]): Promise<{ id: string }> {
    const entry = Object.entries(manifest).find(([, value]) => value.exportedName === name);
    if (!entry) throw new Error(`Missing compiled action: ${name}`);
    const response = await admin.post("/admin/content", {
      headers: {
        origin: baseURL!, "next-action": entry[0],
        "content-type": "text/plain;charset=UTF-8", accept: "text/x-component",
      },
      data: JSON.stringify(args),
    });
    expect(response.status(), name).toBe(200);
    expect(response.headers()["x-opennext-cache"]).not.toBe("HIT");
    const text = await response.text();
    // These actions return plain ActionState JSON in their Flight value row.
    const row = text.split("\n").map((line) => line.slice(line.indexOf(":") + 1))
      .find((line) => line.startsWith('{"ok":'));
    if (!row) throw new Error(`${name} returned no ActionState: ${text.slice(0, 1000)}`);
    const value = JSON.parse(row);
    expect(value.ok, `${name}: ${JSON.stringify(value)}`).toBe(true);
    await response.dispose();
    return value.data;
  }
  async function warm(url: string) {
    await expect.poll(async () => {
      const response = await request.get(url);
      const cache = response.headers()["x-opennext-cache"] ?? response.headers()["x-nextjs-cache"];
      await response.dispose();
      return cache;
    }).toBe("HIT");
  }

  async function sitemapPaths() {
    const response = await request.get("/sitemap.xml");
    expect(response.status()).toBe(200);
    const xml = await response.text();
    await response.dispose();
    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]).pathname);
  }

  try {
    // Metadata handlers must hit the same R2 routing cache as public pages.
    await warm("/robots.txt");
    await warm("/sitemap.xml");
    const signin = await admin.post("/api/auth/sign-in/email", {
      data: WORKER_ADMIN, headers: { origin: baseURL! },
    });
    expect(signin.status()).toBe(200);
    for (const [kind, prefix] of [["guides", "Guide"], ["field-notes", "FieldNote"]]) {
      await test.step(kind, async () => {
        const slug = `http-worker-${kind}-${crypto.randomUUID().slice(0, 8)}`;
        const url = `/${kind}/${slug}`;
        const data = await action(`create${prefix}Action`, [{
          title: `HTTP fixture ${kind}`, slug,
          body: [{ id: "p1", type: "paragraph", text: "Private fixture draft." }],
        }]);
        expect(await sitemapPaths()).not.toContain(url);
        await warm("/sitemap.xml");
        // Unlike the old HTTP check, exercise a public negative cache entry as
        // well as the dynamic previews before publishing.
        expect((await request.get(url)).status()).toBe(404);
        await warm(url);
        const preview = await admin.get(`${url}?preview=true`);
        expect(preview.status()).toBe(200);
        expect(preview.headers()["cache-control"]).toContain("no-store");
        expect(preview.headers()["x-opennext-cache"]).not.toBe("HIT");
        expect(await preview.text()).toContain("Private fixture draft.");
        const anonymous = await request.get(`${url}?preview=true`);
        expect(anonymous.status()).toBe(404);
        expect(await anonymous.text()).not.toContain("Private fixture draft.");

        // Replay Publish Now's save followed by publish, including the index
        // prefetch triggered by Studio navigation while the article is a draft.
        await action(`update${prefix}Action`, [{
          id: data.id, title: `HTTP fixture ${kind}`,
          body: [{ id: "p1", type: "paragraph", text: "Private fixture draft." }],
        }]);
        expect((await request.get(url)).status()).toBe(404);
        const draftIndex = await request.get(`/${kind}`, {
          headers: { rsc: "1", "next-router-prefetch": "1", "next-router-segment-prefetch": "/_tree" },
        });
        expect(draftIndex.status()).toBe(200);
        await draftIndex.dispose();
        // Leave an old sitemap upload outstanding across publish in the race run.
        expect(await sitemapPaths()).not.toContain(url);
        await action(`publish${prefix}Action`, [data.id]);
        // Optional local latency injection makes the OLD render's upload land
        // after publish. This is still the FIRST anonymous GET after the action;
        // there is no retry or freshness polling here.
        const delay = Number(process.env.WORKER_E2E_CACHE_WRITE_DELAY_MS ?? 0);
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay + 150));
        const published = await request.get(url);
        expect(published.status(), "first detail GET after publish").toBe(200);
        expect(await published.text()).toContain("Private fixture draft.");
        expect(await (await request.get(`/${kind}`)).text()).toContain(`href="${url}"`);
        expect(await sitemapPaths(), "first sitemap GET after publish").toContain(url);
        await warm("/sitemap.xml");
        await warm(url);
        await action(`update${prefix}Action`, [{
          id: data.id, title: `Revised fixture ${kind}`,
          body: [{ id: "p1", type: "paragraph", text: "Revised fixture body." }],
        }]);
        const edited = await request.get(url);
        expect(edited.status()).toBe(200);
        expect(await edited.text()).toContain("Revised fixture body.");
        expect(await (await request.get(`/${kind}`)).text()).toContain(`Revised fixture ${kind}`);
        expect(await sitemapPaths(), "first sitemap GET after edit").toContain(url);
        await warm("/sitemap.xml");
        await warm(url);

        const renamed = `${url}-renamed`;
        await action(`update${prefix}Action`, [{
          id: data.id, slug: `${slug}-renamed`, title: `Revised fixture ${kind}`,
          body: [{ id: "p1", type: "paragraph", text: "Revised fixture body." }],
        }]);
        const old = await request.get(url, { maxRedirects: 0 });
        expect(old.status()).toBe(308);
        expect(old.headers().location).toBe(renamed);
        const renamedPage = await request.get(renamed);
        expect(renamedPage.status(), "first detail GET after rename").toBe(200);
        expect(await renamedPage.text()).toContain("Revised fixture body.");
        const renamedIndex = await (await request.get(`/${kind}`)).text();
        expect(renamedIndex).toContain(`href="${renamed}"`);
        expect(renamedIndex).not.toContain(`href="${url}"`);
        const renamedSitemap = await sitemapPaths();
        expect(renamedSitemap, "first sitemap GET after rename").toContain(renamed);
        expect(renamedSitemap).not.toContain(url);
        await warm("/sitemap.xml");
        await warm(renamed);
        await action(`unpublish${prefix}Action`, [data.id]);
        expect((await request.get(renamed)).status()).toBe(404);
        expect(await (await request.get(`/${kind}`)).text()).not.toContain(`href="${renamed}"`);
        expect(await sitemapPaths(), "first sitemap GET after unpublish").not.toContain(renamed);
        await warm("/sitemap.xml");
        await action(`publish${prefix}Action`, [data.id]);
        const republished = await request.get(renamed);
        expect(republished.status(), "first detail GET after republish").toBe(200);
        expect(await republished.text()).toContain("Revised fixture body.");
        expect(await (await request.get(`/${kind}`)).text()).toContain(`href="${renamed}"`);
        expect(await sitemapPaths(), "first sitemap GET after republish").toContain(renamed);
        await warm("/sitemap.xml");
        await warm(renamed);
        await action(`archive${prefix}Action`, [data.id]);
        expect((await request.get(renamed)).status()).toBe(404);
        expect(await (await request.get(`/${kind}`)).text()).not.toContain(`href="${renamed}"`);
        expect(await sitemapPaths(), "first sitemap GET after archive").not.toContain(renamed);
      });
    }

    // The same late-render race affects refreshCommerce's four public paths.
    // Read existing fixture IDs through the real admin page; create only the
    // missing canonical offers in this harness's disposable D1.
    const commerce = await (await admin.get("/admin/commerce")).text();
    const flight = [...commerce.matchAll(/self\.__next_f\.push\((\[1,"(?:\\.|[^"\\])*"\])\)/g)]
      .map((match) => (JSON.parse(match[1]) as [number, string])[1]).join("");
    for (const [slug, kind] of [["coaching", "COACHING"], ["workshop", "WORKSHOP"], ["mission-01", "COURSE"], ["ai-recruiter-os", "PRODUCT"]]) {
      let id = flight.match(new RegExp(`"id":"([^"]+)"[^{}]*"slug":"${slug}"`))?.[1];
      if (!id) ({ id } = await action("createOfferAdminAction", [{
        slug, kind, title: `HTTP ${slug} offer`, accessMode: "FREE", active: true,
        ...(kind === "COURSE" ? { courseId: "course_m06_demo_01" } : {}),
      }]));
      await action("updateOfferAdminAction", [{ id, active: true }]);
      await warm(`/${slug}`);
      // Invalidate then read the old active offer to start a pre-mutation
      // render; the optional injected latency holds its upload across update.
      await action("updateOfferAdminAction", [{ id, active: true }]);
      const prefetch = await request.get(`/${slug}`, { headers: { rsc: "1", "next-router-prefetch": "1" } });
      expect(prefetch.status()).toBe(200);
      await prefetch.dispose();
      await action("updateOfferAdminAction", [{ id, active: false }]);
      const delay = Number(process.env.WORKER_E2E_CACHE_WRITE_DELAY_MS ?? 0);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay + 150));
      const inactive = await request.get(`/${slug}`);
      expect(inactive.status()).toBe(200);
      expect(await inactive.text(), `first GET ${slug} after commerce update`).toContain("Currently unavailable");
      await warm(`/${slug}`);
      await action("updateOfferAdminAction", [{ id, active: true }]);
      const active = await request.get(`/${slug}`);
      expect(await active.text(), `first GET ${slug} after reactivation`).not.toContain("Currently unavailable");
    }
  } finally { await admin.dispose(); }
});
