import { eq, inArray } from "drizzle-orm";
import { getDb, emailPreferences } from "../db";

// ============================================================================
// LEARNER EMAIL PREFERENCES (Batch J — course nudge opt-out)
// ----------------------------------------------------------------------------
// One row per learner. An ABSENT row means the default: opted IN
// (course_nudges true). The unsubscribe flow upserts course_nudges=false
// without sign-in via an HMAC token; a signed-in learner can flip it back.
// Unlock + nudge automations skip opted-out users (unlock emails too).
// ============================================================================

const TOKEN_CONTEXT = "course_nudges";

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET is not set.");
  return value;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256(userId + ":course_nudges") with BETTER_AUTH_SECRET, hex-encoded. */
export async function signUnsubscribeToken(userId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign({ name: "HMAC" }, key, enc.encode(`${userId}:${TOKEN_CONTEXT}`));
  return toHex(sig);
}

/** Constant-time verification; wrong-user and malformed tokens return false. */
export async function verifyUnsubscribeToken(userId: string, token: string): Promise<boolean> {
  if (!userId || !token) return false;
  let expected: string;
  try {
    expected = await signUnsubscribeToken(userId);
  } catch {
    return false;
  }
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

/** True unless the learner explicitly opted out (absent row = opted in). */
export async function getCourseNudgesOptIn(userId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select({ courseNudges: emailPreferences.courseNudges })
    .from(emailPreferences)
    .where(eq(emailPreferences.userId, userId))
    .get();
  return row?.courseNudges ?? true;
}

/** Idempotent upsert of the learner's course-reminder preference. */
export async function setCourseNudgesOptIn(userId: string, optIn: boolean): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db
    .insert(emailPreferences)
    .values({ userId, courseNudges: optIn, updatedAt: now })
    .onConflictDoUpdate({
      target: emailPreferences.userId,
      set: { courseNudges: optIn, updatedAt: now },
    });
}

/** Opt-out user ids among the given candidates (absent rows stay opted in). */
export async function getNudgeOptOuts(userIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (userIds.length === 0) return out;
  const db = await getDb();
  for (let i = 0; i < userIds.length; i += 90) {
    const rows = await db
      .select({ userId: emailPreferences.userId, courseNudges: emailPreferences.courseNudges })
      .from(emailPreferences)
      .where(inArray(emailPreferences.userId, userIds.slice(i, i + 90)));
    for (const row of rows) {
      if (!row.courseNudges) out.add(row.userId);
    }
  }
  return out;
}
