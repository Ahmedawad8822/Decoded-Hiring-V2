import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { clickAction, waitForHydration } from "../e2e/helpers/actions";
import { WORKER_ADMIN } from "../scripts/worker-e2e-setup";

const baseline = "/guides/talent-acquisition-strategy";
const baselineTitle = "Talent Acquisition Strategy Is Not a Hiring Plan";

async function login(page: Page) {
  await page.goto("/admin/login");
  const email = page.getByLabel(/Admin Email/);
  await waitForHydration(page, email);
  await email.fill(WORKER_ADMIN.email);
  await page.getByLabel(/^Password/).fill(WORKER_ADMIN.password);
  await clickAction(page, page.getByRole("button", { name: "Sign in to Studio" }));
  await expect(page).toHaveURL(/\/admin\/content$/);
}

async function hit(request: APIRequestContext, url: string) {
  // Cache writes use waitUntil. Poll only to establish the cache precondition,
  // never to wait away stale content after an editorial mutation.
  await expect.poll(async () => {
    const response = await request.get(url);
    const cache = response.headers()["x-opennext-cache"];
    await response.dispose();
    return cache;
  }, { message: `Expected routing-layer HIT on ${url}` }).toBe("HIT");
}

async function article(request: APIRequestContext, url: string, title: string, body: string) {
  const response = await request.get(url);
  expect(response.status(), `first GET ${url}`).toBe(200);
  const html = await response.text();
  expect(html, `first GET ${url} must reflect the completed action`).toContain(title);
  expect(html).toContain(body);
  await response.dispose();
}

async function listed(request: APIRequestContext, index: string, slug: string, visible: boolean) {
  const response = await request.get(index);
  expect(response.status()).toBe(200);
  const html = await response.text();
  if (visible) expect(html).toContain(`href="${index}/${slug}"`);
  else expect(html).not.toContain(`href="${index}/${slug}"`);
  await response.dispose();
}

async function save(page: Page, label: "Save Draft" | "Save Changes" | "Publish Now", toast: string) {
  // Action response + success UI prove completion (not just a click). No retry
  // of the mutation: a failed action must fail this test.
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && !!response.request().headers()["next-action"]);
  await clickAction(page, page.getByRole("button", { name: label, exact: true }));
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.headers()["x-opennext-cache"]).not.toBe("HIT");
  await expect(page.locator(".toast b")).toHaveText(toast);
}

async function confirm(page: Page, action: "publish" | "unpublish" | "archive") {
  await clickAction(page, page.getByRole("button", {
    name: action === "archive" ? /^Archive (Guide|Note)$/ : new RegExp(`^${action}$`, "i"),
  }));
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && !!response.request().headers()["next-action"]);
  await clickAction(page, page.getByRole("button", { name: `Confirm ${action}`, exact: true }));
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page.locator(".toast b")).toHaveText({ publish: "Published", unpublish: "Unpublished", archive: "Archived" }[action]);
}

test("SSG hits retain security headers, HTML type and HEAD semantics", async ({ request }) => {
  for (const url of ["/", "/guides", "/contact", "/coaching"]) {
    await hit(request, url);
    const response = await request.get(url);
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["x-opennext-cache"]).toBe("HIT");
    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("form-action 'self'");
    expect(headers["content-security-policy"]).not.toContain("unsafe-eval");
    expect(headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), browsing-topics=(), payment=(), usb=()",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    });
    const head = await request.head(url);
    expect(head.status()).toBe(200);
    expect(head.headers()["x-opennext-cache"]).toBe("HIT");
    expect(head.headers()["content-type"]).toBe(headers["content-type"]);
    expect(head.headers()["content-security-policy"]).toBe(headers["content-security-policy"]);
    expect(await head.body()).toHaveLength(0);
  }
});

test("HTTP variants: RSC HIT stays distinct from HTML; preview rewrite remains dynamic", async ({ request }) => {
  await article(request, baseline, baselineTitle, "The tool comes after the diagnosis.");
  await hit(request, baseline);
  for (const url of ["/guides", baseline]) {
    const flight = await request.get(`${url}?_rsc=worker-http-probe`, { headers: { rsc: "1" } });
    expect(flight.status()).toBe(200);
    expect(flight.headers()["x-opennext-cache"]).toBe("HIT");
    expect(flight.headers()["content-type"]).toContain("text/x-component");
    expect(flight.headers().vary).toContain("RSC");
    expect(await flight.text()).not.toContain("<!DOCTYPE html>");
    const html = await request.get(url);
    expect(html.headers()["content-type"]).toContain("text/html");
    expect(await html.text()).toContain("<!DOCTYPE html>");
  }
  const preview = await request.get(`${baseline}?preview=true`);
  // Published content is public even in preview, but must take the dynamic
  // rewrite. The lifecycle tests below check actual draft confidentiality.
  expect(preview.status()).toBe(200);
  expect(preview.headers()["x-opennext-cache"]).not.toBe("HIT");
  expect(preview.headers()["cache-control"]).toContain("no-store");
  expect(await preview.text()).toContain("The tool comes after the diagnosis.");
});

