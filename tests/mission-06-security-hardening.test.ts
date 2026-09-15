import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { uploadMedia } from "../src/lib/media/service";
import { resolveAuthSecret } from "../src/lib/auth";

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
