"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "../../../_ui";
import {
  applyOutlineAction,
  draftOutlineAction,
} from "@/features/course-outline/actions";
import type { CourseOutlineDraft } from "@/features/course-outline/types";

function initSelection(draft: CourseOutlineDraft): boolean[][] {
  return draft.sections.map((section) => section.lessons.map(() => true));
}

function initTitles(draft: CourseOutlineDraft): string[][] {
  return draft.sections.map((section) => section.lessons.map((lesson) => lesson.title));
}

export function OutlineDrafter({ courseId }: { courseId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [audience, setAudience] = useState("");
  const [outcomes, setOutcomes] = useState("");
  const [lengthHint, setLengthHint] = useState("");
  const [busy, setBusy] = useState<"draft" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<CourseOutlineDraft | null>(null);
  const [checked, setChecked] = useState<boolean[][]>([]);
  const [lessonTitles, setLessonTitles] = useState<string[][]>([]);
  const [sectionTitles, setSectionTitles] = useState<string[]>([]);

  const sourceTitle = (sourceId: string): string => {
    return draft?.sources.find((s) => s.sourceId === sourceId)?.sourceTitle ?? "Knowledge base";
  };

  const handleDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || busy) return;
    setBusy("draft");
    setError(null);
    setNotice(null);
    try {
      const res = await draftOutlineAction({
        courseId,
        topic: topic.trim(),
        audience: audience.trim() || undefined,
        outcomes: outcomes.trim() || undefined,
        lengthHint: lengthHint.trim() || undefined,
      });
      if (!res.ok) {
        setError(res.error);
      } else {
        setDraft(res.data);
        setChecked(initSelection(res.data));
        setLessonTitles(initTitles(res.data));
        setSectionTitles(res.data.sections.map((s) => s.title));
      }
    } finally {
      setBusy(null);
    }
  };

  const toggleLesson = (si: number, li: number) => {
    setChecked((prev) =>
      prev.map((lessons, i) =>
        i === si ? lessons.map((v, j) => (j === li ? !v : v)) : lessons,
      ),
    );
  };

  const toggleSection = (si: number) => {
    setChecked((prev) => {
      const allOn = prev[si]?.every(Boolean) ?? false;
      return prev.map((lessons, i) => (i === si ? lessons.map(() => !allOn) : lessons));
    });
  };

  const selectedCount = checked.reduce(
    (n, lessons) => n + lessons.filter(Boolean).length,
    0,
  );

  const handleApply = async () => {
    if (!draft || busy || selectedCount === 0) return;
    setBusy("apply");
    setError(null);
    setNotice(null);
    try {
      const sections = draft.sections
        .map((section, si) => ({
          title: (sectionTitles[si] ?? section.title).trim(),
          lessons: section.lessons
            .map((lesson, li) => ({
              title: (lessonTitles[si]?.[li] ?? lesson.title).trim(),
              summary: lesson.summary,
              durationMinutes: lesson.durationMinutes,
              picked: checked[si]?.[li] ?? false,
            }))
            .filter((lesson) => lesson.picked && lesson.title)
            .map((lesson) => ({
              title: lesson.title,
              summary: lesson.summary,
              durationMinutes: lesson.durationMinutes,
            })),
        }))
        .filter((section) => section.title && section.lessons.length > 0);
      if (sections.length === 0) {
        setError("Tick at least one lesson to add.");
        return;
      }
      const res = await applyOutlineAction({ courseId, sections });
      if (!res.ok) {
        setError(res.error);
      } else {
        setDraft(null);
        setNotice(
          `Added ${res.data.sectionCount} section${res.data.sectionCount === 1 ? "" : "s"} and ${res.data.lessonCount} lesson${res.data.lessonCount === 1 ? "" : "s"} as drafts.`,
        );
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-section s-margin-bottom-20" aria-label="Draft outline with AI">
      <div className="s-row s-justify-content-space-between s-align-items-center s-gap-12 s-flex-wrap-wrap">
        <div>
          <b>Draft outline with AI</b>
          <p className="ss-hint s-margin-4px-0-0">
            Describe the course and we will propose an outline grounded in the knowledge library.
            You review it and keep what fits.
          </p>
        </div>
        <Button className="btn secondary small" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Hide" : "Draft outline with AI"}
        </Button>
      </div>

      {open && (
        <div className="s-stack s-gap-14 s-margin-top-16">
          <form className="s-stack s-gap-10" onSubmit={handleDraft}>
            <label className="s-stack s-gap-6 s-text-sm s-bold">
              Topic *
              <Input
                className="s-padding-8px-12px s-text-sm"
                aria-label="Outline topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                required
                minLength={3}
                maxLength={200}
                placeholder="e.g. Structured hiring interviews"
              />
            </label>
            <label className="s-stack s-gap-6 s-text-sm s-bold">
              Audience <span className="s-muted">optional</span>
              <Input
                className="s-padding-8px-12px s-text-sm"
                aria-label="Outline audience"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                maxLength={500}
                placeholder="e.g. First-time hiring managers"
              />
            </label>
            <label className="s-stack s-gap-6 s-text-sm s-bold">
              Outcomes <span className="s-muted">optional</span>
              <Input
                className="s-padding-8px-12px s-text-sm"
                aria-label="Outline outcomes"
                value={outcomes}
                onChange={(e) => setOutcomes(e.target.value)}
                maxLength={1000}
                placeholder="e.g. Run a fair first-round interview"
              />
            </label>
            <label className="s-stack s-gap-6 s-text-sm s-bold">
              Rough length <span className="s-muted">optional</span>
              <Input
                className="s-padding-8px-12px s-text-sm"
                aria-label="Outline rough length"
                value={lengthHint}
                onChange={(e) => setLengthHint(e.target.value)}
                maxLength={200}
                placeholder="e.g. 4 sections, about 12 lessons"
              />
            </label>
            <div>
              <Button className="btn primary small" type="submit" disabled={busy === "draft" || !topic.trim()}>
                {busy === "draft" ? "Drafting…" : "Draft outline with AI"}
              </Button>
            </div>
          </form>

          {error && (
            <div className="s-padding-10px-14px s-danger s-text-sm" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="s-padding-10px-14px s-success s-text-sm ui-card" role="status">
              {notice}
            </div>
          )}

          {busy === "draft" && (
            <p className="muted s-text-sm" role="status">
              Drafting the outline — reading the knowledge library…
            </p>
          )}

          {draft && (
            <div className="s-stack s-gap-12">
              <p className="muted s-text-sm">
                Review the draft below. Tick what to keep, edit titles, then add the selection as
                draft sections and lessons at the end of the curriculum.
              </p>
              {draft.sections.map((section, si) => {
                const allOn = checked[si]?.every(Boolean) ?? false;
                return (
                  <fieldset key={`outline-s-${si}`} className="settings-section s-stack s-gap-8 s-padding-12px">
                    <legend className="s-sr-only">Proposed section {si + 1}</legend>
                    <div className="s-row s-gap-8 s-align-items-center">
                      <Input
                        type="checkbox"
                        checked={allOn}
                        onChange={() => toggleSection(si)}
                        aria-label={`Select all lessons in ${section.title}`}
                      />
                      <Input
                        className="s-flex-1 s-padding-6px-10px s-text-sm"
                        aria-label={`Proposed section ${si + 1} title`}
                        value={sectionTitles[si] ?? section.title}
                        onChange={(e) =>
                          setSectionTitles((prev) =>
                            prev.map((t, i) => (i === si ? e.target.value : t)),
                          )
                        }
                        maxLength={160}
                      />
                    </div>
                    <ul className="s-stack s-gap-8 s-padding-left-18">
                      {section.lessons.map((lesson, li) => (
                        <li key={`outline-s-${si}-l-${li}`} className="s-stack s-gap-4">
                          <div className="s-row s-gap-8 s-align-items-center">
                            <Input
                              type="checkbox"
                              checked={checked[si]?.[li] ?? false}
                              onChange={() => toggleLesson(si, li)}
                              aria-label={`Select lesson ${lesson.title}`}
                            />
                            <Input
                              className="s-flex-1 s-padding-6px-10px s-text-sm"
                              aria-label={`Proposed lesson ${si + 1}.${li + 1} title`}
                              value={lessonTitles[si]?.[li] ?? lesson.title}
                              onChange={(e) =>
                                setLessonTitles((prev) =>
                                  prev.map((titles, i) =>
                                    i === si
                                      ? titles.map((t, j) => (j === li ? e.target.value : t))
                                      : titles,
                                  ),
                                )
                              }
                              maxLength={160}
                            />
                            {lesson.durationMinutes != null && (
                              <span className="a-micro">{lesson.durationMinutes} MIN</span>
                            )}
                          </div>
                          <p className="muted s-text-sm s-margin-0">{lesson.summary}</p>
                          {lesson.sourceIds.length > 0 && (
                            <p className="help s-text-xs s-margin-0">
                              Sources: {lesson.sourceIds.map(sourceTitle).join(" · ")}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                );
              })}
              <div className="s-row s-gap-10 s-align-items-center s-flex-wrap-wrap">
                <Button
                  className="btn primary small"
                  type="button"
                  disabled={busy === "apply" || selectedCount === 0}
                  onClick={handleApply}
                >
                  {busy === "apply" ? "Adding…" : `Add selected as drafts (${selectedCount})`}
                </Button>
                <span className="help s-text-xs">
                  New sections go at the end, all unpublished. Nothing already published changes.
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
