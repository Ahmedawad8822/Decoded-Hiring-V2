import { cache } from "react";
import { redirect } from "next/navigation";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { getDb, users, sessions, accounts, verifications } from "../db";
import { AppError } from "@/lib/errors";
import { authAdvancedIpOptions, buildAuthRateLimitOptions } from "./rate-limit";

/**
 * Resolve the Better Auth secret from environment configuration ONLY.
 *
 * SECURITY (Mission 06 hardening): there is intentionally NO committed
 * fallback secret. Authentication fails closed — when BETTER_AUTH_SECRET
 * is absent this throws, in every environment including production.
 * Local development provides it via environment configuration
 * (.env.local, never committed).
 */
export function resolveAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Missing BETTER_AUTH_SECRET environment variable. Authentication is disabled until it is configured."
    );
  }
  return secret;
}

function createAuth(db: Parameters<typeof drizzleAdapter>[0]) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    // Correction 1: normal users default to "user", staff get "admin"
    plugins: [
      admin({
        defaultRole: "user",
        adminRole: "admin",
      }),
    ],
    // Durable per-client throttling on D1 (see ./rate-limit).
    rateLimit: buildAuthRateLimitOptions(),
    advanced: { ipAddress: authAdvancedIpOptions() },
    secret: resolveAuthSecret(),
    baseURL:
      process.env.BETTER_AUTH_URL ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      "http://localhost:3000",
  });
}

/**
 * Build the Better Auth instance once per REQUEST.
 *
 * NO cross-request singleton: React `cache()` memoizes per server request
 * (server components, actions, route handlers) and is discarded when the
 * request ends, so every request still resolves its DB binding and secret
 * from its own runtime context. A process-lifetime singleton would pin the
 * first request's DB binding and secret, which breaks per-request runtime
 * resolution (local dev, tests, any future runtime adapter). Outside a React
 * server request (e.g. plain `tsx` tests) `cache()` does not memoize.
 * Fail-closed BETTER_AUTH_SECRET behavior is unchanged.
 */
export const getAuth = cache(async () => {
  const db = await getDb();
  return createAuth(db);
});

/** Request-cached session lookup (null outside a request). */
export const getServerSession = cache(async () => {
  const auth = await getAuth();
  try {
    const { headers } = await import("next/headers");
    const reqHeaders = await headers();
    return auth.api.getSession({
      headers: reqHeaders,
    });
  } catch {
    return null;
  }
});

/**
 * Admin page gate for server components: anonymous -> /admin/login,
 * non-admin -> /admin/login?error=forbidden, otherwise returns the session.
 * Not placed in admin/layout.tsx because /admin/login lives under it.
 */
export async function requireAdminPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/admin/login");
  const role = (session.user as { role?: string }).role;
  if (role !== "admin") redirect("/admin/login?error=forbidden");
  return session;
}

export async function requireAdmin() {
  const session = await getServerSession();
  if (!session?.user) {
    throw new AppError("unauthorized", "Unauthorized: You must be signed in");
  }
  const userRole = (session.user as { role?: string }).role;
  if (userRole !== "admin") {
    throw new AppError("forbidden", "Forbidden: Admin access required");
  }
  return session;
}

export async function requireUser() {
  const session = await getServerSession();
  if (!session?.user) {
    throw new AppError("unauthorized", "Unauthorized: You must be signed in");
  }
  return session;
}
