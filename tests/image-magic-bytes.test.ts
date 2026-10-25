/**
 * IMAGE MAGIC BYTES: uploads are validated against the real file signature,
 * not the client-declared MIME type, and are stored with the sniffed type.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first.

import { AppError, httpStatusFor, publicErrorMessage } from "../src/lib/errors";
import { uploadMedia } from "../src/lib/media/service";
import { sniffImageType } from "../src/lib/uploads/sniff";
import { IMAGE_FIXTURES } from "./helpers/image-fixtures";

const enc = (s: string) => new TextEncoder().encode(s);

test("sniffImageType detects each allowed image type", () => {
  for (const [mime, bytes] of Object.entries(IMAGE_FIXTURES)) {
    assert.equal(sniffImageType(bytes), mime);
    assert.equal(sniffImageType(bytes.slice().buffer), mime, `${mime} via ArrayBuffer`);
  }
});

test("sniffImageType detects AVIF via compatible brands and avis", () => {
  const compat = new Uint8Array([0, 0, 0, 0x20, ...enc("ftyp"), ...enc("mif1"), 0, 0, 0, 0, ...enc("mif1"), ...enc("avif")]);
  assert.equal(sniffImageType(compat), "image/avif");
  const seq = new Uint8Array([0, 0, 0, 0x14, ...enc("ftyp"), ...enc("avis"), 0, 0, 0, 0]);
  assert.equal(sniffImageType(seq), "image/avif");
});

test("sniffImageType rejects SVG, HTML, PDF, empty, truncated and non-avif ISO files", () => {
  assert.equal(sniffImageType(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImageType(enc("<?xml version='1.0'?><svg/>")), null);
  assert.equal(sniffImageType(enc("<html><script>alert(1)</script>")), null);
  assert.equal(sniffImageType(enc("%PDF-1.7")), null);
  assert.equal(sniffImageType(new Uint8Array(0)), null);
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(sniffImageType(enc("RIFF\u0000\u0000\u0000\u0000WAVEfmt ")), null);
  const mp4 = new Uint8Array([0, 0, 0, 0x14, ...enc("ftypisom"), 0, 0, 0, 0]);
  assert.equal(sniffImageType(mp4), null);
});

function fakeDeps() {
  const puts: { key: string; options: unknown }[] = [];
  return {
    puts,
    deps: {
      bucket: {
        put: async (key: string, _b: ArrayBuffer | Uint8Array, options?: unknown) => {
          puts.push({ key, options });
        },
        delete: async () => {},
      },
      record: async () => {},
    },
  };
}

test("uploadMedia rejects content that does not match the declared type", async () => {
  const cases: [string, Uint8Array][] = [
    ["image/png", enc("<html><script>alert(1)</script></html>")],
    ["image/png", IMAGE_FIXTURES["image/jpeg"]], // valid image, wrong declaration
    ["image/jpeg", enc("%PDF-1.7 hostile")],
    ["image/gif", enc('<svg onload="alert(1)"/>')],
  ];
  for (const [contentType, buffer] of cases) {
    const { puts, deps } = fakeDeps();
    await assert.rejects(
      uploadMedia({ buffer, filename: "x", contentType }, deps),
      (e: unknown) => {
        assert.ok(e instanceof AppError);
        assert.equal(httpStatusFor(e), 400);
        assert.equal(publicErrorMessage(e, "Upload failed"), "File content does not match an allowed image type.");
        return true;
      }
    );
    assert.equal(puts.length, 0, "nothing written to R2");
  }
});

test("uploadMedia stores the sniffed content type and matching extension", async () => {
  for (const [mime, buffer] of Object.entries(IMAGE_FIXTURES)) {
    const { puts, deps } = fakeDeps();
    const result = await uploadMedia({ buffer, filename: "cover", contentType: ` ${mime.toUpperCase()} ` }, deps);
    assert.equal(result.contentType, mime);
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].options, { httpMetadata: { contentType: mime } });
    assert.ok(puts[0].key.endsWith(`.${mime === "image/jpeg" ? "jpg" : mime.split("/")[1]}`));
  }
});
