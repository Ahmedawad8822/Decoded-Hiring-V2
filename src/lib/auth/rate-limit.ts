import {
  anonymousRateLimitFingerprint,
  consumeFixedWindowMs,
} from "@/features/public-intake/rate-limit";

/**
 * Durable Better Auth rate limiting.
 *
 * Better Auth's default limiter is in-memory, i.e. per Workers isolate, so it
 * does not hold. We plug the existing atomic D1 fixed-window primitive
 * (public_rate_limits, migration 0017) into Better Auth's `customStorage`
 * `consume` hook, so no new table or migration is needed.
 *
 * Better Auth keys buckets as `<ip>|<path>`; the key is SHA-256 hashed before
 * storage so raw client IPs are not persisted.
 */

/** Credential endpoints: sign-in / sign-up. Per client IP per path. */
export const AUTH_STRICT_LIMIT = { window: 60, max: 5 } as const;
/** Password reset / change / verification-mail flows (email-sending, abusable). */
export const AUTH_PASSWORD_FLOW_LIMIT = { window: 60, max: 5 } as const;
/** Everything else (session reads, admin plugin routes, ...). */
export const AUTH_DEFAULT_LIMIT = { window: 60, max: 120 } as const;

const STRICT_PATHS = ["/sign-in/*", "/sign-up/*"];
const PASSWORD_FLOW_PATHS = [
  "/request-password-reset",
  "/forget-password",
  "/forget-password/*",
  "/reset-password",
  "/reset-password/*",
  "/change-password",
  "/change-email",
  "/send-verification-email",
];

/**
 * TEST-ONLY seam: DH_AUTH_RATE_LIMIT_DISABLED=1 turns the limiter off so
 * suites/E2E that sign in repeatedly from one loopback IP are not throttled.
 * It is ignored when NODE_ENV is "production", so it can never weaken a
 * deployed environment.
 */
export function authRateLimitDisabledForTests(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.DH_AUTH_RATE_LIMIT_DISABLED === "1"
  );
}

/** Cloudflare puts the real client address in cf-connecting-ip. */
export function authAdvancedIpOptions() {
  return { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] };
}

/**
 * Unthrottled paths. Session reads are cheap and frequent; throttling them
 * would cost one D1 write per read against the free-tier write budget.
 */
const UNLIMITED_PATHS = ["/get-session"];

export function buildAuthRateLimitOptions() {
  const customRules: Record<string, { window: number; max: number } | false> = {};
  for (const path of STRICT_PATHS) customRules[path] = { ...AUTH_STRICT_LIMIT };
  for (const path of PASSWORD_FLOW_PATHS) {
    customRules[path] = { ...AUTH_PASSWORD_FLOW_LIMIT };
  }
  for (const path of UNLIMITED_PATHS) customRules[path] = false;
  return {
    enabled: !authRateLimitDisabledForTests(),
    ...AUTH_DEFAULT_LIMIT,
    customRules,
    customStorage: {
      async consume(key: string, rule: { window: number; max: number }) {
        const scopeKey = `auth:${await anonymousRateLimitFingerprint(key)}`;
        const result = await consumeFixedWindowMs({
          scopeKey,
          now: new Date(),
          windowMs: rule.window * 1000,
          maxCount: rule.max,
        });
        return {
          allowed: result.allowed,
          retryAfter: result.allowed
            ? null
            : Math.max(1, Math.ceil(result.retryAfterMs / 1000)),
        };
      },
    },
  };
}
