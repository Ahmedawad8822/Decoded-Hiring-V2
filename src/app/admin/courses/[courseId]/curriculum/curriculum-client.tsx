"use client";

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
      <div className="editor-subhead" style={{ margin: "-24px -20px 20px", borderRadius: 0 }}>
        <Link href="/admin/courses" className="btn ghost small" style={{ textDecoration: "none" }}>
          ← Courses
        </Link>
        <span className="es-title">{course.title}</span>
        <span className={`lifecycle ${course.status}`}>{course.status.toUpperCase()}</span>
        <span className="es-spacer"></span>
        <span className="a-micro">{course.accessMode}</span>
      </div>

      <p className="muted" style={{ marginBottom: 20, fontSize: 12.5 }}>
        Sections → lessons. ↑↓ buttons reorder everywhere (no drag dependency). Required flags drive honest progress.{" "}
        {enrollmentCount} learner{enrollmentCount === 1 ? "" : "s"} {enrollmentCount === 1 ? "is" : "are"} mid-course — reorder is safe, deletes are guarded.
      </p>

      {error && (
        <div role="alert" style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, background: "var(--coral-soft, #f5d6cd)", color: "#7c2d12", fontSize: 13, border: "1px solid rgba(235, 116, 94, 0.4)" }}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, background: "var(--mint-soft, #e3f2e9)", color: "#14532d", fontSize: 13, border: "1px solid rgba(31, 122, 82, 0.35)" }}>
          {notice}
        </div>
      )}

      <div style={{ display: "grid", gap: 16 }}>
        {sections.map((entry) => (
          <section key={entry.section.id} className="settings-section" style={{ padding: 0, overflow: "hidden" }} aria-label={entry.section.title}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", background: "var(--paper)" }}>
              <button className="btn ghost small" type="button" aria-label={`Move section ${entry.section.title} up`} disabled={busy === `ms-${entry.section.id}`} onClick={() => runAction(`ms-${entry.section.id}`, async () => { const r = await moveSectionAction(entry.section.id, "up"); return { ok: r.ok, error: r.error }; })}>
                ↑
              </button>
              <button className="btn ghost small" type="button" aria-label={`Move section ${entry.section.title} down`} disabled={busy === `ms-${entry.section.id}`} onClick={() => runAction(`ms-${entry.section.id}`, async () => { const r = await moveSectionAction(entry.section.id, "down"); return { ok: r.ok, error: r.error }; })}>
                ↓
              </button>
              {renamingId === entry.section.id ? (
                <form onSubmit={(e) => { e.preventDefault(); handleRename(entry.section.id); }} style={{ display: "flex", gap: 8, flex: 1 }}>
                  <input aria-label="Section title" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} required maxLength={160} style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 13 }} />
                  <button className="btn primary small" type="submit">Save</button>
                  <button className="btn ghost small" type="button" onClick={() => setRenamingId(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <b style={{ fontSize: 14, flex: 1 }}>{entry.section.title}</b>
                  <span className="a-micro">{entry.lessons.length} LESSONS</span>
                  <button className="btn ghost small" type="button" onClick={() => { setRenamingId(entry.section.id); setRenameValue(entry.section.title); }}>
                    Rename
                  </button>
                </>
              )}
            </div>

            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr><th style={{ width: 80 }}></th><th>Lesson</th><th>Required</th><th>State</th><th className="num">Completions</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {entry.lessons.length === 0 && (
                    <tr><td colSpan={6} className="muted" style={{ fontSize: 12.5 }}>No lessons yet — add the first one below.</td></tr>
                  )}
                  {entry.lessons.map(({ lesson, completions, resources }) => (
                    <React.Fragment key={lesson.id}>
                      <tr>
                        <td>
                          <button className="btn ghost small" type="button" aria-label={`Move lesson ${lesson.title} up`} onClick={() => runAction(`ml-${lesson.id}`, async () => { const r = await moveLessonAction(lesson.id, "up"); return { ok: r.ok, error: r.error }; })}>↑</button>
                          <button className="btn ghost small" type="button" aria-label={`Move lesson ${lesson.title} down`} onClick={() => runAction(`ml-${lesson.id}`, async () => { const r = await moveLessonAction(lesson.id, "down"); return { ok: r.ok, error: r.error }; })}>↓</button>
                        </td>
                        <td>
                          <span className="cell-main">{lesson.title}</span>
                          <span className="cell-sub" style={{ display: "block", fontSize: 11.5 }}>/{lesson.slug}{lesson.videoUrl ? " · ▶ video" : ""}{resources.length > 0 ? ` · ${resources.length} PDF${resources.length === 1 ? "" : "s"}` : ""}</span>
                        </td>
                        <td>
                          <input type="checkbox" checked={lesson.required} aria-label={`Required: ${lesson.title}`} disabled={busy === `req-${lesson.id}`} onChange={() => runAction(`req-${lesson.id}`, async () => { const r = await updateLessonAction({ id: lesson.id, required: !lesson.required }); return { ok: r.ok, error: r.error }; })} />
                        </td>
                        <td><span className={`lifecycle ${lesson.status}`}>{lesson.status.toUpperCase()}</span></td>
                        <td className="num">{completions}</td>
                        <td>
                          <button className="btn ghost small" type="button" onClick={() => openLessonEditor({ lesson, completions, resources })}>Edit</button>{" "}
                          {lesson.status === "draft" ? (
                            <button className="btn ghost small" type="button" onClick={() => runAction(`pls-${lesson.id}`, async () => { const r = await publishLessonAction(lesson.id); return { ok: r.ok, error: r.error, notice: r.ok ? "Lesson published — live for learners on next load." : undefined }; })}>Publish</button>
                          ) : lesson.status === "published" ? (
                            <button className="btn ghost small" type="button" onClick={() => runAction(`upls-${lesson.id}`, async () => { const r = await unpublishLessonAction(lesson.id); return { ok: r.ok, error: r.error }; })}>Unpublish</button>
                          ) : null}{" "}
                          <button className="btn ghost small" type="button" onClick={() => { setUploadingTo(uploadingTo === lesson.id ? null : lesson.id); setUploadTitle(""); }}>
                            ＋ PDF
                          </button>
                        </td>
                      </tr>
                      {uploadingTo === lesson.id && (
                        <tr>
                          <td colSpan={6}>
                            <form onSubmit={(e) => handleResourceUpload(e, lesson.id)} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "8px 0" }}>
                              <input id={`pdf-${lesson.id}`} type="file" accept="application/pdf" aria-label={`PDF file for ${lesson.title}`} style={{ fontSize: 12.5 }} />
                              <input aria-label="Resource title" value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} placeholder="Resource title (optional)" maxLength={160} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12.5, minWidth: 200 }} />
                              <button className="btn primary small" type="submit" disabled={busy === `upload-${lesson.id}`}>
                                {busy === `upload-${lesson.id}` ? "Uploading…" : "Upload PDF"}
                              </button>
                              <span className="help" style={{ fontSize: 11.5 }}>PDF only · 10 MB max · enrolled learners only</span>
                            </form>
                            {resources.length > 0 && (
                              <ul style={{ fontSize: 12.5, margin: "4px 0 8px", paddingLeft: 18 }}>
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
              </table>
            </div>

            <div style={{ padding: "10px 18px", borderTop: "1px dashed var(--line)" }}>
              {addingLessonTo === entry.section.id ? (
                <form onSubmit={(e) => handleCreateLesson(e, entry.section.id)} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input aria-label="New lesson title" value={lessonTitle} onChange={(e) => setLessonTitle(e.target.value)} required minLength={3} maxLength={160} placeholder="Lesson title" style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12.5, minWidth: 220 }} />
                  <input aria-label="New lesson slug" value={lessonSlug} onChange={(e) => setLessonSlug(e.target.value)} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="lesson-slug" style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--line-strong)", fontSize: 12.5, minWidth: 160 }} />
                  <button className="btn primary small" type="submit" disabled={busy === `add-lesson-${entry.section.id}`}>Add lesson</button>
                  <button className="btn ghost small" type="button" onClick={() => setAddingLessonTo(null)}>Cancel</button>
                </form>
              ) : (
                <button className="btn ghost small" type="button" onClick={() => { setAddingLessonTo(entry.section.id); setLessonTitle(""); setLessonSlug(""); }}>
                  ＋ Add lesson
                </button>
              )}
            </div>
          </section>
        ))}
      </div>

      <form onSubmit={handleCreateSection} style={{ display: "flex", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
        <input aria-label="New section title" value={newSectionTitle} onChange={(e) => setNewSectionTitle(e.target.value)} required maxLength={160} placeholder="New section title…" style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 13, minWidth: 240 }} />
        <button className="btn secondary small" type="submit" disabled={busy === "new-section"}>
          ＋ Add section
        </button>
      </form>

      <div className="settings-section danger-zone" style={{ marginTop: 20 }}>
        <h3>Danger zone</h3>
        <p className="ss-hint">
          {enrollmentCount > 0
            ? `This course has ${enrollmentCount} active enrollment${enrollmentCount === 1 ? "" : "s"}. Permanent delete is blocked while real progress depends on it.`
            : "No enrollments yet. Permanent delete is not exposed in Mission 06 — archive instead."}
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn danger small" type="button" disabled title={enrollmentCount > 0 ? `Blocked: ${enrollmentCount} active enrollments depend on this course` : "Permanent delete is not available in Mission 06"} aria-disabled="true">
            Delete permanently — {enrollmentCount > 0 ? `blocked by ${enrollmentCount} enrollments` : "not available"}
          </button>
        </div>
      </div>

      {editingLesson && (
        <div role="dialog" aria-label={`Edit lesson ${editingLesson.lesson.title}`} style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 760, maxHeight: "90vh", overflow: "auto", background: "var(--paper-bright)", borderRadius: 12, padding: "24px clamp(18px, 4vw, 32px)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <b style={{ fontSize: 16 }}>Edit lesson</b>
              <button className="btn secondary small" type="button" onClick={() => setEditingLesson(null)}>Close</button>
            </div>
            <form onSubmit={handleSaveLesson} style={{ display: "grid", gap: 14, marginTop: 16 }}>
              <label style={{ display: "grid", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                Title *
                <input aria-label="Lesson title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} required minLength={3} maxLength={160} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 14 }} />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                Slug * <span style={{ fontWeight: 400, color: "var(--muted)" }}>unique inside this course</span>
                <input aria-label="Lesson slug" value={editSlug} onChange={(e) => setEditSlug(e.target.value)} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 14 }} />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                YouTube video <span style={{ fontWeight: 400, color: "var(--muted)" }}>optional — watch / youtu.be / embed / ID</span>
                <input aria-label="Lesson YouTube video URL" value={editVideo} onChange={(e) => setEditVideo(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" maxLength={500} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 14 }} />
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 600 }}>
                <input type="checkbox" checked={editRequired} onChange={(e) => setEditRequired(e.target.checked)} aria-label="Lesson required" />
                Required <span style={{ fontWeight: 400, color: "var(--muted)" }}>(counts toward progress + completion)</span>
              </label>
              <StructuredBlockEditor blocks={editBlocks} onChange={setEditBlocks} allowedBlockTypes={LESSON_BLOCK_TYPES} eyebrowHint="LESSON BODY" />
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn primary small" type="submit" disabled={busy === `save-lesson-${editingLesson.lesson.id}`}>
                  {busy === `save-lesson-${editingLesson.lesson.id}` ? "Saving…" : "Save lesson"}
                </button>
                <button className="btn ghost small" type="button" onClick={() => setEditingLesson(null)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
