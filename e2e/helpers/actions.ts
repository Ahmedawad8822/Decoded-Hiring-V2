import { expect, type Locator, type Page } from "@playwright/test";

// Clicks an action button. The admin pages refresh themselves after a
// successful action (window.location.reload()), so callers follow this with a
// web-first assertion on the element that proves the new state rendered; those
// assertions retry across the reload. Do NOT wait for a "loading" readyState or
// "networkidle" here: a polled waitForFunction cannot observe the reload (it
// burned its full 15 s timeout on every call) and networkidle is discouraged.
//
// The click is held back until React has hydrated the button (React stamps a
// `__reactProps$...` key on hydrated DOM nodes): after a reload the SSR markup
// is visible and clickable before its onClick handler is attached, and a click
// in that window is silently lost. This replaces what the old networkidle wait
// was implicitly covering.
export async function clickAction(page: Page, target: string | Locator) {
  const button = typeof target === "string" ? page.locator(target) : target;
  await expect(button).toBeEnabled();
  await waitForHydration(page, button);
  await button.click();
}

// Waits until React has hydrated `target`. Call it BEFORE filling a form:
// hydration resets controlled inputs, so values typed into the SSR markup are
// silently cleared (seen as "Please enter both email and password").
export async function waitForHydration(page: Page, target: Locator) {
  const handle = await target.elementHandle();
  await page.waitForFunction(
    (el) => !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$")),
    handle,
  );
}
