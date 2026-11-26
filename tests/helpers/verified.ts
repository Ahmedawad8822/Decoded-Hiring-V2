// Sign-in requires a verified email. Test fixtures created with
// auth.api.signUpEmail mark themselves verified before signing in, the same
// state clicking the emailed link produces.
export async function markEmailVerified(userId: string): Promise<void> {
  const { getDb, users } = await import("../../src/lib/db");
  const { eq } = await import("drizzle-orm");
  await (await getDb()).update(users).set({ emailVerified: true }).where(eq(users.id, userId));
}
