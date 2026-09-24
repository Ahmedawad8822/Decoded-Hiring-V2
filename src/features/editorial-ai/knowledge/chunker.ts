// ============================================================================
// EDITORIAL AI DOMAIN — KNOWLEDGE CHUNKER
// ----------------------------------------------------------------------------
// Deterministic text/markdown chunking for the private knowledge library.
//
// Design goals:
//  - Normalize whitespace carefully (no stray control chars, collapse runs).
//  - Preserve paragraph boundaries where possible.
//  - Preserve heading structure (## heading → chunk heading context).
//  - Avoid tiny useless chunks and huge context blobs (bounded chunk size).
//  - Preserve source ordering (ordinal is deterministic and stable).
//  - Produce deterministic output for identical source content.
//  - No expensive tokenizer — split on whitespace and markdown headings only.
//
// Chunk shape: { ordinal, heading, content, contentHash, characterCount }
// ============================================================================

const DEFAULT_MAX_CHARS = 2000; // ~300-400 words; bounded for context windows
const DEFAULT_MIN_CHARS = 200;  // avoid tiny chunks below this
const DEFAULT_OVERLAP = 200;    // modest overlap between adjacent chunks

export interface KnowledgeChunkInput {
  /** 0-based position in the source document. */
  ordinal: number;
  /** Nearest preceding heading, if any. */
  heading: string | null;
  /** The chunk text body. */
  content: string;
  /** SHA-256 of the chunk content (computed by the caller or here). */
  contentHash: string;
  /** characterCount === content.length. */
  characterCount: number;
}

export interface ChunkerOptions {
  maxChars?: number;
  minChars?: number;
  overlap?: number;
}

export interface ChunkerResult {
  chunks: KnowledgeChunkInput[];
  totalChars: number;
}

/**
 * Split a single markdown/text document into deterministic, ordered chunks.
 *
 * Strategy (heading-aware):
 *  1. Normalize whitespace.
 *  2. Split into blocks on ATX headings (## …) and blank-line-separated paragraphs.
 *  3. Accumulate blocks into a chunk until maxChars, carrying heading context.
 *  4. When a chunk would exceed maxChars and is already >= minChars, flush it
 *     and start a new one (with optional overlap from the previous chunk).
 *  5. Each chunk records the most recent heading as its `heading`.
 */
export function chunkText(
  raw: string,
  opts: ChunkerOptions = {}
): ChunkerResult {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  const normalized = normalizeWhitespace(raw);
  const blocks = splitBlocks(normalized);

  const chunks: KnowledgeChunkInput[] = [];
  let ordinal = 0;
  let current: string[] = [];
  let currentLen = 0;
  let currentHeading: string | null = null;

  function flush() {
    if (currentLen === 0) return;
    const content = current.join("\n").trim();
    if (content.length === 0) {
      current = [];
      currentLen = 0;
      return;
    }
    chunks.push({
      ordinal,
      heading: currentHeading,
      content,
      contentHash: hashContent(content),
      characterCount: content.length,
    });
    ordinal++;
    current = [];
    currentLen = 0;
  }

  for (const block of blocks) {
    if (block.type === "heading") {
      // A heading always starts a new logical section. Flush the current
      // chunk so the heading is attached to the next one.
      flush();
      currentHeading = block.text;
      continue;
    }

    const para = block.text;
    const newLen = currentLen + (currentLen > 0 ? 1 : 0) + para.length;

    if (newLen > maxChars && currentLen >= minChars) {
      flush();
      // Carry a modest overlap from the previous paragraph into the new chunk
      // so boundary concepts aren't lost.
      if (overlap > 0 && para.length > overlap && currentHeading) {
        const tail = para.slice(0, overlap);
        current = [tail];
        currentLen = tail.length;
      }
    }
    current.push(para);
    currentLen = newLen;
  }

  flush();

  // Recompute ordinals if overlap changed the ordering (they stay 0..N-1).
  // The ordinal reflects final position, which is deterministic.
  for (let i = 0; i < chunks.length; i++) {
    chunks[i]!.ordinal = i;
  }

  return {
    chunks,
    totalChars: normalized.length,
  };
}

/** Collapse whitespace runs, trim line ends, but PRESERVE blank-line separators. */
export function normalizeWhitespace(text: string): string {
  // Remove NUL and other control characters (except \n/\r which we normalise)
  let cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Normalise line endings: \r\n -> \n, \r -> \n
  cleaned = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const lines = cleaned.split("\n");
  const result: string[] = [];
  let prevWasBlank = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    const isBlank = trimmed.length === 0;

    // Skip leading blank lines
    if (result.length === 0 && isBlank) continue;
    // Collapse consecutive blank lines into one
    if (isBlank && prevWasBlank) continue;

    result.push(isBlank ? "" : trimmed.replace(/\s+/g, " "));
    prevWasBlank = isBlank;
  }

  // Trim trailing blank lines
  while (result.length > 0 && result[result.length - 1] === "") {
    result.pop();
  }

  return result.join("\n");
}

type Block = { type: "heading"; text: string } | { type: "paragraph"; text: string };

/**
 * Split normalized text into heading and paragraph blocks.
 * Headings are lines starting with 1-6 `#` characters followed by space.
 * Paragraphs are blank-line-separated text runs.
 */
export function splitBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];

  let currentPara: string[] = [];
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      // Flush any pending paragraph
      if (currentPara.length > 0) {
        blocks.push({ type: "paragraph", text: currentPara.join(" ").trim() });
        currentPara = [];
      }
      blocks.push({ type: "heading", text: headingMatch[1]!.trim() });
    } else if (line === "") {
      if (currentPara.length > 0) {
        blocks.push({ type: "paragraph", text: currentPara.join(" ").trim() });
        currentPara = [];
      }
    } else {
      currentPara.push(line);
    }
  }
  if (currentPara.length > 0) {
    blocks.push({ type: "paragraph", text: currentPara.join(" ").trim() });
  }

  return blocks;
}

/**
 * SHA-256 hex digest of chunk content. Uses Node's crypto (available in
 * Workers runtime). Deterministic: identical content → identical hash.
 */
export function hashContent(content: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("crypto") as typeof import("crypto");
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Compute the SHA-256 hex digest of original file bytes (for duplicate
 * detection at the source level).
 */
export function hashBytes(buffer: ArrayBuffer | Uint8Array): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("crypto") as typeof import("crypto");
  const buf = buffer instanceof Uint8Array ? Buffer.from(buffer) : Buffer.from(buffer);
  return crypto.createHash("sha256").update(buf).digest("hex");
}
