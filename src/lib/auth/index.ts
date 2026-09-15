import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { getDb, users, sessions, accounts, verifications } from "../db";

let authInstance: ReturnType<typeof createAuth> | null = null;

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
    secret:
      process.env.BETTER_AUTH_SECRET ||
      "f1bed6a0d2752258d32844c5994846d3979df731f35f7339c2b5e5bb33c4d6cc",
    baseURL:
      process.env.BETTER_AUTH_URL ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      "http://localhost:3000",
  });
}

export async function getAuth() {
  const db = await getDb();
  if (!authInstance) {
    authInstance = createAuth(db);
  }
  return authInstance;
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
