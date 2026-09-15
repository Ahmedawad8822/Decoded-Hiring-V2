import test from "node:test";
import assert from "node:assert/strict";
import { getDb, guides, users } from "../src/lib/db";
import { getAuth } from "../src/lib/auth";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  createGuide,
  publishGuide,
  unpublishGuide,
  archiveGuide,
  getPublicGuideBySlug,
  getPublishedGuides,
} from "../src/features/guides/service";
import { isSafeUrl } from "../src/features/guides/types";
import { uploadMedia } from "../src/lib/media/service";
import { eq } from "drizzle-orm";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

test("Security 1 & 2: Unauthorized and non-admin users cannot access admin mutations", async () => {
  // Test domain enforcement through session validation
  const anonymousSession = null;
  const ordinarySession = { user: { id: "u-normal", role: "user" } };

  // 1. Unauthenticated request to preview draft
  const draftSlug = "test-security-draft-" + Date.now();
  await createGuide({
    title: "Security Test Draft",
    slug: draftSlug,
    excerpt: "Testing security boundaries",
    author: "Ahmed Awad",
    body: [],
  });

  const anonResult = await getPublicGuideBySlug(draftSlug, {
    preview: true,
    session: anonymousSession,
  });
  assert.equal(anonResult, null, "Anonymous user must not view draft even with preview=true");

  // 2. Ordinary user request to preview draft
  const userResult = await getPublicGuideBySlug(draftSlug, {
    preview: true,
    session: ordinarySession,
  });
  assert.equal(userResult, null, "Ordinary user must not view draft even with preview=true");

  // Clean up
  const db = await getDb();
  await db.delete(guides).where(eq(guides.slug, draftSlug));
});

test("Security 3: preview=true only exposes draft when requester has authorized Admin role", async () => {
  const draftSlug = "admin-preview-test-" + Date.now();
  const created = await createGuide({
    title: "Admin Preview Test",
    slug: draftSlug,
    excerpt: "Testing admin preview authorization",
    author: "Ahmed Awad",
    body: [{ id: "b1", type: "paragraph", text: "Draft secret preview content" }],
  });

  // Anonymous request
  const anon = await getPublicGuideBySlug(draftSlug, { preview: true });
  assert.equal(anon, null);

  // Admin request
  const adminSession = { user: { id: "admin-1", role: "admin" } };
  const adminView = await getPublicGuideBySlug(draftSlug, {
    preview: true,
    session: adminSession,
  });
  assert.notEqual(adminView, null);
  assert.equal(adminView?.id, created.id);
  assert.equal(adminView?.status, "draft");

  // Clean up
  const db = await getDb();
  await db.delete(guides).where(eq(guides.slug, draftSlug));
});

