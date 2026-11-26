"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { restartCourseAction } from "@/features/enrollments/actions";

/**
 * Self-serve "Restart course" for the enrolled course page. Mirrors the
 * LeaveCourseButton confirm pattern: the confirm panel moves focus into
 * itself, Escape cancels and returns focus to the trigger. On success the
 * learner is sent to the first lesson.
 */
export function RestartCourseButton({ courseSlug }: { courseSlug: string }) {
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the panel closes via cancel: focus must return to the trigger
  // AFTER React commits (the trigger is unmounted while the panel is open,
  // so focusing synchronously in cancel() would hit a null ref).
  const returnFocusRef = useRef(false);

  useEffect(() => {
    if (confirming) {
      // Focus moves into the confirm panel when it opens.
      panelRef.current?.focus();
    } else if (returnFocusRef.current) {
      returnFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [confirming]);

  const cancel = () => {
    if (busy) return;
    returnFocusRef.current = true;
    setConfirming(false);
    setError(null);
  };

  const handleRestart = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await restartCourseAction({ courseSlug });
      if (!res.ok) {
        setError(res.error || "Could not restart this course");
      } else {
        setConfirming(false);
        router.push(res.data.firstLessonHref);
        router.refresh();
      }
    } catch {
      setError("Could not restart this course. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <div className="lrn-leave">
        <button
          ref={triggerRef}
          type="button"
          className="btn ghost lrn-leave-trigger"
          onClick={() => setConfirming(true)}
        >
          Restart course
        </button>
      </div>
    );
  }

  return (
    <div className="lrn-leave">
      <div
        ref={panelRef}
        className="lrn-leave-panel"
        role="dialog"
        aria-modal="false"
        aria-labelledby="restart-course-heading"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <h2 className="a-h2" id="restart-course-heading">
          Restart this course?
        </h2>
        <div className="lrn-leave-copy">
          <p>Restarting clears your lesson progress and video resume positions for this course, and takes you back to the first lesson.</p>
          <ul>
            <li>Your quiz attempts, notes and certificates are kept.</li>
            <li>Already-issued certificates stay valid.</li>
            <li>Your enrollment record stays.</li>
          </ul>
        </div>
        {error && (
          <p role="alert" className="lrn-leave-error">
            {error}
          </p>
        )}
        <div className="lrn-leave-actions">
          <button
            type="button"
            className="btn danger"
            onClick={handleRestart}
            disabled={busy}
          >
            {busy ? "Restarting…" : "Restart course"}
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={cancel}
            disabled={busy}
          >
            Keep my progress
          </button>
        </div>
      </div>
    </div>
  );
}
