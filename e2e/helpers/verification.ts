import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page } from "@playwright/test";

// Email verification is required for sign-in. The dev server queues the real
// verification email in the local D1 outbox (SMTP is not configured locally),
// so tests read that row and follow the same link a learner would click.

function localD1Files(): string[] {
  const root = path.resolve(process.env.DH_LOCAL_STATE_DIR || ".wrangler/state/v3");
  const dir = path.join(root, "d1", "miniflare-D1DatabaseObject");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => path.join(dir, name));
}

function readVerificationLink(email: string): string | undefined {
  for (const file of localD1Files()) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const table = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'email_outbox'`).get();
      if (!table) continue;
      const row = db
        .prepare(
          `SELECT text_body AS textBody FROM email_outbox
           WHERE kind = 'email_verification' AND to_address = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(email.toLowerCase()) as { textBody: string } | undefined;
      const url = row?.textBody.match(/https?:\/\/\S+\/verify-email\?\S+/)?.[0];
      if (url) return url;
    } finally {
      db.close();
    }
  }
  return undefined;
}

/** Newest verification link queued for `email`, as path + query (host-independent). */
export async function verificationPath(email: string): Promise<string> {
  let url: string | undefined;
  await expect
    .poll(() => (url = readVerificationLink(email)), { timeout: 30_000, message: `verification email for ${email}` })
    .toBeTruthy();
  const parsed = new URL(url!);
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * After submitting the sign-up form: the page asks the learner to check their
 * inbox; following the emailed link verifies, signs in, and Continue lands on
 * the classroom.
 */
export async function completeSignupVerification(page: Page, email: string) {
  await expect(page.getByText(/We sent a verification link to/)).toBeVisible({ timeout: 90_000 });
  await page.goto(await verificationPath(email));
  await expect(page.getByRole("heading", { name: "Your email is verified." })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: "Continue to your courses" }).click();
  await expect(page).toHaveURL(/\/learn/, { timeout: 90_000 });
}
