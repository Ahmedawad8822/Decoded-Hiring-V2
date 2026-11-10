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
  createLessonAction,
  createSectionAction,
  moveLessonAction,
  moveSectionAction,
  publishLessonAction,
  renameSectionAction,
  unpublishLessonAction,
  updateLessonAction,
} from "@/features/courses/actions";

interface LessonEntry {
  lesson: Lesson;
  completions: number;
  resources: LessonResource[];
}

interface SectionEntry {
  section: CourseSection;
  lessons: LessonEntry[];
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

  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadingTo, setUploadingTo] = useState<string | null>(null);

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
    setEditVideo(entry.lesson.videoUrl || "");
    setEditRequired(entry.lesson.required);
    setEditPreview(entry.lesson.isPreview);
    setEditDuration(entry.lesson.durationMinutes?.toString() ?? "");
    setEditBlocks(parseBody(entry.lesson.body));
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
                  <Button className="btn ghost small" type="button" onClick={() => { setRenamingId(entry.section.id); setRenameValue(entry.section.title); }}>
                    Rename
                  </Button>
                </>
              )}
            </div>

            <div className="table-scroll">
              <DataTable className="data">
                <thead>
                  <tr><th className="s-width-80" ></th><th>Lesson</th><th>Required</th><th>State</th><th className="num">Completions</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {entry.lessons.length === 0 && (
                    <tr><td colSpan={6} className="muted s-text-sm" >No lessons yet — add the first one below.</td></tr>
                  )}
                  {entry.lessons.map(({ lesson, completions, resources }) => (
                    <React.Fragment key={lesson.id}>
                      <tr>
                        <td>
                          <Button className="btn ghost small" type="button" aria-label={`Move lesson ${lesson.title} up`} onClick={() => runAction(`ml-${lesson.id}`, async () => { const r = await moveLessonAction(lesson.id, "up"); return { ok: r.ok, error: r.error }; })}>↑</Button>
                          <Button className="btn ghost small" type="button" aria-label={`Move lesson ${lesson.title} down`} onClick={() => runAction(`ml-${lesson.id}`, async () => { const r = await moveLessonAction(lesson.id, "down"); return { ok: r.ok, error: r.error }; })}>↓</Button>
                        </td>
                        <td>
                          <span className="cell-main">{lesson.title}</span>
                          <span className="cell-sub s-block s-text-xs" >/{lesson.slug}{lesson.videoUrl ? " · ▶ video" : ""}{resources.length > 0 ? ` · ${resources.length} PDF${resources.length === 1 ? "" : "s"}` : ""}</span>
                        </td>
                        <td>
                          <Input type="checkbox" checked={lesson.required} aria-label={`Required: ${lesson.title}`} disabled={busy === `req-${lesson.id}`} onChange={() => runAction(`req-${lesson.id}`, async () => { const r = await updateLessonAction({ id: lesson.id, required: !lesson.required }); return { ok: r.ok, error: r.error }; })} />
                        </td>
                        <td><span className={`lifecycle ${lesson.status}`}>{lesson.status.toUpperCase()}</span></td>
                        <td className="num">{completions}</td>
                        <td>
                          <Button className="btn ghost small" type="button" onClick={() => openLessonEditor({ lesson, completions, resources })}>Edit</Button>{" "}
                          {lesson.status === "draft" ? (
                            <Button className="btn ghost small" type="button" onClick={() => runAction(`pls-${lesson.id}`, async () => { const r = await publishLessonAction(lesson.id); return { ok: r.ok, error: r.error, notice: r.ok ? "Lesson published — live for learners on next load." : undefined }; })}>Publish</Button>
                          ) : lesson.status === "published" ? (
                            <Button className="btn ghost small" type="button" onClick={() => runAction(`upls-${lesson.id}`, async () => { const r = await unpublishLessonAction(lesson.id); return { ok: r.ok, error: r.error }; })}>Unpublish</Button>
                          ) : null}{" "}
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
            ? `This course has ${enrollmentCount} active enrollment${enrollmentCount === 1 ? "" : "s"}. Permanent delete is blocked while real progress depends on it.`
            : "No enrollments yet. Archive this course when you no longer need it."}
        </p>
        <div className="s-row s-gap-10 s-flex-wrap-wrap" >
          <Button className="btn danger small" type="button" disabled title={enrollmentCount > 0 ? `Blocked: ${enrollmentCount} active enrollments depend on this course` : "Permanent delete is not available"} aria-disabled="true">
            Delete permanently — {enrollmentCount > 0 ? `blocked by ${enrollmentCount} enrollments` : "not available"}
          </Button>
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
              <StructuredBlockEditor blocks={editBlocks} onChange={setEditBlocks} allowedBlockTypes={LESSON_BLOCK_TYPES} eyebrowHint="LESSON BODY" />
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