test("HTTP coaching availability remains live outside the cached shell", async ({ request }) => {
  await hit(request, "/coaching");
  const response = await request.get("/api/public/booking-slots?offer=coaching");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(response.headers()["x-opennext-cache"]).not.toBe("HIT");
  const availability = await response.json();
  expect(availability.enabled).toBe(true);
  expect(availability.slots.length).toBeGreaterThan(1);
});

for (const kind of ["guides", "field-notes"] as const) {
  test(`${kind}: admin lifecycle invalidates warm pages; preview remains private`, async ({ page, request }) => {
    await login(page);
    await page.goto("/admin/content");
    if (kind === "field-notes") await clickAction(page, page.getByRole("tab", { name: /^Field Notes/ }));
    await clickAction(page, page.getByRole("button", { name: kind === "guides" ? /New Guide/ : /New Field Note/ }));
    const slug = `worker-${kind}-lifecycle`;
    const url = `/${kind}/${slug}`;
    const title = page.getByPlaceholder(kind === "guides"
      ? "e.g. Talent Acquisition Strategy Is Not a Hiring Plan"
      : "e.g. What great hiring managers do differently in week one");
    const slugInput = page.getByPlaceholder(kind === "guides" ? "talent-acquisition-strategy" : "great-hiring-managers-week-one");
    const body = page.locator(".bi-body textarea").first();
    const firstTitle = `Worker ${kind} original title`;
    const firstBody = `Original ${kind} body for the local Worker lifecycle fixture.`;
    await title.fill(firstTitle);
    await slugInput.fill(slug);
    await body.fill(firstBody);
    await save(page, "Save Draft", "Created");

    await test.step("beforeFiles preview rewrite bypasses public cache for admins only", async () => {
      expect((await request.get(url)).status()).toBe(404);
      for (let round = 0; round < 2; round++) {
        const preview = await page.request.get(`${url}?preview=true`);
        expect(preview.status()).toBe(200);
        expect(await preview.text()).toContain(firstBody);
        expect(preview.headers()["cache-control"]).toContain("no-store");
        expect(preview.headers()["x-opennext-cache"]).not.toBe("HIT");
        const anonymous = await request.get(`${url}?preview=true`);
        expect(anonymous.status()).toBe(404);
        expect(await anonymous.text()).not.toContain(firstBody);
      }
      // Render the preview in the authenticated browser too.
      const previewPage = await page.context().newPage();
      try {
        await previewPage.goto(`${url}?preview=true`);
        await expect(previewPage.getByRole("heading", { level: 1 })).toHaveText(firstTitle);
        await expect(previewPage.getByText(firstBody, { exact: true })).toBeVisible();
      } finally { await previewPage.close(); }
    });

    await save(page, "Publish Now", "Published!");
    await article(request, url, firstTitle, firstBody);
    await listed(request, `/${kind}`, slug, true);
    await hit(request, url);
    await hit(request, `/${kind}`);

    const updatedTitle = `Worker ${kind} updated title`;
    const updatedBody = `Updated ${kind} body must replace the intercepted cached response.`;
    await title.fill(updatedTitle);
    await body.fill(updatedBody);
    await save(page, kind === "guides" ? "Save Draft" : "Save Changes", "Saved");
    await article(request, url, updatedTitle, updatedBody);
    const index = await request.get(`/${kind}`);
    expect(await index.text()).toContain(updatedTitle);
    await hit(request, url);

    const renamed = `${slug}-renamed`;
    const renamedUrl = `/${kind}/${renamed}`;
    await slugInput.fill(renamed);
    await save(page, kind === "guides" ? "Save Draft" : "Save Changes", "Saved");
    const redirect = await request.get(url, { maxRedirects: 0 });
    expect(redirect.status(), `first GET ${url} after rename`).toBe(308);
    expect(new URL(redirect.headers().location, redirect.url()).pathname).toBe(renamedUrl);
    await article(request, renamedUrl, updatedTitle, updatedBody);
    const renamedIndex = await request.get(`/${kind}`);
    const renamedHtml = await renamedIndex.text();
    expect(renamedHtml, "first index GET after rename").not.toContain(`href="${url}"`);
    expect(renamedHtml, "first index GET after rename").toContain(`href="${renamedUrl}"`);
    await hit(request, renamedUrl);
    await hit(request, `/${kind}`);

    await confirm(page, "unpublish");
    const unpublished = await request.get(renamedUrl);
    expect(unpublished.status(), "first GET after unpublish").toBe(404);
    expect(await unpublished.text()).not.toContain(updatedBody);
    await listed(request, `/${kind}`, renamed, false);
    // A saved draft edit is visible only through the authenticated rewrite.
    const draftBody = `Private ${kind} revision after unpublishing.`;
    await body.fill(draftBody);
    await save(page, "Save Draft", "Saved");
    await article(page.request, `${renamedUrl}?preview=true`, updatedTitle, draftBody);
    const anonymous = await request.get(`${renamedUrl}?preview=true`);
    expect(anonymous.status()).toBe(404);
    expect(await anonymous.text()).not.toContain(draftBody);

    // Archive from a warmed published state, rather than only from draft.
    await save(page, "Publish Now", "Published!");
    await article(request, renamedUrl, updatedTitle, draftBody);
    await listed(request, `/${kind}`, renamed, true);
    await hit(request, renamedUrl);
    await hit(request, `/${kind}`);
    await confirm(page, "archive");
    const archived = await request.get(renamedUrl);
    expect(archived.status(), "first GET after archive").toBe(404);
    expect(await archived.text()).not.toContain(draftBody);
    await listed(request, `/${kind}`, renamed, false);
  });
}

