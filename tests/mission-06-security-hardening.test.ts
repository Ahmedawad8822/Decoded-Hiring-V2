import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.
import * as fs from "node:fs";
import * as path from "node:path";
import { uploadMedia, MAX_MEDIA_FILE_SIZE } from "../src/lib/media/service";
import { MAX_COURSE_RESOURCE_SIZE } from "../src/lib/course-resources/service";
import { isRequestBodyOverLimit, MULTIPART_ENVELOPE_ALLOWANCE } from "../src/lib/upload-limits";
import { resolveLessonResourceAccess } from "../src/lib/course-resources/access";
import { resolveAuthSecret } from "../src/lib/auth";
import type { Enrollment } from "../src/lib/db";

// ============================================================================
// MISSION 06 SECURITY HARDENING REGRESSION TESTS
// Covers the four pre-existing repo risks corrected before final review:
//  1. No hardcoded auth fallback (fail closed without BETTER_AUTH_SECRET)
//  2. No dev quick-fill credential endpoint
//  3. SVG uploads rejected
//  4. Editorial R2 orphan cleanup when the DB insert fails after put()
// This file uses injected fakes only — it never touches Miniflare/R2/D1.
// ============================================================================

const REPO_ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// 1. Auth secret: fail closed, no fallback
// ---------------------------------------------------------------------------

test("SEC-AUTH-1: missing BETTER_AUTH_SECRET fails closed (no fallback secret)", async () => {
  const saved = process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_SECRET;
  try {
    assert.throws(() => resolveAuthSecret(), /Missing BETTER_AUTH_SECRET/);
  } finally {
    if (saved !== undefined) process.env.BETTER_AUTH_SECRET = saved;
  }
});

test("SEC-AUTH-2: missing BETTER_AUTH_SECRET fails closed in production too", async () => {
  const savedSecret = process.env.BETTER_AUTH_SECRET;
  const env = process.env as Record<string, string | undefined>;
  const savedNodeEnv = env.NODE_ENV;
  delete process.env.BETTER_AUTH_SECRET;
  env.NODE_ENV = "production";
  try {
    assert.throws(() => resolveAuthSecret(), /Missing BETTER_AUTH_SECRET/);
  } finally {
    if (savedSecret !== undefined) process.env.BETTER_AUTH_SECRET = savedSecret;
    if (savedNodeEnv !== undefined) env.NODE_ENV = savedNodeEnv;
    else delete env.NODE_ENV;
  }
});

test("SEC-AUTH-3: configured BETTER_AUTH_SECRET is returned (env-only, no committed value)", async () => {
  const saved = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = "unit-test-secret-from-environment-only";
  try {
    assert.equal(resolveAuthSecret(), "unit-test-secret-from-environment-only");
  } finally {
    if (saved !== undefined) process.env.BETTER_AUTH_SECRET = saved;
    else delete process.env.BETTER_AUTH_SECRET;
  }
});

// ---------------------------------------------------------------------------
// 2. Dev quick-fill endpoint is gone (never serves credentials over HTTP)
// ---------------------------------------------------------------------------

test("SEC-QUICKFILL-1: /api/dev/quick-fill route file does not exist", async () => {
  const routePath = path.join(REPO_ROOT, "src", "app", "api", "dev", "quick-fill", "route.ts");
  assert.equal(
    fs.existsSync(routePath),
    false,
    "src/app/api/dev/quick-fill/route.ts must be deleted"
  );
});

test("SEC-QUICKFILL-2: admin login UI has no quick-fill client usage", async () => {
  const loginPath = path.join(REPO_ROOT, "src", "app", "admin", "login", "page.tsx");
  const source = fs.readFileSync(loginPath, "utf-8");
  assert.ok(!source.includes("quick-fill"), "admin login UI must not reference quick-fill");
  assert.ok(
    !source.includes("ADMIN_INITIAL_PASSWORD"),
    "admin login UI must not touch the admin bootstrap password"
  );
});

// ---------------------------------------------------------------------------
// 3. SVG uploads rejected (Guides + Field Notes)
// ---------------------------------------------------------------------------

for (const namespace of ["guides", "field-notes"] as const) {
  test(`SEC-SVG: image/svg+xml rejected for ${namespace}`, async () => {
    await assert.rejects(
      () =>
        uploadMedia({
          buffer: new Uint8Array([60, 115, 118, 103]),
          filename: "evil.svg",
          contentType: "image/svg+xml",
          namespace,
        }),
      /Unsupported media type/
    );
  });
}

test("SEC-SVG: SVG rejected case-insensitively with surrounding whitespace", async () => {
  await assert.rejects(
    () =>
      uploadMedia({
        buffer: new Uint8Array([60, 115, 118, 103]),
        filename: "evil.svg",
        contentType: "  IMAGE/SVG+XML  ",
      }),
    /Unsupported media type/
  );
});

