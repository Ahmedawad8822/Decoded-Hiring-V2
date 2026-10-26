/**
 * Same-origin media URLs (CSP img-src 'self') and AppError-based offer
 * validation messages surfacing through the Studio commerce operations.
 */
import "./helpers/env";

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { createCommerceAdminOperations } from "@/features/commerce/admin-operations";
import { createOffer } from "@/features/offers/service";
import { isSafeMediaUrl } from "@/features/publishing/types";
import { isAppError } from "@/lib/errors";

before(async () => {
  await migrateLocalDb();
});
after(async () => {
  await disposeCloudflareBindings();
});

test("isSafeMediaUrl: same-origin /api/media paths only", () => {
  const accept = [
    "/api/media/field-notes/cover-abc123.png",
    "/api/media/guides/cover.jpg",
    "  /api/media/x.webp  ",
  ];
  const reject: Array<string | null | undefined> = [
    null,
    undefined,
    "",
    "https://cdn.example.com/c.png",
    "http://example.com/c.png",
    "//evil.example/c.png",
    "/api/media//evil.example/c.png",
    "/api/media/../secret",
    "/api/media/",
    "/api/media/a b.png",
    "/api/media/a\\b.png",
    "/api/media/a\nb.png",
    "/other/path.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "blob:https://x/1",
  ];
  for (const url of accept) assert.equal(isSafeMediaUrl(url), true, `ACCEPT ${url}`);
  for (const url of reject) assert.equal(isSafeMediaUrl(url), false, `REJECT ${String(url)}`);
});

test("offer service validation throws AppError('invalid') with the real message", async () => {
  await assert.rejects(
    () =>
      createOffer({
        kind: "COURSE",
        title: "No course",
        slug: "no-course-" + Date.now(),
        accessMode: "FREE",
      } as never),
    (error: unknown) =>
      isAppError(error) &&
      error.kind === "invalid" &&
      /COURSE offers must link to a course/.test(error.message),
  );
});

test("Studio createOffer action result carries the validation message, not the fallback", async () => {
  const ops = createCommerceAdminOperations(async () => ({ id: "admin-x" }));
  const result = await ops.createOffer({
    kind: "COURSE",
    title: "No course",
    slug: "no-course-b-" + Date.now(),
    accessMode: "FREE",
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /COURSE offers must link to a course/);
  assert.notEqual(result.error, "Failed to create Offer.");

  const missing = await ops.updateOffer({ id: "offer_missing_0001", title: "Missing offer" });
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /Offer not found/);
});
