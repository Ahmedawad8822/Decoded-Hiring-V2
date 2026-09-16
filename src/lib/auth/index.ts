import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { getDb, users, sessions, accounts, verifications } from "../db";

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
    secret: resolveAuthSecret(),
    baseURL:
      process.env.BETTER_AUTH_URL ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      "http://localhost:3000",
  });
}

export async function getAuth() {
  // NO cross-request singleton: auth is always created from the CURRENT
  // runtime DB/environment context. Caching the first instance would pin
  // the first request's resolved DB binding and secret for the process
  // lifetime, which breaks per-request runtime resolution (local dev,
  // tests, and any future runtime adapter each resolve independently).
  // Fail-closed BETTER_AUTH_SECRET behavior is unchanged.
  const db = await getDb();
  return createAuth(db);
}

export async function getServerSession() {
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
}

export async function requireAdmin() {
  const session = await getServerSession();
  if (!session?.user) {
    throw new Error("Unauthorized: You must be signed in");
  }
  const userRole = (session.user as { role?: string }).role;
  if (userRole !== "admin") {
    throw new Error("Forbidden: Admin access required");
  }
  return session;
}

export async function requireUser() {
  const session = await getServerSession();
  if (!session?.user) {
    throw new Error("Unauthorized: You must be signed in");
  }
  return session;
}