test("SEC-SVG: allowed raster types still accepted (JPEG/PNG/WebP/AVIF/GIF)", async () => {
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"];
  for (const contentType of allowed) {
    const puts: string[] = [];
    const records: unknown[] = [];
    const result = await uploadMedia(
      {
        buffer: new Uint8Array([1, 2, 3]),
        filename: "cover",
        contentType,
        namespace: "guides",
      },
      {
        bucket: {
          put: async (key: string) => {
            puts.push(key);
          },
          delete: async () => {},
        },
        record: async (row) => {
          records.push(row);
        },
      }
    );
    assert.ok(result.key.startsWith("guides/"), `${contentType} key namespace`);
    assert.equal(puts.length, 1, `${contentType} stored once`);
    assert.equal(records.length, 1, `${contentType} metadata recorded once`);
  }
});

// ---------------------------------------------------------------------------
// 4. Editorial R2 cleanup when DB insert fails after put()
// ---------------------------------------------------------------------------

function makeFakeBucket(options?: { deleteFails?: boolean }) {
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    puts,
    deletes,
    bucket: {
      put: async (key: string) => {
        puts.push(key);
      },
      delete: async (key: string) => {
        deletes.push(key);
        if (options?.deleteFails) throw new Error("simulated cleanup failure");
      },
    },
  };
}

test("SEC-CLEANUP-1: DB failure after put() deletes the orphaned R2 object", async () => {
  const fake = makeFakeBucket();
  await assert.rejects(
    () =>
      uploadMedia(
        {
          buffer: new Uint8Array([137, 80, 78, 71]),
          filename: "cover.png",
          contentType: "image/png",
          namespace: "guides",
        },
        {
          bucket: fake.bucket,
          record: async () => {
            throw new Error("simulated DB failure");
          },
        }
      ),
    /simulated DB failure/
  );
  assert.equal(fake.puts.length, 1, "object was written before the DB insert");
  assert.equal(fake.deletes.length, 1, "orphaned object cleanup attempted once");
  assert.equal(fake.deletes[0], fake.puts[0], "cleanup deletes the exact orphaned key");
});

test("SEC-CLEANUP-2: cleanup failure does not hide the original DB failure", async () => {
  const fake = makeFakeBucket({ deleteFails: true });
  await assert.rejects(
    () =>
      uploadMedia(
        {
          buffer: new Uint8Array([137, 80, 78, 71]),
          filename: "note-cover.png",
          contentType: "image/png",
          namespace: "field-notes",
        },
        {
          bucket: fake.bucket,
          record: async () => {
            throw new Error("simulated DB failure");
          },
        }
      ),
    /simulated DB failure/,
    "original DB error must surface, not the cleanup error"
  );
  assert.equal(fake.deletes.length, 1, "cleanup was still attempted");
});

// ---------------------------------------------------------------------------
// 5. Multipart request-body envelope allowance (three-layer size defense)
// ---------------------------------------------------------------------------
// Layer 1 (Content-Length) deliberately allows a small, explicit
// multipart/form envelope on top of the FILE limit so a valid file AT the
// limit + envelope is not false-rejected; the exact FILE limit is still
// enforced by File.size (layer 2) and service byteLength (layer 3).

test("BODY-LIMIT: valid file at/near the 5 MB limit + envelope passes the header guard", () => {
  const fileAtLimit = MAX_MEDIA_FILE_SIZE; // 5 MB
  const smallEnvelope = 32 * 1024; // typical multipart headers + fields
  assert.equal(
    isRequestBodyOverLimit(fileAtLimit + smallEnvelope, MAX_MEDIA_FILE_SIZE),
    false,
    "5 MB file + envelope must NOT be rejected by the header guard"
  );
  // Clean boundary: file at limit + the full explicit allowance is still OK.
  assert.equal(
    isRequestBodyOverLimit(MAX_MEDIA_FILE_SIZE + MULTIPART_ENVELOPE_ALLOWANCE, MAX_MEDIA_FILE_SIZE),
    false
  );
});

test("BODY-LIMIT: body clearly above the 5 MB file limit + safe envelope -> 413", () => {
  // 5 MB file + 2 MB envelope is far beyond the safe allowance -> reject.
  assert.equal(
    isRequestBodyOverLimit(MAX_MEDIA_FILE_SIZE + 2 * 1024 * 1024, MAX_MEDIA_FILE_SIZE),
    true
  );
  // One byte over the allowance boundary also trips the guard.
  assert.equal(
    isRequestBodyOverLimit(MAX_MEDIA_FILE_SIZE + MULTIPART_ENVELOPE_ALLOWANCE + 1, MAX_MEDIA_FILE_SIZE),
    true
  );
});

