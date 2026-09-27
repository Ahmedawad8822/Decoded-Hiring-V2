import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

function localEnv(key: string): string {
  const direct = process.env[key];
  if (direct) return direct;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf-8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
      if (match && match[1] === key) return match[2].trim();
    }
  } catch {
    // CI passes explicit test-only credentials.
  }
  return "";
}

const ADMIN_EMAIL = localEnv("ADMIN_INITIAL_EMAIL");
const ADMIN_PASSWORD = localEnv("ADMIN_INITIAL_PASSWORD");

async function signInAdmin(page: Page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto("/admin/login", { waitUntil: "domcontentloaded" });
    await page.getByLabel(/Admin Email/).fill(ADMIN_EMAIL);
    await page.getByLabel(/^Password/).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in to Studio" }).click();
    const signedIn = await page
      .waitForURL(/\/admin\/content/, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (signedIn) return;
    if (attempt === 0) {
      await page.waitForTimeout(250);
      continue;
    }
  }
  await expect(page).toHaveURL(/\/admin\/content/, { timeout: 5_000 });
}

async function assertNoHorizontalOverflow(page: Page, url: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const metrics = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const viewport = window.innerWidth;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          node:
            node.id
              ? `${node.tagName.toLowerCase()}#${node.id}`
              : `${node.tagName.toLowerCase()}.${Array.from(node.classList).slice(0, 3).join(".")}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        };
      })
      .filter(
        (item) =>
          item.right > viewport + 1 ||
          item.left < -1 ||
          item.scrollWidth > item.clientWidth + 1,
      )
      .sort((a, b) => Math.max(b.right - viewport, b.scrollWidth - b.clientWidth) - Math.max(a.right - viewport, a.scrollWidth - a.clientWidth))
      .slice(0, 12);
    return {
      overflow: root.scrollWidth - viewport,
      rootScrollWidth: root.scrollWidth,
      viewport,
      offenders,
    };
  });
  expect(
    metrics.overflow,
    `${url} @ ${width}px overflow; metrics=${JSON.stringify(metrics)}`,
  ).toBeLessThanOrEqual(1);
}

async function assertSemanticFormControls(page: Page) {
  const unlabeled = await page
    .locator(
      'input:not([type="hidden"]):not([tabindex="-1"]), textarea, select',
    )
    .evaluateAll((controls) =>
      controls
        .filter((node) => {
          const el = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          if (el.closest('[aria-hidden="true"]')) return false;
          if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) {
            return false;
          }
          if (el.closest("label")) return false;
          if (!el.id) return true;
          return !document.querySelector(
            `label[for="${CSS.escape(el.id)}"]`,
          );
        })
        .map((node) => ({
          tag: node.tagName,
          id: (node as HTMLElement).id,
          name: node.getAttribute("name"),
        })),
    );
  expect(unlabeled).toEqual([]);
  await expect(page.locator("img:not([alt])")).toHaveCount(0);
}

test.beforeAll(() => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      "Mission 08 final E2E requires ADMIN_INITIAL_EMAIL and ADMIN_INITIAL_PASSWORD.",
    );
  }
});

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await page.goto("/admin/login", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page
      .getByLabel(/Admin Email/)
      .waitFor({ state: "visible", timeout: 10_000 });

    for (const [route, payload] of [
      ["/api/auth/sign-in/email", {}],
      ["/api/auth/sign-up/email", {}],
    ] as const) {
      const response = await page.request.post(route, { data: payload });
      if (response.status() < 400 || response.status() > 499) {
        throw new Error(
          `auth warm-up failed for ${route}: HTTP ${response.status()}`,
        );
      }
    }

    const session = await page.request.get("/api/auth/get-session");
    if (session.status() > 499) {
      throw new Error(
        `auth session warm-up failed: HTTP ${session.status()}`,
      );
    }

    try {
      await page.goto("/admin/commerce", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch {
      // Best-effort cold-page compilation warm. The real assertions remain strict.
    }
  } finally {
    await page.close();
  }
});

test.describe("Mission 08 final integrated certification", () => {
  test.describe.configure({ mode: "serial" });

  test("anonymous booking reaches durable confirmation and becomes observable in Studio", async ({
    page,
  }) => {
    test.setTimeout(240_000);

    await test.step("admin route denies anonymous user", async () => {
      await page.goto("/admin/commerce");
      await expect(page).toHaveURL(/\/admin\/login/);
    });

    await test.step("public coaching CTA is keyboard-operable", async () => {
      await page.goto("/coaching");
      const cta = page.getByRole("link", { name: "Choose a time" }).first();
      await expect(cta).toBeVisible();
      await cta.focus();
      await expect(cta).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/#hg-coaching-schedule$/);
      await expect(page.locator(".hg-scheduler")).toBeVisible();
    });

    const run = Date.now().toString(36);
    await test.step("public scheduler confirms a real D1 booking", async () => {
      const scheduler = page.locator(".hg-scheduler");
      await scheduler.getByLabel("Name").fill("Mission Eight E2E");
      await scheduler
        .getByLabel("Work email")
        .fill(`mission08-${run}@example.com`);
      await scheduler
        .getByLabel("Useful context (optional)")
        .fill("Browser certification context.");
      await scheduler
        .getByRole("checkbox", {
          name: /I understand my details are used to reserve this time/i,
        })
        .check();
      await scheduler.getByRole("button", { name: "Reserve this time" }).click();
      await expect(
        page.getByRole("status").getByText("Time reserved"),
      ).toBeVisible({ timeout: 90_000 });
      await expect(page.getByText(/Booking reference:/)).toBeVisible();
    });

    await test.step("Studio exposes the reconstructed business funnel", async () => {
      await page.context().clearCookies();
      await signInAdmin(page);
      await page.goto("/admin/commerce");
      await expect(
        page.getByRole("heading", { name: "Scheduling & Commerce" }),
      ).toBeVisible();
      const funnel = page.getByRole("region", {
        name: "30-day commerce funnel",
      });
      await expect(funnel).toBeVisible();
      await expect(funnel.getByText("Booking starts", { exact: true })).toBeVisible();
      await expect(funnel.getByText("Confirmed", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Provider readiness" }),
      ).toBeVisible();
      await expect(page.getByText("NOT CONFIGURED").first()).toBeVisible();

      const confirmedCard = funnel
        .getByText("Confirmed", { exact: true })
        .locator("..");
      const confirmedText = await confirmedCard.textContent();
      const confirmedMatch = confirmedText?.match(/Confirmed\s*(\d+)/);
      expect(Number(confirmedMatch?.[1] ?? 0)).toBeGreaterThan(0);
    });

    await test.step("server projections do not leak provider-secret shapes", async () => {
      const html = await page.content();
      expect(html).not.toMatch(/sk_live_|secret[_-]?key|providerPaymentId|providerCheckoutId/i);
    });
  });

  test("responsive and semantic accessibility matrix stays usable", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await signInAdmin(page);

    const widths = [320, 375, 430, 768, 1024, 1440];
    const urls = ["/coaching", "/workshop", "/admin/commerce"];

    for (const width of widths) {
      for (const url of urls) {
        await assertNoHorizontalOverflow(page, url, width);
      }
    }

    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/coaching");
    await assertSemanticFormControls(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

    await page.goto("/admin/commerce");
    await assertSemanticFormControls(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });
});
