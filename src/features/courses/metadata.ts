import type { Course, Lesson } from "@/lib/db";
import { faqSchema, outcomesSchema } from "./types";

function parseJson(raw: string | null): unknown {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function parseCourseLanding(course: Pick<Course, "outcomes" | "faq">) {
  return {
    outcomes: outcomesSchema.safeParse(parseJson(course.outcomes)).data ?? [],
    faq: faqSchema.safeParse(parseJson(course.faq)).data ?? [],
  };
}

type TimedLesson = Pick<Lesson, "id" | "status" | "durationMinutes">;
function validDuration(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= 600;
}

export function formatMinutes(minutes: number | null): string | null {
  return minutes !== null && Number.isInteger(minutes) && minutes >= 0 ? `${minutes} min` : null;
}

/** Null means no published lesson has a duration; zero means all timed lessons are finished. */
export function getCourseTimeStats(lessons: TimedLesson[], completedIds: Iterable<string> = []) {
  const published = lessons.filter((lesson) => lesson.status === "published");
  const timed = published.filter((lesson) => validDuration(lesson.durationMinutes));
  const completed = new Set(completedIds);
  return {
    lessonCount: published.length,
    totalMinutes: timed.length ? timed.reduce((sum, lesson) => sum + lesson.durationMinutes!, 0) : null,
    minutesLeft: timed.length ? timed.reduce((sum, lesson) => sum + (completed.has(lesson.id) ? 0 : lesson.durationMinutes!), 0) : null,
  };
}

export function lessonTypeHint(lesson: Pick<Lesson, "videoUrl">, hasResources = false): string {
  return `${lesson.videoUrl ? "Video" : "Reading"}${hasResources ? " + files" : ""}`;
}

/** "Video · 8 min" — durations outside the Studio range (1–600) are omitted. */
export function lessonMetaLabel(lesson: Pick<Lesson, "videoUrl" | "durationMinutes">, hasResources = false): string {
  const hint = lessonTypeHint(lesson, hasResources);
  return validDuration(lesson.durationMinutes) ? `${hint} · ${formatMinutes(lesson.durationMinutes)}` : hint;
}
