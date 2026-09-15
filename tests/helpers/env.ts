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
const FAKE_TEST_SECRET = "test-only-not-a-real-secret-0123456789abcdef";

if (!process.env.BETTER_AUTH_SECRET) {
  process.env.BETTER_AUTH_SECRET = FAKE_TEST_SECRET;
}
