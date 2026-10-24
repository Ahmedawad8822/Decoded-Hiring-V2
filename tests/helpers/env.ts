/**
 * SHARED TEST BOOTSTRAP — Mission 06 (final quality remediation, item A).
 *
 * `npm test` runs each suite through tsx, which does NOT load .env.local.
 * Application code correctly fails closed without BETTER_AUTH_SECRET
 * (no committed fallback secret), so tests must provide their own secret.
 *
 * This file is the ONE place test environment mutation happens:
 *  - a clearly fake TEST-ONLY BETTER_AUTH_SECRET is supplied when absent;
 *  - nothing here is imported by production code;
 *  - any operator-exported value always wins (never overwritten).
 *
 * Import this module FIRST in every test suite entry point, before any
 * application module is evaluated.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FAKE_TEST_SECRET = "test-only-not-a-real-secret-0123456789abcdef";

if (!process.env.BETTER_AUTH_SECRET) {
  process.env.BETTER_AUTH_SECRET = FAKE_TEST_SECRET;
}


/**
 * Mission 08.2 regression seam. Production code exposes the trusted booking
 * actor helpers only when this test-only flag is explicitly set.
 */
process.env.DH_BOOKING_LIFECYCLE_TEST_SEAM = "1";


/**
 * Mission 08.5 regression seam. Production code exposes trusted manual-payment
 * helpers only when this test-only flag is explicitly set.
 */
process.env.DH_COMMERCE_TEST_SEAM = "1";


/**
 * Per-process throwaway D1/R2 state. Each `tsx` suite gets its own empty
 * Miniflare persistence dir so tests never read or write the developer's
 * `.wrangler/state/v3` (dev server, seeds, E2E). Must be set before
 * `getCloudflareBindings()` first resolves; an operator-exported value wins.
 * Removed on exit, best-effort (never masks a test failure).
 */
if (!process.env.DH_LOCAL_STATE_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-test-"));
  process.env.DH_LOCAL_STATE_DIR = dir;
  process.on("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  });
}
