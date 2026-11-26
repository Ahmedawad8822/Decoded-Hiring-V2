// ============================================================================
// AI COURSE OUTLINE — SERVICE
// ----------------------------------------------------------------------------
// draftCourseOutline({ courseId, brief }): retrieve knowledge chunks (FTS5),
// build a grounded prompt, ask the provider for structured outline JSON,
// validate it with zod, sanitize it (never trust model output), and return
// it. Stateless — no outline rows are persisted; the instructor applies the
// parts they want via applyCourseOutline().
//
// applyCourseOutline(input): create the selected sections/lessons in ONE D1
// batch, appended after the existing curriculum, all unpublished. Existing
// rows are never touched (INSERTs only).
//
// Provider seam (reuses Website Editorial AI, no new SDK):
//   - resolveProvider()/getProviderEnv()/isProviderNotConfigured() from
//     editorial-ai/providers (fail-closed when no key is configured).
//   - FakeProvider.generateOutline() for tests and local dev (deterministic).
//   - Real providers go through the same OpenAI-compatible chat completions
//     call as OpenAIProvider (response_format json_object).
// ============================================================================

import { getDb } from "@/lib/db";
import { courseSections, lessons } from "@/lib/db";
import { asc, eq } from "drizzle-orm";
import { getAdminCourseById } from "../courses/service";
import { retrieveKnowledge } from "../editorial-ai/knowledge/retrieval";
import type { RetrievedChunk } from "../editorial-ai/knowledge/types";
import {
  getProviderEnv,
  isProviderNotConfigured,
  resolveProvider,
  type LLMProvider,
} from "../editorial-ai/providers";
import type { FakeProvider } from "../editorial-ai/providers/fake";
import { slugifyTitle } from "../publishing/types";
import { buildAdminAuditStatement, recordAdminAudit } from "../audit/service";
import { consumePublicFixedWindowLimit } from "../public-intake/rate-limit";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { AppError } from "@/lib/errors";
import {
  applyOutlineSchema,
  outlineBriefSchema,
  type ApplyOutlineInput,
  type ApplyOutlineResult,
  type CourseOutlineDraft,
  type OutlineBrief,
} from "./types";
import {
  buildOutlineSystemPrompt,
  buildOutlineUserPrompt,
  sanitizeOutline,
  stripHtml,
} from "./skill";

/** Admin outline drafts per hour (scope-anchored fixed window on the actor). */
export const OUTLINE_DRAFTS_PER_HOUR = 20;

const NO_EVIDENCE_MESSAGE =
  "No relevant evidence found for this topic in the knowledge library. Upload a knowledge source that covers this topic, then try again.";

const PROVIDER_UNCONFIGURED_MESSAGE =
  "AI outline drafts are unavailable: no provider key is configured. Set the editorial model credentials, then try again.";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export async function draftCourseOutline(
  brief: OutlineBrief,
  actorId: string,
  opts?: {
    provider?: LLMProvider;
    /**
     * Test seam: return raw model JSON directly instead of calling a
     * provider. Lets tests feed malformed or ungrounded output.
     * Never set in production code.
     */
    generateRawJson?: () => Promise<unknown>;
  },
): Promise<CourseOutlineDraft> {
  const parsed = outlineBriefSchema.parse(brief);

  const course = await getAdminCourseById(parsed.courseId);
  if (!course) throw new AppError("not_found", `Course with id "${parsed.courseId}" not found`);

  // Rate limit BEFORE the retrieval + provider work: 20 drafts/admin/hour.
  const allowed = await consumePublicFixedWindowLimit({
    scopeKey: `ai-outline-generate:${actorId}`,
    now: new Date(),
    windowMinutes: 60,
    maxCount: OUTLINE_DRAFTS_PER_HOUR,
  });
  if (!allowed) {
    throw new AppError(
      "invalid",
      `Outline draft limit reached (${OUTLINE_DRAFTS_PER_HOUR} per hour). Please try again later.`,
    );
  }

  const searchQuery = [parsed.topic, parsed.audience, parsed.outcomes].filter(Boolean).join(" ");
  const chunks = await retrieveKnowledge({ query: searchQuery, topK: 8 });
  if (chunks.length === 0) {
    throw new AppError("invalid", NO_EVIDENCE_MESSAGE);
  }

  let raw: unknown;
  if (opts?.generateRawJson) {
    raw = await opts.generateRawJson();
  } else {
    let provider: LLMProvider;
    try {
      provider = opts?.provider ?? (await resolveProvider());
    } catch (err) {
      if (isProviderNotConfigured(err)) throw new AppError("invalid", PROVIDER_UNCONFIGURED_MESSAGE);
      throw err;
    }
    raw = await generateRawOutline(provider, parsed, chunks);
  }

  let draft: CourseOutlineDraft;
  try {
    draft = sanitizeOutline(raw, chunks);
  } catch (err) {
    console.error("[ai-outline] model output failed validation:", err);
    throw new AppError("invalid", "The AI returned an outline we could not use. Please try again.");
  }
  const lessonCount = draft.sections.reduce((n, s) => n + s.lessons.length, 0);
  if (draft.sections.length === 0 || lessonCount === 0) {
    throw new AppError(
      "invalid",
      "The AI outline was empty after safety checks. Please try a more specific brief.",
    );
  }

  await recordAdminAudit({
    actorId,
    action: "course.ai_outline_generate",
    entityType: "course",
    entityId: parsed.courseId,
    details: {
      sections: draft.sections.length,
      lessons: lessonCount,
      topic: parsed.topic.slice(0, 200),
    },
  });

  return draft;
}

