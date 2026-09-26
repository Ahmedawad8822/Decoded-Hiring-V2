"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Course } from "@/lib/db";
import {
  archiveCourseAction,
  createCourseAction,
  publishCourseAction,
  unpublishCourseAction,
  updateCourseAction,
} from "@/features/courses/actions";

type CourseRow = Course & {
  enrollmentCount: number;
  offerId: string | null;
  offerActive: boolean | null;
  effectiveAccessMode: string;
};

const ACCESS_MODES = ["FREE", "PAID_ONE_TIME", "MANUAL_INVOICE", "PAYMENT_DISABLED"] as const;

export function CoursesClient({
  initialCourses,
  initialQ,
  initialStatus,
}: {
  initialCourses: CourseRow[];
  initialQ: string;
  initialStatus: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<CourseRow | null>(null);

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [accessMode, setAccessMode] = useState<string>("FREE");

  const [confirmModal, setConfirmModal] = useState<{
    action: "archive";
    courseId: string;
    courseTitle: string;
  } | null>(null);

  const applyFilter = () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (status !== "all") params.set("status", status);
    const qs = params.toString();
    router.push(`/admin/courses${qs ? `?${qs}` : ""}`);
    router.refresh();
  };

  const resetForm = () => {
    setTitle("");
    setSlug("");
    setDescription("");
    setAccessMode("FREE");
    setEditing(null);
    setShowCreate(false);
    setError(null);
  };

  const startEdit = (course: CourseRow) => {
    setEditing(course);
    setTitle(course.title);
    setSlug(course.slug);
    setDescription(course.description || "");
    setAccessMode(course.accessMode);
    setShowCreate(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("save");
    setError(null);
    try {
      const payload = {
        title: title.trim(),
        slug: slug.trim(),
        description: description.trim() || null,
        ...(!editing?.offerId ? { accessMode } : {}),
      };
      const res = editing
        ? await updateCourseAction({ id: editing.id, ...payload })
        : await createCourseAction(payload);
      if (!res.ok) {
        setError(res.error || "Save failed");
      } else {
        resetForm();
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  const runAction = async (
    key: string,
    fn: () => Promise<{ ok: boolean; error?: string }>
  ) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error || "Action failed");
      else router.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 className="a-h1" style={{ marginBottom: 4 }}>Courses</h1>
        <button className="btn secondary small" type="button" onClick={() => { resetForm(); setShowCreate(true); }}>
          ＋ New course
        </button>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); applyFilter(); }}
        style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}
      >
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          Search
          <input
            aria-label="Search courses"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Title or slug…"
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 13, minWidth: 220 }}
          />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          Status
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 13 }}
          >
            <option value="all">All</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <button className="btn secondary small" type="submit" style={{ alignSelf: "end" }}>
          Apply
        </button>
      </form>

      {error && (
        <div role="alert" style={{ marginTop: 16, padding: "10px 14px", borderRadius: 8, background: "var(--coral-soft, #f5d6cd)", color: "#7c2d12", fontSize: 13, border: "1px solid rgba(235, 116, 94, 0.4)" }}>
          {error}
        </div>
      )}

      {confirmModal && (
        <div className="dialog" style={{ display: "grid", placeItems: "center" }}>
          <div className="dg-panel">
            <h3>Confirm Archive</h3>
            <div className="dg-body">
              <p>
                Are you sure you want to <strong>archive</strong> &ldquo;
                {confirmModal.courseTitle}&rdquo;?
              </p>
              <div className="dg-consequences">
                <strong>Consequences:</strong>
                <ul>
                  <li>The course will no longer accept new enrollments.</li>
                  <li>Existing enrolled learners retain access.</li>
                  <li>Archived courses are terminal — cannot be republished or unpublished.</li>
                </ul>
              </div>
            </div>
            <div className="dg-actions">
              <button type="button" className="btn ghost small" onClick={() => setConfirmModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn danger small"
                onClick={() => {
                  if (confirmModal) {
                    runAction(`arch-${confirmModal.courseId}`, () => archiveCourseAction(confirmModal.courseId));
                  }
                  setConfirmModal(null);
                }}
              >
                Confirm Archive
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <form
          onSubmit={handleSave}
          style={{ marginTop: 20, border: "1px solid var(--line)", borderRadius: "var(--radius-surface)", background: "var(--paper-bright)", padding: "22px 24px", display: "grid", gap: 14 }}
        >
          <b style={{ fontSize: 15 }}>{editing ? "Edit course" : "New draft course"}</b>
          <label style={{ display: "grid", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
            Title *
            <input aria-label="Course title" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={160} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 14 }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
            Slug * <span style={{ fontWeight: 400, color: "var(--muted)" }}>lowercase, hyphens, unique</span>
            <input aria-label="Course slug" value={slug} onChange={(e) => setSlug(e.target.value)} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="super-recruiter" style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 14 }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
            Description
            <textarea aria-label="Course description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 14 }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
            {editing?.offerId ? "Legacy access fallback" : "Access mode"}
            <select
              aria-label="Access mode"
              value={accessMode}
              onChange={(e) => setAccessMode(e.target.value)}
              disabled={Boolean(editing?.offerId)}
              style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 14 }}
            >
              {ACCESS_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <p className="help" style={{ fontSize: 12, color: "var(--muted)" }}>
            {editing?.offerId
              ? `Commercial access is owned by linked Offer ${editing.offerId} (${editing.effectiveAccessMode}${editing.offerActive === false ? ", inactive" : ""}). The legacy course field is retained only as a fallback and cannot be edited here.`
              : "This is the Mission 06 fallback until a Commerce Offer is linked. Only FREE enrolls automatically; paid modes remain fail-closed without checkout."}
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn primary small" type="submit" disabled={busy === "save"}>
              {busy === "save" ? "Saving…" : editing ? "Save changes" : "Create draft"}
            </button>
            <button className="btn ghost small" type="button" onClick={resetForm}>Cancel</button>
          </div>
        </form>
      )}

      <div style={{ display: "grid", gap: 16, marginTop: 20 }}>
        {initialCourses.length === 0 && (
          <p className="muted" style={{ fontSize: 13.5 }}>No courses match. Create the first draft to begin the curriculum.</p>
        )}
        {initialCourses.map((course) => (
          <div key={course.id} data-course-slug={course.slug} style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-surface)", background: "var(--paper-bright)", padding: "22px 24px", display: "grid", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div>
                <b style={{ fontSize: 16 }}>{course.title}</b>
                <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                  /{course.slug} · {course.effectiveAccessMode}
                  {course.offerId ? ` via Offer${course.offerActive === false ? " (inactive)" : ""}` : " legacy"}
                  {" · "}{course.enrollmentCount} enrolled
                </p>
              </div>
              <span className={`lifecycle ${course.status}`}>{course.status.toUpperCase()}</span>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Link className="btn secondary small" href={`/admin/courses/${course.id}/curriculum`} style={{ textDecoration: "none" }}>
                Curriculum →
              </Link>
              <button className="btn ghost small" type="button" onClick={() => startEdit(course)}>
                Edit
              </button>
              {course.status === "draft" && (
                <button className="btn ghost small" type="button" disabled={busy === `pub-${course.id}`} onClick={() => runAction(`pub-${course.id}`, () => publishCourseAction(course.id))}>
                  Publish
                </button>
              )}
              {course.status === "published" && (
                <button className="btn ghost small" type="button" disabled={busy === `unpub-${course.id}`} onClick={() => runAction(`unpub-${course.id}`, () => unpublishCourseAction(course.id))}>
                  Unpublish
                </button>
              )}
              {course.status !== "archived" && (
                              <button className="btn ghost small" type="button" disabled={busy === `arch-${course.id}`} onClick={() => setConfirmModal({ action: "archive", courseId: course.id, courseTitle: course.title })}> 
                                Archive
                              </button>
                            )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
