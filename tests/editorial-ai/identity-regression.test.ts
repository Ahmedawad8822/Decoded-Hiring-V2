/**
 * EDITORIAL AI — IDENTITY REGRESSION TEST (Mission 07 §1)
 * ---------------------------------------------------------------------------
 * Guards against reintroduction of the prototype contamination that leaked
 * "builders" / GCC-compiler voice / "production features" into the editorial
 * skill identity (system prompt, seeded memory, and fake-provider output).
 *
 * PURE unit test: no database, no Miniflare. Runs in milliseconds.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "../../src/features/editorial-ai/skills/aha-authority";
import { SEEDED_MEMORY } from "../../src/features/editorial-ai/memory/types";
import { FakeProvider } from "../../src/features/editorial-ai/providers/fake";
import type { LLMGenerateInput } from "../../src/features/editorial-ai/providers/index";

// Tokens that originated from the pre-R02 prototype voice and must never
// appear in editorial identity content again.
const FORBIDDEN = [
  // Obvious prototype contamination (pre-R02)
  "builders",
  "gcc",
  "gcc-audited",
  "gcc 13",
  "gcc_context",
  "compiler",
  "production features",
  "production systems",
  // Subtle contamination — software-engineering framing that must NOT
  // describe Decoded Hiring as a "software engineering learning platform"
  "learning platform that helps engineers",
  "ship better software",
  "codebase",
  "working engineers",
  "senior engineer",
  "building and operating real software",
  "language, or runtime",
];

// Positive assertions — the editorial identity MUST affirm the Decoded
// Hiring recruitment / talent-acquisition brand.
const REQUIRED_IDENTITY_TERMS = [
  "talent acquisition",
  "recruiter",
  "hiring",
];

function assertClean(text: string, label: string): void {
  const hay = (text || "").toLowerCase();
  for (const term of FORBIDDEN) {
    assert.ok(
      !hay.includes(term.toLowerCase()),
      `${label} contains forbidden prototype term "${term}"`,
    );
  }
}

function assertHasIdentity(text: string, label: string): void {
  const hay = (text || "").toLowerCase();
  const found = REQUIRED_IDENTITY_TERMS.some((term) =>
    hay.includes(term.toLowerCase()),
  );
  assert.ok(
    found,
    `${label} must include recruitment / Talent Acquisition identity — found none of: ${REQUIRED_IDENTITY_TERMS.join(", ")}`,
  );
}

test("identity: AHA_AUTHORITY_V1 system prompt is free of prototype contamination", () => {
  const prompt = buildSystemPrompt();
  assertClean(prompt, "AHA_AUTHORITY_V1 system prompt");
  assertHasIdentity(prompt, "AHA_AUTHORITY_V1 system prompt");
});

test("identity: SEEDED_MEMORY is free of prototype contamination", () => {
  for (const mem of SEEDED_MEMORY) {
    assertClean(mem.content, `seeded memory "${mem.content.slice(0, 40)}"`);
  }
});

test("identity: system prompt affirms Decoded Hiring recruitment identity", () => {
  assertHasIdentity(buildSystemPrompt(), "AHA_AUTHORITY_V1 system prompt");
});

test("identity: FakeProvider sample output is free of prototype contamination", async () => {
  const provider = new FakeProvider();
  const input: LLMGenerateInput = {
    skillId: "AHA_AUTHORITY_V1",
    context: { retrievedChunks: [], memory: [], contextChars: 0 },
    params: {
      contentType: "GUIDE",
      topic: "Evidence-Based Engineering",
      audience: "working engineers",
      angle: "surfacing the unexpected",
    },
  };
  const output = await provider.generateDraft(input);
  assertClean(output.title, "FakeProvider.title");
  assertClean(output.excerpt ?? "", "FakeProvider.excerpt");
  assertClean(output.metaDescription, "FakeProvider.metaDescription");
  assertClean(output.reasoning ?? "", "FakeProvider.reasoning");
  for (const block of output.contentBlocks) {
    const text = (block as { text?: string }).text ?? "";
    assertClean(text, `FakeProvider.block(${block.type})`);
    const label = (block as { label?: string }).label;
    if (label) assertClean(label, "FakeProvider.callout.label");
  }
});
