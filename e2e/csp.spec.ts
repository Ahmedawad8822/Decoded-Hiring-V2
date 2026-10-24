import { test, expect, type ConsoleMessage } from "@playwright/test";

// Verifies the static Content-Security-Policy header is present on every key
// surface and that real page loads trigger no CSP violations.
const routes = [
  "/",
  "/guides",
  "/field-notes",
  "/coaching",
  "/workshop",
  "/about",
  "/login",
  "/admin/login",
  "/learn", // redirects (to login) for anonymous visitors
];

type CspWindow = { __cspViolations: string[] };

for (const route of routes) {
  test(`CSP header present and no violations: ${route}`, async ({ page }) => {
    const consoleCsp: string[] = [];
    page.on("console", (msg: ConsoleMessage) => {
      const text = msg.text();
      if (/content security policy|violates the following/i.test(text)) {
        consoleCsp.push(text);
      }
    });
    await page.addInitScript(() => {
      (window as unknown as CspWindow).__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        (window as unknown as CspWindow).__cspViolations.push(
          `${e.violatedDirective} blocked ${e.blockedURI}`,
        );
      });
    });

    const response = await page.goto(route);
    expect(response).not.toBeNull();
    const csp = response!.headers()["content-security-policy"];
    expect(csp, "CSP header").toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("frame-src https://www.youtube-nocookie.com");

    await page.waitForLoadState("networkidle");
    const violations = await page.evaluate(
      () => (window as unknown as CspWindow).__cspViolations,
    );
    expect(violations).toEqual([]);
    expect(consoleCsp).toEqual([]);
  });
}
