"use client";
import { PageHeader, humanLabel } from "../../../_ui";
import { Button, Input, DataTable, FileDrop } from "../../../_ui";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ContentBlock } from "@/features/publishing/types";
import { StructuredBlockEditor } from "@/components/publishing/StructuredBlockEditor";
import type { Course, CourseSection, Lesson, LessonResource } from "@/lib/db";
import {
  archiveLessonAction,
  createLessonAction,
  createSectionAction,
  moveLessonAction,
  moveSectionAction,
  publishLessonAction,
  renameSectionAction,
  unpublishLessonAction,
  updateLessonAction,
  updateLessonReleaseAction,
  updateSectionReleaseAction,
} from "@/features/courses/actions";
import {
  restoreArchivedItemAction,
  trashItemAction,
} from "@/features/trash/actions";
import { deleteQuizAction, saveQuizAction } from "@/features/quizzes/actions";
import type { CourseQuizStats } from "@/features/quizzes/service";
import type { QuizDefinition } from "@/features/quizzes/types";

interface LessonEntry {
  lesson: Lesson;
  completions: number;
  resources: LessonResource[];
  quiz: QuizDefinition | null;
  quizStats: CourseQuizStats | null;
}

interface SectionEntry {
  section: CourseSection;
  lessons: LessonEntry[];
}

interface QuizDraftOption {
  id: string;
  text: string;
  tag: string;
}

interface QuizDraftQuestion {
  id: string;
  prompt: string;
  kind: "single" | "multiple";
  options: QuizDraftOption[];
  correctOptionIds: string[];
  explanation: string;
}

const LESSON_BLOCK_TYPES = ["heading", "paragraph", "blockquote", "callout", "list"] as const;

function parseBody(raw: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(raw) as ContentBlock[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function draftId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function emptyDraftQuestion(): QuizDraftQuestion {
  const first = draftId("o");
  const second = draftId("o");
  return {
    id: draftId("q"),
    prompt: "",
    kind: "single",
    options: [
      { id: first, text: "", tag: "" },
      { id: second, text: "", tag: "" },
    ],
    correctOptionIds: [first],
    explanation: "",
  };
}

function quizToDraft(quiz: QuizDefinition | null): QuizDraftQuestion[] {
  if (!quiz || quiz.questions.length === 0) return [emptyDraftQuestion()];
  return quiz.questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    kind: question.kind,
    options: question.options.map((option) => ({ id: option.id, text: option.text, tag: option.tag ?? "" })),
    correctOptionIds: [...question.correctOptionIds],
    explanation: question.explanation ?? "",
  }));
}

// Mirrors LEARNER_TAG_PATTERN in src/features/quizzes/types.ts (kept local so
// the client bundle does not pull in zod; the server schema stays authoritative).
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
function tagError(tag: string): string | null {
  const trimmed = tag.trim().toLowerCase();
  if (trimmed === "") return null;
  return TAG_PATTERN.test(trimmed)
    ? null
    : "Use lowercase letters, numbers and dashes (up to 40 characters).";
}

function draftToInput(questions: QuizDraftQuestion[]) {
  return questions.map((question) => ({
    id: question.id,
    prompt: question.prompt.trim(),
    kind: question.kind,
    options: question.options.map((option) => ({ id: option.id, text: option.text.trim(), tag: option.tag })),
    correctOptionIds: [...question.correctOptionIds],
    explanation: question.explanation.trim() || undefined,
  }));
}

// ---------------------------------------------------------------- Batch J release helpers

type ReleaseInitial = {
  releaseMode: string;
  releaseAt: Date | string | null;
  dripDays: number | null;
};