test("BODY-LIMIT: course PDF at/near the 10 MB limit + envelope passes; clearly above -> reject", () => {
  assert.equal(
    isRequestBodyOverLimit(MAX_COURSE_RESOURCE_SIZE + 64 * 1024, MAX_COURSE_RESOURCE_SIZE),
    false,
    "10 MB PDF + envelope must NOT be rejected by the header guard"
  );
  assert.equal(
    isRequestBodyOverLimit(MAX_COURSE_RESOURCE_SIZE + 3 * 1024 * 1024, MAX_COURSE_RESOURCE_SIZE),
    true,
    "10 MB PDF + 3 MB envelope must trip the header guard"
  );
});

test("BODY-LIMIT: the EXACT file limit remains enforced (service byteLength layer)", async () => {
  // The header guard's envelope allowance never leaks into the file limit:
  // a buffer 1 byte over the FILE limit is still rejected by the service's
  // byteLength validation (layer 3), and a file exactly AT the limit passes
  // the size gate. Rejections happen BEFORE any storage write, so no
  // bindings are touched.
  await assert.rejects(
    () =>
      uploadMedia({
        buffer: new Uint8Array(MAX_MEDIA_FILE_SIZE + 1),
        filename: "over.png",
        contentType: "image/png",
        namespace: "guides",
      }),
    /exceeds maximum limit of 5 MB/
  );
  await assert.rejects(
    () =>
      (async () => {
        const { uploadCourseResource } = await import("../src/lib/course-resources/service");
        await uploadCourseResource({
          buffer: new Uint8Array(MAX_COURSE_RESOURCE_SIZE + 1),
          filename: "over.pdf",
          contentType: "application/pdf",
          courseId: "c",
          lessonId: "l",
          title: "Over",
        });
      })(),
    /exceeds the 10 MB/
  );
});

// ---------------------------------------------------------------------------
// 6. Lesson-resource download authorization (admin draft access vs learners)
// ---------------------------------------------------------------------------
// ADMIN: authenticated admin may retrieve lesson resources for
// authoring/review, INCLUDING draft-lesson resources.
// NON-ADMIN: active/completed enrollment AND published lesson; anything
// unpublished answers not-found (404), no-enrollment answers forbidden (403).
// Learner access is never weakened.

function enrollment(status: "active" | "completed" | "cancelled"): Enrollment {
  return {
    id: "enroll_test",
    userId: "user_test",
    courseId: "course_test",
    status,
    accessSource: "free",
    enrolledAt: new Date(),
    completedAt: status === "completed" ? new Date() : null,
  };
}

test("RES-DL: admin + draft lesson resource -> allowed", () => {
  const verdict = resolveLessonResourceAccess({
    role: "admin",
    lessonStatus: "draft",
    enrollment: null,
  });
  assert.deepEqual(verdict, { status: "allowed" });
});

test("RES-DL: admin + published lesson resource -> allowed", () => {
  assert.deepEqual(
    resolveLessonResourceAccess({ role: "admin", lessonStatus: "published", enrollment: null }),
    { status: "allowed" }
  );
});

test("RES-DL: enrolled learner + draft lesson resource -> 404 (not-found)", () => {
  assert.deepEqual(
    resolveLessonResourceAccess({ role: "user", lessonStatus: "draft", enrollment: enrollment("active") }),
    { status: "not-found" }
  );
});

test("RES-DL: enrolled learner + published lesson resource -> allowed", () => {
  assert.deepEqual(
    resolveLessonResourceAccess({ role: "user", lessonStatus: "published", enrollment: enrollment("active") }),
    { status: "allowed" }
  );
  // Completed enrollments keep download access — learner access NOT weakened.
  assert.deepEqual(
    resolveLessonResourceAccess({ role: "user", lessonStatus: "published", enrollment: enrollment("completed") }),
    { status: "allowed" }
  );
});

test("RES-DL: cancelled enrollment + published resource -> forbidden (403)", () => {
  assert.deepEqual(
    resolveLessonResourceAccess({ role: "user", lessonStatus: "published", enrollment: enrollment("cancelled") }),
    { status: "forbidden" }
  );
});

test("RES-DL: stranger (no enrollment) + published resource -> forbidden (403)", () => {
  assert.deepEqual(
    resolveLessonResourceAccess({ role: "user", lessonStatus: "published", enrollment: null }),
    { status: "forbidden" }
  );
});

test("RES-DL: learner + missing lesson row -> not-found (404), no existence leak", () => {
  assert.deepEqual(
    resolveLessonResourceAccess({ role: "user", lessonStatus: null, enrollment: enrollment("active") }),
    { status: "not-found" }
  );
  // Admin can still retrieve a resource for review even when the lesson row
  // is missing (integrity edge) — the rule is role-first, status second.
  assert.deepEqual(
    resolveLessonResourceAccess({ role: "admin", lessonStatus: null, enrollment: null }),
    { status: "allowed" }
  );
});
