"use client";
import { humanLabel, EmptyState, PageHeader, Button, Input, Select, Textarea } from "../_ui";

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

import { parseCourseLanding } from "@/features/courses/metadata";

type CourseRow = Course & {
  enrollmentCount: number;
  offerId: string | null;
  offerActive: boolean | null;
  effectiveAccessMode: string;
};

const ACCESS_MODES = ["FREE", "PAID_ONE_TIME", "MANUAL_INVOICE", "PAYMENT_DISABLED"] as const;

export function CoursesClient({
  startNew = false,
  initialCourses,
  initialQ,
  initialStatus,
}: {
  startNew?: boolean;
  initialCourses: CourseRow[];
  initialQ: string;
  initialStatus: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(startNew);
  const [editing, setEditing] = useState<CourseRow | null>(null);

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [outcomes, setOutcomes] = useState("");
  const [audience, setAudience] = useState("");
  const [faq, setFaq] = useState<{ q: string; a: string }[]>([]);
  const [instructorName, setInstructorName] = useState("");
  const [instructorBio, setInstructorBio] = useState("");
  const [certificateEnabled, setCertificateEnabled] = useState(false);
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
    setOutcomes("");
    setAudience("");
    setFaq([]);
    setInstructorName("");
    setInstructorBio("");
    setAccessMode("FREE");
    setCertificateEnabled(false);
    setEditing(null);
    setShowCreate(false);
    setError(null);
  };

  const startEdit = (course: CourseRow) => {
    setEditing(course);
    setTitle(course.title);
    setSlug(course.slug);
    setDescription(course.description || "");
    const landing = parseCourseLanding(course);
    setOutcomes(landing.outcomes.join("\n"));
    setFaq(landing.faq);
    setAudience(course.audience || "");
    setInstructorName(course.instructorName || "");
    setInstructorBio(course.instructorBio || "");
    setAccessMode(course.accessMode);
    setCertificateEnabled(course.certificateEnabled);
    setShowCreate(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("save");
    setError(null);
    try {
      const payload = {
        certificateEnabled,
        title: title.trim(),
        slug: slug.trim(),
        description: description.trim() || null,
        outcomes: outcomes.split("\n").map((line) => line.trim()).filter(Boolean),
        audience: audience.trim() || null,
        faq,
        instructorName: instructorName.trim() || null,
        instructorBio: instructorBio.trim() || null,
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
      <div className="s-row s-justify-content-space-between s-align-items-baseline s-gap-12 s-flex-wrap-wrap" >
        <PageHeader eyebrow="Learning" title={<>Courses</>} />
        <Button className="btn primary small" type="button" onClick={() => { resetForm(); setShowCreate(true); }}>
          ＋ New course
        </Button>
      </div>

      <form className="s-row s-gap-10 s-margin-top-20 s-flex-wrap-wrap"
        onSubmit={(e) => { e.preventDefault(); applyFilter(); }}

      >
        <label className="s-stack s-gap-4 s-text-sm" >
          Search
          <Input className="s-padding-8px-12px s-text-sm s-min-width-220"
            aria-label="Search courses"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Title or slug…"

          />
        </label>
        <label className="s-stack s-gap-4 s-text-sm" >
          Status
          <Select className="s-padding-8px-12px s-text-sm"
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}

          >
            <option value="all">All</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </Select>
        </label>
        <Button className="btn secondary small s-align-self-end" type="submit" >
          Apply
        </Button>
      </form>

      {error && (
        <div className="s-margin-top-16 s-padding-10px-14px s-danger s-text-sm" role="alert" >
          {error}
        </div>
      )}

      {confirmModal && (
        <div className="dialog s-stack s-place-items-center" >
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
              <Button type="button" className="btn ghost small" onClick={() => setConfirmModal(null)}>
                Cancel
              </Button>
              <Button
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
              </Button>
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <form className="s-margin-top-20 s-padding-22px-24px s-stack s-gap-14"
          onSubmit={handleSave}

        >
          <b >{editing ? "Edit course" : "New draft course"}</b>
          <label className="s-stack s-gap-6 s-text-sm s-bold" >
            Title *
            <Input className="s-padding-10px-14px s-text-sm" aria-label="Course title" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={160} />
          </label>
          <label className="s-stack s-gap-6 s-text-sm s-bold" >
            Slug * <span className="s-muted" >lowercase, hyphens, unique</span>
            <Input className="s-padding-10px-14px s-text-sm" aria-label="Course slug" value={slug} onChange={(e) => setSlug(e.target.value)} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="super-recruiter" />
          </label>
          <label className="s-stack s-gap-6 s-text-sm s-bold" >
            Description
            <Textarea className="s-padding-10px-14px s-text-sm" aria-label="Course description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} />
          </label>
          <label className="s-stack s-gap-6 s-text-sm s-bold">
            What you&apos;ll learn (one outcome per line, up to 12)
            <Textarea aria-label="Learning outcomes" value={outcomes} onChange={(e) => setOutcomes(e.target.value)} rows={4} maxLength={2411} />
          </label>
          <label className="s-stack s-gap-6 s-text-sm s-bold">
            Who it&apos;s for
            <Textarea aria-label="Course audience" value={audience} onChange={(e) => setAudience(e.target.value)} rows={3} maxLength={2000} />
          </label>
          <label className="s-stack s-gap-6 s-text-sm s-bold">
            Instructor name
            <Input value={instructorName} onChange={(e) => setInstructorName(e.target.value)} maxLength={160} />
          </label>
          <label className="s-stack s-gap-6 s-text-sm s-bold">
            Instructor bio
            <Textarea value={instructorBio} onChange={(e) => setInstructorBio(e.target.value)} rows={3} maxLength={1500} />
          </label>
          <label>
            <Input type="checkbox" checked={certificateEnabled} onChange={(e) => setCertificateEnabled(e.target.checked)} />
            {" "}Issue certificates on completion
          </label>
          <fieldset className="s-stack s-gap-14">
            <legend>Frequently asked questions</legend>
            {faq.map((item, index) => (
              <div className="s-stack s-gap-6" key={index}>
                <label>Question {index + 1}
                  <Input value={item.q} maxLength={200} required onChange={(e) => setFaq(faq.map((row, i) => i === index ? { ...row, q: e.target.value } : row))} />
                </label>
                <label>Answer {index + 1}
                  <Textarea value={item.a} maxLength={1500} required rows={3} onChange={(e) => setFaq(faq.map((row, i) => i === index ? { ...row, a: e.target.value } : row))} />
                </label>
                <Button type="button" variant="ghost" onClick={() => setFaq(faq.filter((_, i) => i !== index))}>Remove FAQ {index + 1}</Button>
              </div>
            ))}
            <Button type="button" variant="secondary" disabled={faq.length >= 12} onClick={() => setFaq([...faq, { q: "", a: "" }])}>Add FAQ</Button>
          </fieldset>
          <label className="s-stack s-gap-6 s-text-sm s-bold" >
            {editing?.offerId ? "Course access" : "Access mode"}
            <Select className="s-padding-10px-14px s-text-sm"
              aria-label="Access mode"
              value={accessMode}
              onChange={(e) => setAccessMode(e.target.value)}
              disabled={Boolean(editing?.offerId)}

            >
              {ACCESS_MODES.map((m) => <option key={m} value={m}>{humanLabel(m)}</option>)}
            </Select>
          </label>
          <p className="help s-text-sm s-muted" >
            {editing?.offerId
              ? `Access is managed by the linked offer (${humanLabel(editing.effectiveAccessMode)}${editing.offerActive === false ? ", inactive" : ""}). Edit it in Bookings & offers.`
              : "Free courses allow immediate enrollment. Link an offer in Bookings & offers to manage paid access."}
          </p>
          <div className="s-row s-gap-10" >
            <Button className="btn primary small" type="submit" disabled={busy === "save"}>
              {busy === "save" ? "Saving…" : editing ? "Save changes" : "Create draft"}
            </Button>
            <Button className="btn ghost small" type="button" onClick={resetForm}>Cancel</Button>
          </div>
        </form>
      )}

      <div className="s-stack s-gap-16 s-margin-top-20" >
        {initialCourses.length === 0 && (
          <EmptyState icon="courses" title="Your next learning journey starts here" action={<Button variant="primary" onClick={() => { resetForm(); setShowCreate(true); }}>＋ New course</Button>}>Create the first draft to begin the curriculum.</EmptyState>
        )}
        {initialCourses.map((course) => (
          <div className="s-padding-22px-24px s-stack s-gap-14 ui-card" key={course.id} data-course-slug={course.slug} >
            <div className="s-row s-justify-content-space-between s-gap-12 s-flex-wrap-wrap s-align-items-flex-start" >
              <div>
                <b >{course.title}</b>
                <p className="muted s-text-sm s-margin-top-4" >
                  /{course.slug} · {humanLabel(course.effectiveAccessMode)}
                  {course.offerId ? ` via Offer${course.offerActive === false ? " (inactive)" : ""}` : ""}
                  {" · "}{course.enrollmentCount} enrolled
                </p>
              </div>
              <span className={`lifecycle ${course.status}`}>{course.status.toUpperCase()}</span>
            </div>
            <div className="s-row s-gap-10 s-flex-wrap-wrap" >
              <Link className="btn secondary small" href={`/admin/courses/${course.id}/curriculum`} >
                Curriculum →
              </Link>
              <Link className="btn secondary small" href={`/admin/courses/${course.id}/certificates`}>Certificates →</Link>
              <Button className="btn ghost small" type="button" onClick={() => startEdit(course)}>
                Edit
              </Button>
              {course.status === "draft" && (
                <Button className="btn ghost small" type="button" disabled={busy === `pub-${course.id}`} onClick={() => runAction(`pub-${course.id}`, () => publishCourseAction(course.id))}>
                  Publish
                </Button>
              )}
              {course.status === "published" && (
                <Button className="btn ghost small" type="button" disabled={busy === `unpub-${course.id}`} onClick={() => runAction(`unpub-${course.id}`, () => unpublishCourseAction(course.id))}>
                  Unpublish
                </Button>
              )}
              {course.status !== "archived" && (
                <Button className="btn ghost small" type="button" disabled={busy === `arch-${course.id}`} onClick={() => setConfirmModal({ action: "archive", courseId: course.id, courseTitle: course.title })}>
                  Archive
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