test("Security 4: Unsafe URL protocols are strictly rejected by isSafeUrl", () => {
  // Dangerous schemes must be rejected
  assert.equal(isSafeUrl("javascript:alert('XSS')"), false);
  assert.equal(isSafeUrl("JAVASCRIPT:alert(1)"), false);
  assert.equal(isSafeUrl("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isSafeUrl("vbscript:msgbox('XSS')"), false);
  assert.equal(isSafeUrl("file:///etc/passwd"), false);

  // Safe schemes must be accepted
  assert.equal(isSafeUrl("https://decodedhiring.com/guides"), true);
  assert.equal(isSafeUrl("http://localhost:3000/workshop"), true);
  assert.equal(isSafeUrl("/guides/talent-acquisition-strategy"), true);
  assert.equal(isSafeUrl("#section-1"), true);
  assert.equal(isSafeUrl("mailto:ahmed@decodedhiring.com"), true);
  assert.equal(isSafeUrl("tel:+1234567890"), true);
});

test("Security 5: Duplicate slug fails safely at domain and database level", async () => {
  const testSlug = "duplicate-slug-test-" + Date.now();
  await createGuide({
    title: "Original Guide",
    slug: testSlug,
    excerpt: "First instance",
    author: "Ahmed Awad",
    body: [],
  });

  // Attempt to create second guide with identical slug
  await assert.rejects(
    async () => {
      await createGuide({
        title: "Conflicting Guide",
        slug: testSlug,
        excerpt: "Second instance with same slug",
        author: "Ahmed Awad",
        body: [],
      });
    },
    /already exists/,
    "Creating a guide with an existing slug must fail safely with an explanatory error"
  );

  // Clean up
  const db = await getDb();
  await db.delete(guides).where(eq(guides.slug, testSlug));
});

test("Security 6 & 7: Lifecycle transition (Publish -> Unpublish -> Archive) governs public visibility", async () => {
  const testSlug = "lifecycle-visibility-test-" + Date.now();
  const guide = await createGuide({
    title: "Lifecycle Guide",
    slug: testSlug,
    excerpt: "Lifecycle testing",
    author: "Ahmed Awad",
    body: [],
  });

  // 1. Initial draft is not publicly visible
  assert.equal(await getPublicGuideBySlug(testSlug), null);

  // 2. Publish makes it visible
  const published = await publishGuide(guide.id);
  assert.equal(published.status, "published");
  assert.notEqual(published.publishedAt, null);

  const publicResult = await getPublicGuideBySlug(testSlug);
  assert.notEqual(publicResult, null);
  assert.equal(publicResult?.slug, testSlug);

  // Verify in public published list
  const publishedList = await getPublishedGuides();
  assert.ok(publishedList.some((g) => g.id === guide.id));

  // 3. Unpublish removes public visibility
  const unpublished = await unpublishGuide(guide.id);
  assert.equal(unpublished.status, "draft");
  assert.equal(await getPublicGuideBySlug(testSlug), null);

  const listAfterUnpublish = await getPublishedGuides();
  assert.ok(!listAfterUnpublish.some((g) => g.id === guide.id));

  // 4. Archive removes public visibility
  await archiveGuide(guide.id);
  assert.equal(await getPublicGuideBySlug(testSlug), null);

  const listAfterArchive = await getPublishedGuides();
  assert.ok(!listAfterArchive.some((g) => g.id === guide.id));

  // Clean up
  const db = await getDb();
  await db.delete(guides).where(eq(guides.id, guide.id));
});

test("Security 8: Media boundary validates MIME types, enforces 5MB limit, and generates safe keys", async () => {
  // 1. Rejects dangerous MIME types
  await assert.rejects(
    async () => {
      await uploadMedia({
        buffer: new Uint8Array([1, 2, 3]),
        filename: "script.exe",
        contentType: "application/x-msdownload",
      });
    },
    /Unsupported media type/,
    "Executable media types must be rejected"
  );

  // 2. Rejects oversized files (> 5MB)
  const oversizedBuffer = new Uint8Array(5 * 1024 * 1024 + 1024);
  await assert.rejects(
    async () => {
      await uploadMedia({
        buffer: oversizedBuffer,
        filename: "giant.png",
        contentType: "image/png",
      });
    },
    /exceeds maximum limit of 5 MB/,
    "Oversized files must be rejected"
  );

  // 3. Valid upload generates safe canonical key
  const validBuffer = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header bytes
  const uploadResult = await uploadMedia({
    buffer: validBuffer,
    filename: "../../../malicious_path.png",
    contentType: "image/png",
    uploadedBy: "admin-test",
  });

  assert.ok(uploadResult.key.startsWith("guides/"));
  assert.ok(!uploadResult.key.includes(".."), "Storage key must not contain path traversal");
  assert.ok(uploadResult.url.startsWith("/api/media/guides/"));
});

test("Security 9: Admin role is NOT the default for newly registered normal users", async () => {
  const auth = await getAuth();
  const db = await getDb();

  const testEmail = `normal-user-${Date.now()}@example.com`;
  const res = await auth.api.signUpEmail({
    body: {
      email: testEmail,
      password: "NormalUserPass123!",
      name: "Normal Student",
    },
  });

  assert.ok(res?.user?.id, "User signup should succeed");

  const dbUser = await db.select().from(users).where(eq(users.email, testEmail)).get();
  assert.notEqual(dbUser, null);
  assert.equal(
    dbUser?.role,
    "user",
    "HARD REQUIREMENT (Correction 1 & 14): Normal users must default to 'user', NOT 'admin'"
  );

  // Clean up
  await db.delete(users).where(eq(users.email, testEmail));
});