test("Link navigation consumes intercepted RSC instead of HTML without browser errors", async ({ page, request }) => {
  await article(request, baseline, baselineTitle, "The tool comes after the diagnosis.");
  await hit(request, baseline);
  const errors: string[] = [];
  const rsc: Array<{ path: string; status: number; type: string; cache?: string }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", (response) => {
    if (response.request().headers().rsc === "1") rsc.push({
      path: new URL(response.url()).pathname, status: response.status(),
      type: response.headers()["content-type"], cache: response.headers()["x-opennext-cache"],
    });
  });
  await page.goto("/");
  const guides = page.getByRole("contentinfo").getByRole("link", { name: "Guides", exact: true });
  await waitForHydration(page, guides);
  await page.evaluate(() => { document.documentElement.dataset.workerNavigation = "same-document"; });
  await guides.click();
  await expect(page).toHaveURL(/\/guides$/);
  await expect(page.getByRole("heading", { name: "Guides", exact: true, level: 1 })).toBeVisible();
  await page.locator(`a[href="${baseline}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`${baseline}$`));
  await expect(page.getByRole("heading", { name: baselineTitle, level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-worker-navigation", "same-document");
  for (const route of ["/guides", baseline]) {
    await expect.poll(() => rsc.some((r) => r.path === route && r.status === 200 && r.type.includes("text/x-component") && r.cache === "HIT"),
      { message: `Expected an intercepted RSC response for ${route}: ${JSON.stringify(rsc)}` }).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("cached contact shell still executes a public action and persists the lead", async ({ page, request }) => {
  await hit(request, "/contact");
  await page.goto("/contact");
  await waitForHydration(page, page.getByLabel("Name", { exact: true }));
  await page.getByLabel("Name", { exact: true }).fill("Worker Contact Fixture");
  await page.getByLabel("Work email").fill("lead@worker-e2e.local");
  await page.getByLabel("What is happening now?").fill("This local Worker fixture needs a consistent recruitment decision process.");
  await page.getByRole("checkbox", { name: /I understand that my details/ }).check();
  const postPromise = page.waitForResponse((r) => new URL(r.url()).pathname === "/contact" && r.request().method() === "POST");
  await clickAction(page, page.getByRole("button", { name: "Send the context" }));
  const post = await postPromise;
  expect(post.request().headers()["next-action"]).toBeTruthy();
  expect(post.status()).toBe(200);
  expect(post.headers()["x-opennext-cache"]).not.toBe("HIT");
  await expect(page.getByRole("status")).toContainText("Your context has been saved.");
  await login(page);
  await page.goto("/admin/leads");
  await expect(page.getByText("lead@worker-e2e.local", { exact: true }).first()).toBeVisible();
});

test("coaching cache hit hydrates and fetches live no-store slots", async ({ page, request }) => {
  await hit(request, "/coaching");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const slotsPromise = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/public/booking-slots");
  const shell = await page.goto("/coaching");
  expect(shell?.headers()["x-opennext-cache"]).toBe("HIT");
  await expect(page.getByRole("link", { name: "Choose a time" }).first()).toBeVisible();
  const slots = await slotsPromise;
  expect(slots.status()).toBe(200);
  expect(slots.headers()["cache-control"]).toContain("no-store");
  expect(slots.headers()["x-opennext-cache"]).not.toBe("HIT");
  const scheduler = page.locator(".hg-scheduler");
  await expect(scheduler.locator(".hg-slot").first()).toBeVisible();
  await scheduler.locator(".hg-slot").nth(1).click();
  await expect(scheduler.locator(".hg-slot").nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(scheduler.getByLabel("Name", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
