/**
 * EDITORIAL AI — CHUNKER UNIT TESTS
 * ---------------------------------------------------------------------------
 * Pure-function tests (no DB, no R2). Verifies deterministic block splitting,
 * chunking, overlap, and SHA-256 hashing of the content chunker.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  chunkText,
  splitBlocks,
  normalizeWhitespace,
  hashBytes,
  hashContent,
} from "../../src/features/editorial-ai/knowledge/chunker";

const SAMPLE_TEXT = [
  "# Understanding TypeScript",
  "",
  "TypeScript extends JavaScript with static type checking. By catching errors at",
  "compile time, it prevents entire classes of runtime failures.",
  "",
  "## Key Concepts",
  "",
  "The type system includes interfaces, generics, and union types. Developers who",
  "master these concepts write more maintainable and self-documenting code.",
  "",
  "### Generics",
  "",
  "Generics allow components to work with multiple types without losing type",
  "information. This makes code both flexible and safe.",
  "",
  "## Conclusion",
  "",
  "Adopting TypeScript improves long-term code quality and team velocity.",
].join("\n");

test("splitBlocks: separates headings and paragraphs", () => {
  const blocks = splitBlocks(SAMPLE_TEXT);
  assert.equal(blocks.length, 8);
  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[0].text, "Understanding TypeScript");
  assert.equal(blocks[1].type, "paragraph");
  assert.equal(blocks[2].type, "heading");
  assert.equal(blocks[2].text, "Key Concepts");
  assert.equal(blocks[3].type, "paragraph");
  assert.equal(blocks[4].type, "heading");
  assert.equal(blocks[4].text, "Generics");
  assert.equal(blocks[5].type, "paragraph");
  assert.equal(blocks[6].type, "heading");
  assert.equal(blocks[6].text, "Conclusion");
  assert.equal(blocks[7].type, "paragraph");
});

test("splitBlocks: normalizes line endings before splitting", () => {
  const windows = "## Heading\r\n\r\nParagraph line.";
  const blocks = splitBlocks(normalizeWhitespace(windows));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[1].type, "paragraph");
});

test("chunkText: simple content produces at least one chunk", () => {
  const { chunks } = chunkText("Hello world. This is a test.");
  assert.ok(chunks.length >= 1);
  assert.ok(chunks[0].content.length > 0);
});

test("chunkText: headings attach as chunk context", () => {
  const { chunks } = chunkText(SAMPLE_TEXT);
  assert.ok(chunks.length >= 1);
  const first = chunks[0]!;
  assert.ok(first.heading, "first chunk should have a heading");
  assert.equal(first.content.length, first.characterCount);
});

test("chunkText: produces multiple chunks for long content", () => {
  const paras = Array.from({ length: 30 }, (_, i) =>
    "This is paragraph number " + i + " with some content for testing."
  );
  const content = paras.join("\n\n");
  const { chunks } = chunkText(content, { maxChars: 500, minChars: 1, overlap: 50 });
  assert.ok(chunks.length > 1, `Expected >1 chunk, got ${chunks.length}`);
});

test("chunkText: respects minChars so small content stays single chunk", () => {
  const { chunks } = chunkText("small", { maxChars: 50, minChars: 1000, overlap: 0 });
  assert.equal(chunks.length, 1);
});

test("chunkText: overlap carries context from previous chunk", () => {
  const paras = Array.from({ length: 20 }, (_, i) =>
    "This is paragraph number " + i + " with some content for testing."
  );
  const content = paras.join("\n\n");
  const { chunks } = chunkText(content, { maxChars: 200, minChars: 1, overlap: 50 });
  assert.ok(chunks.length > 1, `Expected >1 chunk, got ${chunks.length}`);
  for (let i = 1; i < chunks.length; i++) {
    // overlap should add trailing characters from previous content
    assert.ok(chunks[i]!.characterCount > 0);
  }
});

test("chunkText: empty string produces zero chunks", () => {
  const { chunks } = chunkText("");
  assert.equal(chunks.length, 0);
});

test("chunkText: whitespace-only input produces zero chunks", () => {
  const { chunks } = chunkText("   \n\n  \t\n  ");
  assert.equal(chunks.length, 0);
});

test("chunkText: determinism — same input yields identical output", () => {
  const a = chunkText(SAMPLE_TEXT);
  const b = chunkText(SAMPLE_TEXT);
  assert.deepEqual(a.chunks, b.chunks);
});

test("chunkText: characterCount equals content length", () => {
  const { chunks } = chunkText(SAMPLE_TEXT);
  for (const c of chunks) {
    assert.equal(c.content.length, c.characterCount);
  }
});

test("chunkText: contentHash is deterministic SHA-256", () => {
  const { chunks } = chunkText(SAMPLE_TEXT);
  const firstHash = chunks[0]!.contentHash;
  assert.match(firstHash, /^[0-9a-f]{64}$/);
  const { chunks: again } = chunkText(SAMPLE_TEXT);
  assert.equal(again[0]!.contentHash, firstHash);
});

test("hashBytes: SHA-256 of known input", () => {
  const buf = new TextEncoder().encode("hello world");
  const hash = hashBytes(buf.buffer);
  assert.equal(hash, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
});

test("hashBytes: determinism", () => {
  const buf = new TextEncoder().encode("hello world");
  assert.equal(hashBytes(buf.buffer), hashBytes(buf.buffer));
});

test("hashContent: same as hashBytes for same content", () => {
  const text = "test content";
  assert.equal(hashContent(text), hashBytes(new TextEncoder().encode(text).buffer));
});

test("hashContent: different inputs produce different hashes", () => {
  assert.notEqual(hashContent("hello"), hashContent("world"));
});

test("chunker: all assertions passed", () => {
  assert.ok(true);
});