/** Short badge for the curriculum list: "Day N" / date / nothing. */
export function releaseBadge(initial: ReleaseInitial): string | null {
  if (initial.releaseMode === "drip") return `Unlocks day ${initial.dripDays ?? "?"}`;
  if (initial.releaseMode === "date" && initial.releaseAt) {
    const d = new Date(initial.releaseAt);
    if (!Number.isNaN(d.getTime())) {
      return `Unlocks ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
    }
    return "Unlocks on date";
  }
  return null;
}

/** ISO instant -> datetime-local value in the ADMIN's browser timezone. */
function toLocalInput(value: Date | string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CurriculumClient({
  course,
  sections,
  enrollmentCount,
}: {
  course: Course;
  sections: SectionEntry[];
  enrollmentCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [addingLessonTo, setAddingLessonTo] = useState<string | null>(null);
  const [lessonTitle, setLessonTitle] = useState("");
  const [lessonSlug, setLessonSlug] = useState("");
  const [editingLesson, setEditingLesson] = useState<LessonEntry | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSlug, setEditSlug] = useState("");
  const [editVideo, setEditVideo] = useState("");
  const [editPreview, setEditPreview] = useState(false);
  const [editDuration, setEditDuration] = useState("");
  const [editRequired, setEditRequired] = useState(true);
  const [editBlocks, setEditBlocks] = useState<ContentBlock[]>([]);
  const [quizDraft, setQuizDraft] = useState<QuizDraftQuestion[]>([]);
  const [quizPassPercent, setQuizPassPercent] = useState(70);
  const [quizRequirePass, setQuizRequirePass] = useState(false);

  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadingTo, setUploadingTo] = useState<string | null>(null);

  // Batch J release editors: per-section inline panel + per-lesson dialog fields.
  const [releaseOpenFor, setReleaseOpenFor] = useState<string | null>(null);
  const [releaseMode, setReleaseMode] = useState("immediate");
  const [releaseDate, setReleaseDate] = useState("");
  const [releaseDays, setReleaseDays] = useState("7");
  const [editReleaseMode, setEditReleaseMode] = useState("immediate");
  const [editReleaseDate, setEditReleaseDate] = useState("");
  const [editReleaseDays, setEditReleaseDays] = useState("7");

  const flash = (msg: string) => {
    setNotice(msg);
    setError(null);
  };

  const runAction = async (key: string, fn: () => Promise<{ ok: boolean; error?: string; notice?: string }>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error || "Action failed");
      else {
        if (res.notice) setNotice(res.notice);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  const handleCreateSection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSectionTitle.trim()) return;
    await runAction("new-section", async () => {
      const res = await createSectionAction({ courseId: course.id, title: newSectionTitle.trim() });
      if (res.ok) setNewSectionTitle("");
      return res;
    });
  };

  const handleRename = async (sectionId: string) => {
    await runAction(`rename-${sectionId}`, async () => {
      const res = await renameSectionAction({ id: sectionId, title: renameValue.trim() });
      if (res.ok) setRenamingId(null);
      return res;
    });
  };

  const openReleaseFor = (section: CourseSection) => {
    setReleaseOpenFor(section.id);
    setReleaseMode(section.releaseMode);
    setReleaseDate(toLocalInput(section.releaseAt));
    setReleaseDays(section.dripDays?.toString() ?? "7");
    setError(null);
  };

  const handleSaveRelease = async (sectionId: string) => {
    const days = Number(releaseDays);
    await runAction(`rel-${sectionId}`, async () => {
      const res = await updateSectionReleaseAction({
        id: sectionId,
        releaseMode,
        releaseAt: releaseMode === "date" ? (releaseDate ? new Date(releaseDate).toISOString() : null) : null,
        dripDays: releaseMode === "drip" ? (Number.isSafeInteger(days) ? days : null) : null,
      });
      if (res.ok) {
        setReleaseOpenFor(null);
        return { ok: true, notice: "Section release updated." };
      }
      return res;
    });
  };

  const handleSaveLessonRelease = async () => {
    if (!editingLesson) return;
    const days = Number(editReleaseDays);
    await runAction(`lrel-${editingLesson.lesson.id}`, async () => {
      const res = await updateLessonReleaseAction({
        id: editingLesson.lesson.id,
        releaseMode: editReleaseMode,
        releaseAt: editReleaseMode === "date" ? (editReleaseDate ? new Date(editReleaseDate).toISOString() : null) : null,
        dripDays: editReleaseMode === "drip" ? (Number.isSafeInteger(days) ? days : null) : null,
      });
      if (res.ok) return { ok: true, notice: "Lesson release updated." };
      return res;
    });
  };

  const handleCreateLesson = async (e: React.FormEvent, sectionId: string) => {
    e.preventDefault();
    await runAction(`add-lesson-${sectionId}`, async () => {
      const res = await createLessonAction({
        courseId: course.id,
        sectionId,
        title: lessonTitle.trim(),
        slug: lessonSlug.trim(),
        body: [],
        required: true,
      });
      if (res.ok) {
        setLessonTitle("");
        setLessonSlug("");
        setAddingLessonTo(null);
      }
      return res;
    });
  };

  const openLessonEditor = (entry: LessonEntry) => {
    setEditingLesson(entry);
    setEditTitle(entry.lesson.title);
    setEditSlug(entry.lesson.slug);
    setEditReleaseMode(entry.lesson.releaseMode);
    setEditReleaseDate(toLocalInput(entry.lesson.releaseAt));
    setEditReleaseDays(entry.lesson.dripDays?.toString() ?? "7");
    setEditVideo(entry.lesson.videoUrl || "");
    setEditRequired(entry.lesson.required);
    setEditPreview(entry.lesson.isPreview);
    setEditDuration(entry.lesson.durationMinutes?.toString() ?? "");
    setEditBlocks(parseBody(entry.lesson.body));
    setQuizDraft(quizToDraft(entry.quiz));
    setQuizPassPercent(entry.quiz?.passPercent ?? 70);
    setQuizRequirePass(entry.quiz?.requirePass ?? false);
    setError(null);
    setNotice(null);
  };

  const handleSaveLesson = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLesson) return;
    await runAction(`save-lesson-${editingLesson.lesson.id}`, async () => {
      const res = await updateLessonAction({
        id: editingLesson.lesson.id,
        title: editTitle.trim(),
        slug: editSlug.trim(),
        body: editBlocks,
        videoUrl: editVideo.trim() || null,
        required: editRequired,
        isPreview: editPreview,
        durationMinutes: editDuration === "" ? null : Number(editDuration),
      });
      if (res.ok) setEditingLesson(null);
      return res;
    });
  };

  const patchQuestion = (questionId: string, patch: Partial<QuizDraftQuestion>) => {
    setQuizDraft((questions) =>
      questions.map((question) => (question.id === questionId ? { ...question, ...patch } : question)),
    );
  };

  const addQuestion = () => {
    setQuizDraft((questions) => [...questions, emptyDraftQuestion()]);
  };

  const removeQuestion = (questionId: string) => {
    setQuizDraft((questions) =>
      questions.length === 1 ? questions : questions.filter((question) => question.id !== questionId),
    );
  };

  const moveQuestion = (index: number, direction: -1 | 1) => {
    setQuizDraft((questions) => {
      const target = index + direction;
      if (target < 0 || target >= questions.length) return questions;
      const next = [...questions];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const addOption = (questionId: string) => {
    setQuizDraft((questions) =>
      questions.map((question) =>
        question.id === questionId && question.options.length < 8
          ? { ...question, options: [...question.options, { id: draftId("o"), text: "", tag: "" }] }
          : question,
      ),
    );
  };

  const removeOption = (questionId: string, optionId: string) => {
    setQuizDraft((questions) =>
      questions.map((question) => {
        if (question.id !== questionId || question.options.length <= 2) return question;
        return {
          ...question,
          options: question.options.filter((option) => option.id !== optionId),
          correctOptionIds: question.correctOptionIds.filter((id) => id !== optionId),
        };
      }),
    );
  };

  const setOptionText = (questionId: string, optionId: string, text: string) => {
    setQuizDraft((questions) =>
      questions.map((question) =>
        question.id === questionId
          ? {
              ...question,
              options: question.options.map((option) =>
                option.id === optionId ? { ...option, text } : option,
              ),
            }
          : question,
      ),
    );
  };

  const setOptionTag = (questionId: string, optionId: string, tag: string) => {
    setQuizDraft((questions) =>
      questions.map((question) =>
        question.id === questionId
          ? {
              ...question,
              options: question.options.map((option) =>
                option.id === optionId ? { ...option, tag } : option,
              ),
            }
          : question,
      ),
    );
  };

  const toggleCorrect = (questionId: string, optionId: string) => {
    setQuizDraft((questions) =>
      questions.map((question) => {
        if (question.id !== questionId) return question;
        if (question.kind === "single") return { ...question, correctOptionIds: [optionId] };
        const selected = question.correctOptionIds.includes(optionId)
          ? question.correctOptionIds.filter((id) => id !== optionId)
          : [...question.correctOptionIds, optionId];
        return { ...question, correctOptionIds: selected };
      }),
    );
  };

  const setQuestionKind = (questionId: string, kind: "single" | "multiple") => {
    setQuizDraft((questions) =>
      questions.map((question) => {
        if (question.id !== questionId) return question;
        const correctOptionIds =
          kind === "single"
            ? question.correctOptionIds.slice(0, 1).length > 0
              ? question.correctOptionIds.slice(0, 1)
              : question.options[0]
                ? [question.options[0].id]
                : []
            : question.correctOptionIds.length > 0
              ? question.correctOptionIds
              : question.options[0]
                ? [question.options[0].id]
                : [];
        return { ...question, kind, correctOptionIds };
      }),
    );
  };

  const handleSaveQuiz = async () => {
    if (!editingLesson) return;
    await runAction(`save-quiz-${editingLesson.lesson.id}`, async () => {
      const res = await saveQuizAction({
        lessonId: editingLesson.lesson.id,
        passPercent: quizPassPercent,
        requirePass: quizRequirePass,
        questions: draftToInput(quizDraft),
      });
      if (res.ok) {
        setEditingLesson(null);
        return { ok: true, notice: "Quiz saved — learners see it on the lesson page." };
      }
      return res;
    });
  };

  const handleRemoveQuiz = async () => {
    if (!editingLesson) return;
    if (!window.confirm("Remove this quiz? All recorded attempts will be deleted.")) return;
    await runAction(`remove-quiz-${editingLesson.lesson.id}`, async () => {
      const res = await deleteQuizAction({ lessonId: editingLesson.lesson.id });
      if (res.ok) {
        setEditingLesson(null);
        return { ok: true, notice: "Quiz removed." };
      }
      return res;
    });
  };

  const handleResourceUpload = async (e: React.FormEvent, lessonId: string) => {
    e.preventDefault();
    const input = document.getElementById(`pdf-${lessonId}`) as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      setError("Choose a PDF file first.");
      return;
    }
    setBusy(`upload-${lessonId}`);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("courseId", course.id);
      form.set("lessonId", lessonId);
      form.set("title", uploadTitle.trim() || file.name);
      const res = await fetch("/api/course-resources/upload", { method: "POST", body: form });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error || "Upload failed");
      } else {
        setUploadTitle("");
        setUploadingTo(null);
        flash("PDF resource attached — enrolled learners can download it.");
        router.refresh();
      }
    } catch (err: unknown) {
      setError((err as Error).message || "Upload failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader eyebrow="Courses" title={course.title} description="Shape the learning path: sections, lessons and downloadable files." />
      <div className="editor-subhead s-margin-24px--20px-20px" >
        <Link href="/admin/courses" className="btn ghost small" >
          ← Courses
        </Link>
        <span className="es-title">{course.title}</span>
        <span className={`lifecycle ${course.status}`}>{course.status.toUpperCase()}</span>
        <span className="es-spacer"></span>
        <span className="a-micro">{humanLabel(course.accessMode)}</span>
      </div>

      <p className="muted s-margin-bottom-20 s-text-sm" >
        Arrange sections and lessons in the order learners should follow. Mark essential lessons as required.{" "}
        {enrollmentCount} learner{enrollmentCount === 1 ? "" : "s"} {enrollmentCount === 1 ? "is" : "are"} learning here. Reordering keeps their progress intact.
      </p>

      {error && (
        <div className="s-margin-bottom-16 s-padding-10px-14px s-danger s-text-sm" role="alert" >
          {error}
        </div>
      )}
      {notice && (
        <div className="s-margin-bottom-16 s-padding-10px-14px s-success s-text-sm ui-card" role="status" >
          {notice}
        </div>
      )}

      <div className="s-stack s-gap-16" >
        {sections.map((entry) => (
          <section key={entry.section.id} className="settings-section s-padding-0 s-overflow-hidden" aria-label={entry.section.title}>
            <div className="s-row s-align-items-center s-gap-10 s-padding-14px-18px" >
              <Button className="btn ghost small" type="button" aria-label={`Move section ${entry.section.title} up`} disabled={busy === `ms-${entry.section.id}`} onClick={() => runAction(`ms-${entry.section.id}`, async () => { const r = await moveSectionAction(entry.section.id, "up"); return { ok: r.ok, error: r.error }; })}>
                ↑
              </Button>
              <Button className="btn ghost small" type="button" aria-label={`Move section ${entry.section.title} down`} disabled={busy === `ms-${entry.section.id}`} onClick={() => runAction(`ms-${entry.section.id}`, async () => { const r = await moveSectionAction(entry.section.id, "down"); return { ok: r.ok, error: r.error }; })}>
                ↓
              </Button>
              {renamingId === entry.section.id ? (
                <form className="s-row s-gap-8 s-flex-1" onSubmit={(e) => { e.preventDefault(); handleRename(entry.section.id); }} >
                  <Input className="s-flex-1 s-padding-6px-10px s-text-sm" aria-label="Section title" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} required maxLength={160} />
                  <Button className="btn primary small" type="submit">Save</Button>
                  <Button className="btn ghost small" type="button" onClick={() => setRenamingId(null)}>Cancel</Button>
                </form>
              ) : (
                <>
                  <b className="s-text-sm s-flex-1" >{entry.section.title}</b>
                  <span className="a-micro">{entry.lessons.length} LESSONS</span>
                  {releaseBadge(entry.section) && (
                    <span className="a-micro" aria-label={`Section release: ${releaseBadge(entry.section)}`}>{releaseBadge(entry.section)}</span>
                  )}
                  <Button className="btn ghost small" type="button" onClick={() => { setRenamingId(entry.section.id); setRenameValue(entry.section.title); }}>
                    Rename
                  </Button>
                  <Button className="btn ghost small" type="button" onClick={() => { setReleaseOpenFor(releaseOpenFor === entry.section.id ? null : entry.section.id); if (releaseOpenFor !== entry.section.id) openReleaseFor(entry.section); }}>
                    Release
                  </Button>
                </>
              )}
            </div>
            {releaseOpenFor === entry.section.id && (
              <form
                className="s-row s-gap-8 s-flex-wrap-wrap s-align-items-center s-padding-10px-18px s-border-top-1px-dashed-line"
                aria-label={`Release schedule for ${entry.section.title}`}
                onSubmit={(e) => { e.preventDefault(); handleSaveRelease(entry.section.id); }}
              >
                <label className="s-stack s-gap-4 s-text-sm">
                  Release
                  <select className="s-padding-6px-10px s-text-sm" aria-label="Section release mode" value={releaseMode} onChange={(e) => setReleaseMode(e.target.value)}>
                    <option value="immediate">Immediately</option>
                    <option value="date">On a date</option>
                    <option value="drip">N days after enrolling</option>
                  </select>
                </label>
                {releaseMode === "date" && (
                  <label className="s-stack s-gap-4 s-text-sm">
                    Date (your timezone)
                    <Input type="datetime-local" aria-label="Section release date" value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} required />
                  </label>
                )}
                {releaseMode === "drip" && (
                  <label className="s-stack s-gap-4 s-text-sm">
                    Days after enrolling (1–365)
                    <Input type="number" min={1} max={365} step={1} aria-label="Section drip days" value={releaseDays} onChange={(e) => setReleaseDays(e.target.value)} required />
                  </label>
                )}
                <Button className="btn primary small" type="submit" disabled={busy === `rel-${entry.section.id}`}>
                  {busy === `rel-${entry.section.id}` ? "Saving…" : "Save release"}
                </Button>
                <Button className="btn ghost small" type="button" onClick={() => setReleaseOpenFor(null)}>Cancel</Button>
              </form>
            )}

            <div className="table-scroll">
              <DataTable className="data">
                <thead>
                  <tr><th className="s-width-80" ></th><th>Lesson</th><th>Required</th><th>State</th><th className="num">Completions</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {entry.lessons.length === 0 && (
                    <tr><td colSpan={6} className="muted s-text-sm" >No lessons yet — add the first one below.</td></tr>
                  )}
                  {entry.lessons.map(({ lesson, completions, resources, quiz, quizStats }) => (
                    <React.Fragment key={lesson.id}>
                      <tr>
                        <td>
                          <Button className="btn ghost small" type="button" aria-label={`Move lesson ${lesson.title} up`} onClick={() => runAction(`ml-${lesson.id}`, async () => { const r = await moveLessonAction(lesson.id, "up"); return { ok: r.ok, error: r.error }; })}>↑</Button>
                          <Button className="btn ghost small" type="button" aria-label={`Move lesson ${lesson.title} down`} onClick={() => runAction(`ml-${lesson.id}`, async () => { const r = await moveLessonAction(lesson.id, "down"); return { ok: r.ok, error: r.error }; })}>↓</Button>
                        </td>
                        <td>
                          <span className="cell-main">{lesson.title}</span>
                          <span className="cell-sub s-block s-text-xs" >/{lesson.slug}{lesson.videoUrl ? " · ▶ video" : ""}{resources.length > 0 ? ` · ${resources.length} PDF${resources.length === 1 ? "" : "s"}` : ""}{quiz ? " · Quiz" : ""}{releaseBadge(lesson) ? ` · ${releaseBadge(lesson)}` : ""}</span>
                          {quiz && (
                            <span className="cell-sub s-block s-text-xs" >
                              Quiz results: {quizStats?.attemptedLearners ?? 0} learner{(quizStats?.attemptedLearners ?? 0) === 1 ? "" : "s"} attempted · {quizStats?.passRate ?? 0}% pass rate
                            </span>
                          )}
                        </td>
                        <td>
                          <Input type="checkbox" checked={lesson.required} aria-label={`Required: ${lesson.title}`} disabled={busy === `req-${lesson.id}`} onChange={() => runAction(`req-${lesson.id}`, async () => { const r = await updateLessonAction({ id: lesson.id, required: !lesson.required }); return { ok: r.ok, error: r.error }; })} />
                        </td>
                        <td><span className={`lifecycle ${lesson.status}`}>{lesson.status.toUpperCase()}</span></td>
                        <td className="num">{completions}</td>
                        <td>
                          <Button className="btn ghost small" type="button" onClick={() => openLessonEditor({ lesson, completions, resources, quiz, quizStats })}>Edit</Button>{" "}
                          {lesson.status === "draft" ? (
                            <Button className="btn ghost small" type="button" onClick={() => runAction(`pls-${lesson.id}`, async () => { const r = await publishLessonAction(lesson.id); return { ok: r.ok, error: r.error, notice: r.ok ? "Lesson published — live for learners on next load." : undefined }; })}>Publish</Button>
                          ) : lesson.status === "published" ? (
                            <Button className="btn ghost small" type="button" onClick={() => runAction(`upls-${lesson.id}`, async () => { const r = await unpublishLessonAction(lesson.id); return { ok: r.ok, error: r.error }; })}>Unpublish</Button>
                          ) : (
                            <Button className="btn ghost small" type="button" onClick={() => runAction(`rels-${lesson.id}`, async () => { const r = await restoreArchivedItemAction({ type: "lesson", id: lesson.id }); return { ok: r.ok, error: "error" in r ? r.error : undefined, notice: r.ok ? "Lesson restored to draft." : undefined }; })}>Restore to draft</Button>
                          )}{" "}
                          {lesson.status !== "archived" && (
                            <Button className="btn ghost small" type="button" onClick={() => { if (window.confirm(`Archive "${lesson.title}"? It will be hidden from learner navigation but kept.`)) runAction(`arls-${lesson.id}`, async () => { const r = await archiveLessonAction(lesson.id); return { ok: r.ok, error: r.error }; }); }}>Archive</Button>
                          )}{" "}
                          {(lesson.status === "draft" || lesson.status === "archived") && (
                            <Button className="btn ghost small" type="button" onClick={() => { if (window.confirm(`Move "${lesson.title}" to Trash? Recover it from Admin → Trash within 30 days.`)) runAction(`trls-${lesson.id}`, async () => { const r = await trashItemAction({ type: "lesson", id: lesson.id }); return { ok: r.ok, error: "error" in r ? r.error : undefined }; }); }}>Move to Trash</Button>
                          )}{" "}
                          <Button className="btn ghost small" type="button" onClick={() => { setUploadingTo(uploadingTo === lesson.id ? null : lesson.id); setUploadTitle(""); }}>
                            ＋ PDF
                          </Button>
                        </td>
                      </tr>
                      {uploadingTo === lesson.id && (
                        <tr>
                          <td colSpan={6}>
                            <form className="s-row s-gap-8 s-flex-wrap-wrap s-align-items-center s-padding-8px-0" onSubmit={(e) => handleResourceUpload(e, lesson.id)} >
                              <FileDrop className="s-text-sm" id={`pdf-${lesson.id}`} type="file" accept="application/pdf" aria-label={`PDF file for ${lesson.title}`} />
                              <Input className="s-padding-6px-10px s-text-sm s-min-width-200" aria-label="Resource title" value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} placeholder="Resource title (optional)" maxLength={160} />
                              <Button className="btn primary small" type="submit" disabled={busy === `upload-${lesson.id}`}>
                                {busy === `upload-${lesson.id}` ? "Uploading…" : "Upload PDF"}
                              </Button>
                              <span className="help s-text-xs" >PDF only · 10 MB max · enrolled learners only</span>
                            </form>
                            {resources.length > 0 && (
                              <ul className="s-text-sm s-margin-4px-0-8px s-padding-left-18" >
                                {resources.map((r) => (
                                  <li key={r.id}>{r.title} <span className="muted">({r.filename} · {(r.size / 1024).toFixed(0)} KB)</span></li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </DataTable>
            </div>

            <div className="s-padding-10px-18px s-border-top-1px-dashed-line" >
              {addingLessonTo === entry.section.id ? (
                <form className="s-row s-gap-8 s-flex-wrap-wrap s-align-items-center" onSubmit={(e) => handleCreateLesson(e, entry.section.id)} >
                  <Input className="s-padding-6px-10px s-text-sm s-min-width-220" aria-label="New lesson title" value={lessonTitle} onChange={(e) => setLessonTitle(e.target.value)} required minLength={3} maxLength={160} placeholder="Lesson title" />
                  <Input className="s-padding-6px-10px s-text-sm s-min-width-160" aria-label="New lesson slug" value={lessonSlug} onChange={(e) => setLessonSlug(e.target.value)} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="lesson-slug" />
                  <Button className="btn primary small" type="submit" disabled={busy === `add-lesson-${entry.section.id}`}>Add lesson</Button>
                  <Button className="btn ghost small" type="button" onClick={() => setAddingLessonTo(null)}>Cancel</Button>
                </form>
              ) : (
                <Button className="btn ghost small" type="button" onClick={() => { setAddingLessonTo(entry.section.id); setLessonTitle(""); setLessonSlug(""); }}>
                  ＋ Add lesson
                </Button>
              )}
            </div>
          </section>
        ))}
      </div>

      <form className="s-row s-gap-8 s-margin-top-20 s-flex-wrap-wrap" onSubmit={handleCreateSection} >
        <Input className="s-padding-8px-12px s-text-sm s-min-width-240" aria-label="New section title" value={newSectionTitle} onChange={(e) => setNewSectionTitle(e.target.value)} required maxLength={160} placeholder="New section title…" />
        <Button className="btn secondary small" type="submit" disabled={busy === "new-section"}>
          ＋ Add section
        </Button>
      </form>

      <div className="settings-section danger-zone s-margin-top-20" >
        <h3>Danger zone</h3>
        <p className="ss-hint">
          {enrollmentCount > 0
            ? `This course has ${enrollmentCount} active enrollment${enrollmentCount === 1 ? "" : "s"}. Permanent delete stays blocked while learners are attached — archive instead. Moving to Trash hides it from every learner view but keeps all data.`
            : "No enrollments yet. Moving to Trash hides this course from every list and learner view; recover it from Admin → Trash within 30 days."}
        </p>
        <div className="s-row s-gap-10 s-flex-wrap-wrap" >
          {(course.status === "draft" || course.status === "archived") ? (
            <Button className="btn danger small" type="button" disabled={busy === "trash-course"} onClick={() => { if (window.confirm(`Move course "${course.title}" to Trash? Recover it from Admin → Trash within 30 days.`)) runAction("trash-course", async () => { const r = await trashItemAction({ type: "course", id: course.id }); return { ok: r.ok, error: "error" in r ? r.error : undefined, notice: r.ok ? "Course moved to Trash." : undefined }; }); }}>
              {busy === "trash-course" ? "Moving…" : "Move course to Trash"}
            </Button>
          ) : (
            <Button className="btn danger small" type="button" disabled title="Unpublish or archive the course first — published courses cannot move to Trash">
              Move course to Trash — unpublish or archive first
            </Button>
          )}
        </div>
      </div>

      {editingLesson && (
        <div className="s-position-fixed s-inset-0 s-z-index-60 s-stack s-place-items-center s-padding-16" role="dialog" aria-label={`Edit lesson ${editingLesson.lesson.title}`} >
          <div className="s-full s-max-width-760 s-max-height-90vh s-overflow-auto s-padding-24px-clamp-18px-4vw-32px" >
            <div className="s-row s-justify-content-space-between s-align-items-center s-gap-12" >
              <b >Edit lesson</b>
              <Button className="btn secondary small" type="button" onClick={() => setEditingLesson(null)}>Close</Button>
            </div>
            <form className="s-stack s-gap-14 s-margin-top-16" onSubmit={handleSaveLesson} >
              <label className="s-stack s-gap-6 s-text-sm s-bold" >
                Title *
                <Input className="s-padding-10px-14px s-text-sm" aria-label="Lesson title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} required minLength={3} maxLength={160} />
              </label>
              <label className="s-stack s-gap-6 s-text-sm s-bold" >
                Slug * <span className="s-muted" >unique inside this course</span>
                <Input className="s-padding-10px-14px s-text-sm" aria-label="Lesson slug" value={editSlug} onChange={(e) => setEditSlug(e.target.value)} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
              </label>
              <label className="s-stack s-gap-6 s-text-sm s-bold" >
                YouTube video <span className="s-muted" >optional — watch / youtu.be / embed / ID</span>
                <Input className="s-padding-10px-14px s-text-sm" aria-label="Lesson YouTube video URL" value={editVideo} onChange={(e) => setEditVideo(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" maxLength={500} />
              </label>
              <label className="s-row s-gap-8 s-align-items-center s-text-sm s-bold" >
                <Input type="checkbox" checked={editRequired} onChange={(e) => setEditRequired(e.target.checked)} aria-label="Lesson required" />
                Required <span className="s-muted" >(counts toward progress + completion)</span>
              </label>
              <label className="s-row s-gap-8 s-align-items-center s-text-sm s-bold">
                <Input type="checkbox" checked={editPreview} onChange={(e) => setEditPreview(e.target.checked)} />
                Free preview
              </label>
              <label className="s-stack s-gap-6 s-text-sm s-bold">
                Length (minutes)
                <Input type="number" min={1} max={600} step={1} value={editDuration} onChange={(e) => setEditDuration(e.target.value)} />
              </label>
              <section className="s-stack s-gap-12 s-margin-top-8" aria-label="Lesson release">
                <b>Release</b>
                <div className="s-row s-gap-10 s-flex-wrap-wrap s-align-items-center">
                  <label className="s-stack s-gap-4 s-text-sm">
                    Mode
                    <select className="s-padding-6px-10px s-text-sm" aria-label="Lesson release mode" value={editReleaseMode} onChange={(e) => setEditReleaseMode(e.target.value)}>
                      <option value="immediate">Immediately</option>
                      <option value="date">On a date</option>
                      <option value="drip">N days after enrolling</option>
                    </select>
                  </label>
                  {editReleaseMode === "date" && (
                    <label className="s-stack s-gap-4 s-text-sm">
                      Date (your timezone)
                      <Input type="datetime-local" aria-label="Lesson release date" value={editReleaseDate} onChange={(e) => setEditReleaseDate(e.target.value)} />
                    </label>
                  )}
                  {editReleaseMode === "drip" && (
                    <label className="s-stack s-gap-4 s-text-sm">
                      Days after enrolling (1–365)
                      <Input type="number" min={1} max={365} step={1} aria-label="Lesson drip days" value={editReleaseDays} onChange={(e) => setEditReleaseDays(e.target.value)} />
                    </label>
                  )}
                  <Button className="btn secondary small" type="button" disabled={busy === `lrel-${editingLesson.lesson.id}`} onClick={handleSaveLessonRelease}>
                    {busy === `lrel-${editingLesson.lesson.id}` ? "Saving…" : "Save release"}
                  </Button>
                </div>
                <span className="help s-text-xs">Section and lesson rules combine — the later date wins. Previews ignore release.</span>
              </section>
              <StructuredBlockEditor blocks={editBlocks} onChange={setEditBlocks} allowedBlockTypes={LESSON_BLOCK_TYPES} eyebrowHint="LESSON BODY" />

              <section className="s-stack s-gap-12 s-margin-top-8" aria-label="Lesson quiz">
                <div className="s-row s-justify-content-space-between s-align-items-center s-gap-10 s-flex-wrap-wrap">
                  <b>Quiz</b>
                  <span className="s-text-xs s-muted">Optional knowledge check · answers stay private until submission</span>
                </div>
                <div className="s-row s-gap-10 s-flex-wrap-wrap s-align-items-center">
                  <label className="s-row s-gap-8 s-align-items-center s-text-sm s-bold">
                    Pass mark (%)
                    <Input type="number" min={0} max={100} step={1} className="s-padding-6px-10px s-text-sm s-width-80" aria-label="Quiz pass mark" value={quizPassPercent} onChange={(e) => setQuizPassPercent(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
                  </label>
                  <label className="s-row s-gap-8 s-align-items-center s-text-sm s-bold">
                    <Input type="checkbox" checked={quizRequirePass} onChange={(e) => setQuizRequirePass(e.target.checked)} aria-label="Require a pass to complete the lesson" />
                    Require a pass to complete the lesson
                  </label>
                </div>

                {quizDraft.map((question, questionIndex) => (
                  <fieldset key={question.id} className="settings-section s-stack s-gap-8 s-padding-12px">
                    <legend className="s-text-sm s-bold">Question {questionIndex + 1}</legend>
                    <div className="s-row s-gap-6 s-flex-wrap-wrap s-align-items-center">
                      <Button className="btn ghost small" type="button" aria-label={`Move question ${questionIndex + 1} up`} disabled={questionIndex === 0} onClick={() => moveQuestion(questionIndex, -1)}>↑</Button>
                      <Button className="btn ghost small" type="button" aria-label={`Move question ${questionIndex + 1} down`} disabled={questionIndex === quizDraft.length - 1} onClick={() => moveQuestion(questionIndex, 1)}>↓</Button>
                      <Button className="btn ghost small" type="button" disabled={quizDraft.length === 1} onClick={() => removeQuestion(question.id)}>Remove</Button>
                      <select className="s-padding-6px-10px s-text-sm" aria-label={`Question ${questionIndex + 1} type`} value={question.kind} onChange={(e) => setQuestionKind(question.id, e.target.value === "multiple" ? "multiple" : "single")}>
                        <option value="single">Single choice</option>
                        <option value="multiple">Multiple choice</option>
                      </select>
                    </div>
                    <Input className="s-padding-8px-10px s-text-sm" aria-label={`Question ${questionIndex + 1} prompt`} placeholder="Question prompt" maxLength={500} value={question.prompt} onChange={(e) => patchQuestion(question.id, { prompt: e.target.value })} />
                    <div className="s-stack s-gap-6">
                      {question.options.map((option, optionIndex) => (
                        <div key={option.id} className="s-stack s-gap-4">
                          <div className="s-row s-gap-8 s-align-items-center">
                            <Input
                              type={question.kind === "single" ? "radio" : "checkbox"}
                              name={`correct-${question.id}`}
                              checked={question.correctOptionIds.includes(option.id)}
                              aria-label={`Question ${questionIndex + 1} option ${optionIndex + 1} correct`}
                              onChange={() => toggleCorrect(question.id, option.id)}
                            />
                            <Input className="s-flex-1 s-padding-6px-10px s-text-sm" aria-label={`Question ${questionIndex + 1} option ${optionIndex + 1} text`} placeholder={`Option ${optionIndex + 1}`} maxLength={200} value={option.text} onChange={(e) => setOptionText(question.id, option.id, e.target.value)} />
                            <Button className="btn ghost small" type="button" aria-label={`Remove option ${optionIndex + 1}`} disabled={question.options.length <= 2} onClick={() => removeOption(question.id, option.id)}>×</Button>
                          </div>
                          <Input className="s-padding-6px-10px s-text-sm" aria-label={`Question ${questionIndex + 1} option ${optionIndex + 1} tag`} placeholder="Tag learners who pick this (optional)" maxLength={40} value={option.tag} onChange={(e) => setOptionTag(question.id, option.id, e.target.value)} />
                          {tagError(option.tag) ? (
                            <span className="s-text-xs s-danger" role="alert">{tagError(option.tag)}</span>
                          ) : (
                            option.tag.trim() === "" && (
                              <span className="help s-text-xs">Lowercase letters, numbers and dashes · up to 40 characters</span>
                            )
                          )}
                        </div>
                      ))}
                      <div>
                        <Button className="btn ghost small" type="button" disabled={question.options.length >= 8} onClick={() => addOption(question.id)}>＋ Option</Button>
                      </div>
                    </div>
                    <textarea
                      className="s-padding-8px-10px s-text-sm"
                      aria-label={`Question ${questionIndex + 1} explanation`}
                      placeholder="Explanation shown after submission (optional)"
                      rows={2}
                      maxLength={1000}
                      value={question.explanation}
                      onChange={(e) => patchQuestion(question.id, { explanation: e.target.value })}
                    />
                  </fieldset>
                ))}

                <div className="s-row s-gap-8 s-flex-wrap-wrap">
                  <Button className="btn secondary small" type="button" disabled={quizDraft.length >= 30} onClick={addQuestion}>＋ Add question</Button>
                </div>
                <div className="s-row s-gap-10 s-flex-wrap-wrap">
                  <Button className="btn primary small" type="button" disabled={busy === `save-quiz-${editingLesson.lesson.id}`} onClick={handleSaveQuiz}>
                    {busy === `save-quiz-${editingLesson.lesson.id}` ? "Saving…" : "Save quiz"}
                  </Button>
                  {editingLesson.quiz && (
                    <Button className="btn danger small" type="button" disabled={busy === `remove-quiz-${editingLesson.lesson.id}`} onClick={handleRemoveQuiz}>
                      Remove quiz
                    </Button>
                  )}
                </div>
              </section>

              <div className="s-row s-gap-10" >
                <Button className="btn primary small" type="submit" disabled={busy === `save-lesson-${editingLesson.lesson.id}`}>
                  {busy === `save-lesson-${editingLesson.lesson.id}` ? "Saving…" : "Save lesson"}
                </Button>
                <Button className="btn ghost small" type="button" onClick={() => setEditingLesson(null)}>Cancel</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