function hasFakeOutline(
  provider: LLMProvider,
): provider is LLMProvider & Pick<FakeProvider, "generateOutline"> {
  return (
    provider.name === "fake" &&
    typeof (provider as Partial<FakeProvider>).generateOutline === "function"
  );
}

async function generateRawOutline(
  provider: LLMProvider,
  brief: OutlineBrief,
  chunks: RetrievedChunk[],
): Promise<unknown> {
  if (hasFakeOutline(provider)) {
    return provider.generateOutline({
      topic: brief.topic,
      chunks: chunks.map((c) => ({
        chunkId: c.chunkId,
        sourceId: c.sourceId,
        sourceTitle: c.sourceTitle,
        heading: c.heading,
        ordinal: c.ordinal,
        content: c.content,
      })),
    });
  }
  return generateOutlineViaOpenAI(brief, chunks);
}

/**
 * Real-provider call: same OpenAI-compatible chat completions convention as
 * editorial-ai OpenAIProvider (response_format json_object, bounded tokens).
 */
async function generateOutlineViaOpenAI(
  brief: OutlineBrief,
  chunks: RetrievedChunk[],
): Promise<unknown> {
  const env = getProviderEnv();
  if (!env.baseUrl || !env.apiKey || !env.modelName) {
    throw new AppError("invalid", PROVIDER_UNCONFIGURED_MESSAGE);
  }
  let response: Response;
  try {
    response = await fetch(`${env.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiKey}`,
      },
      body: JSON.stringify({
        model: env.modelName,
        messages: [
          { role: "system", content: buildOutlineSystemPrompt() },
          { role: "user", content: buildOutlineUserPrompt(brief, chunks) },
        ],
        response_format: { type: "json_object" },
        temperature: env.temperature,
        max_tokens: env.maxTokens,
      }),
    });
  } catch (err) {
    console.error("[ai-outline] provider request failed:", err);
    throw new AppError("invalid", "The AI provider could not be reached. Please try again.");
  }
  if (!response.ok) {
    console.error("[ai-outline] provider error:", response.status, response.statusText);
    throw new AppError("invalid", "The AI provider returned an error. Please try again.");
  }
  const data = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new AppError("invalid", "The AI returned an empty outline. Please try again.");
  }
  const cleaned = content.trim().replace(/^```[a-z]*\n/, "").replace(/\n```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AppError("invalid", "The AI returned an outline we could not use. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// Apply (create selected sections/lessons as drafts, appended, one batch)
// ---------------------------------------------------------------------------

export async function applyCourseOutline(
  input: ApplyOutlineInput,
  actorId: string,
): Promise<ApplyOutlineResult> {
  const parsed = applyOutlineSchema.parse(input);

  const course = await getAdminCourseById(parsed.courseId);
  if (!course) throw new AppError("not_found", `Course with id "${parsed.courseId}" not found`);

  const db = await getDb();
  const [existingSections, existingLessons] = await Promise.all([
    db
      .select({ position: courseSections.position })
      .from(courseSections)
      .where(eq(courseSections.courseId, parsed.courseId))
      .orderBy(asc(courseSections.position)),
    db.select({ slug: lessons.slug }).from(lessons).where(eq(lessons.courseId, parsed.courseId)),
  ]);
  const takenSlugs = new Set(existingLessons.map((l) => l.slug));
  const nextSectionPosition =
    existingSections.length > 0 ? Math.max(...existingSections.map((s) => s.position)) + 1 : 0;

  const now = new Date();
  const sectionStatements = [];
  const lessonStatements = [];
  const sectionIds: string[] = [];
  const lessonIds: string[] = [];
  let lessonCount = 0;

  for (let si = 0; si < parsed.sections.length; si++) {
    const section = parsed.sections[si]!;
    const sectionTitle = stripHtml(section.title).slice(0, 160);
    if (!sectionTitle) {
      throw new AppError("invalid", "Every selected section needs a title.");
    }
    const sectionId = newId("section");
    sectionIds.push(sectionId);
    sectionStatements.push(
      db.insert(courseSections).values({
        id: sectionId,
        courseId: parsed.courseId,
        title: sectionTitle,
        position: nextSectionPosition + si,
        createdAt: now,
        updatedAt: now,
      }),
    );
    for (let li = 0; li < section.lessons.length; li++) {
      const lesson = section.lessons[li]!;
      const lessonTitle = stripHtml(lesson.title).slice(0, 160);
      const summary = stripHtml(lesson.summary).slice(0, 500);
      if (!lessonTitle || !summary) {
        throw new AppError("invalid", "Every selected lesson needs a title and a summary.");
      }
      const duration =
        typeof lesson.durationMinutes === "number" &&
        Number.isInteger(lesson.durationMinutes) &&
        lesson.durationMinutes >= 1 &&
        lesson.durationMinutes <= 600
          ? lesson.durationMinutes
          : null;
      const slug = uniqueLessonSlug(lessonTitle, takenSlugs);
      takenSlugs.add(slug);
      const lessonId = newId("lesson");
      lessonIds.push(lessonId);
      lessonCount += 1;
      // The summary is stored as the first paragraph block — the lesson
      // editor edits structured blocks, so the draft opens with real content.
      const body = JSON.stringify([
        { id: `cb_${crypto.randomUUID().slice(0, 12)}`, type: "paragraph", text: summary },
      ]);
      lessonStatements.push(
        db.insert(lessons).values({
          id: lessonId,
          courseId: parsed.courseId,
          sectionId,
          title: lessonTitle,
          slug,
          body,
          videoUrl: null,
          required: true,
          isPreview: false,
          durationMinutes: duration,
          position: li,
          status: "draft",
          createdAt: now,
          updatedAt: now,
          publishedAt: null,
        }),
      );
    }
  }

  // INSERTs only — no existing row is read for writing, so the current
  // curriculum cannot change. The audit row joins the same atomic batch
  // (actor is available here, so prefer it over a post-commit write).
  const auditStatement = buildAdminAuditStatement(db, {
    actorId,
    action: "course.ai_outline_apply",
    entityType: "course",
    entityId: parsed.courseId,
    details: { sections: sectionIds.length, lessons: lessonCount },
  });

  try {
    // Audit statement first so the batch tuple is statically non-empty.
    await db.batch([auditStatement, ...sectionStatements, ...lessonStatements]);
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    throw new AppError(
      "conflict",
      "A lesson slug clashed with an existing lesson while adding the outline. Please try again.",
    );
  }

  return {
    sectionIds,
    lessonIds,
    sectionCount: sectionIds.length,
    lessonCount,
  };
}

function uniqueLessonSlug(title: string, taken: Set<string>): string {
  const base = slugifyTitle(title).slice(0, 80) || "lesson";
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`.slice(0, 100);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`.slice(0, 100);
}
