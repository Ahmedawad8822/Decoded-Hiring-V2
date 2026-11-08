import { hashPassword, verifyPassword } from "better-auth/crypto";

// Public examples and disposable local harnesses only. Keep these synchronized
// with .env.example, scripts/cpu-routes.ts and scripts/worker-e2e-setup.ts.
const FIXTURE_PASSWORDS = new Set([
  "admin-local-dev-password-2026!",
  "worker-e2e-fixture-password-2026!",
  "profile-admin-password-2026!",
  "profile-learner-password-2026!",
]);
const FIXTURE_SECRETS = new Set([
  "profile-cpu-secret-0123456789abcdefghijklmnop",
  "your_32_char_minimum_secret_key_here",
  "test-only-not-a-real-secret-0123456789abcdef",
  "ci-only-not-a-real-secret-0123456789abcdef",
]);

type CredentialEnv = Record<string, string | undefined>;

/** Only configured loopback origins may use fixtures in a production build.
 * This allows local `next start` / workerd E2E, never a hosted test or live site.
 * Request Host/Origin headers cannot opt into this policy.
 */
export function isLocalCredentialContext(env: CredentialEnv): boolean {
  const origins = [env.BETTER_AUTH_URL, env.NEXT_PUBLIC_SITE_URL].filter(Boolean) as string[];
  if (!origins.length) return env.NODE_ENV !== "production";
  return origins.every((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        !url.username && !url.password;
    } catch {
      return false;
    }
  });
}

export function assertSafePassword(password: string, local: boolean): void {
  if (!local && FIXTURE_PASSWORDS.has(password)) {
    throw new Error("Public fixture passwords are forbidden outside local development.");
  }
}

export function assertSafeAuthSecret(secret: string, env: CredentialEnv): void {
  if (!isLocalCredentialContext(env) && FIXTURE_SECRETS.has(secret)) {
    throw new Error("Public fixture auth secrets are forbidden outside local development.");
  }
}

// Use Better Auth's own scrypt format. These hooks cover signup, password reset
// and sign-in, including an existing credential row imported by mistake.
export async function hashAuthPassword(password: string): Promise<string> {
  assertSafePassword(password, isLocalCredentialContext(process.env));
  return hashPassword(password);
}

export async function verifyAuthPassword(data: { password: string; hash: string }): Promise<boolean> {
  if (!isLocalCredentialContext(process.env) && FIXTURE_PASSWORDS.has(data.password)) return false;
  return verifyPassword(data);
}
