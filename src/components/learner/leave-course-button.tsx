"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { leaveCourseAction } from "@/features/enrollments/actions";

/**
 * Low-emphasis "Leave course" control for the enrolled course page.
 * One button plus one confirmation step: the confirm panel moves focus into
 * itself, Escape cancels and returns focus to the trigger.
 */
export function LeaveCourseButton({ courseSlug }: { courseSlug: string }) {
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

  const handleLeave = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await leaveCourseAction({ courseSlug });
      if (!res.ok) {
        setError(res.error || "Could not leave this course");
      } else {
        setConfirming(false);
        router.refresh();
      }
    } catch {
      setError("Could not leave this course. Please try again.");
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
          Leave course
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
        aria-labelledby="leave-course-heading"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <h2 className="a-h2" id="leave-course-heading">
          Leave this course?
        </h2>
        <div className="lrn-leave-copy">
          <p>Leaving stops your access to its lessons, resources, notes and quizzes right now.</p>
          <ul>
            <li>Your progress, notes and certificates are kept.</li>
            <li>Already-issued certificates stay valid.</li>
            <li>You can re-enroll any time and pick up where you left off.</li>
          </ul>
          <p>Paid courses (not available yet) will follow their own refund terms.</p>
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
            onClick={handleLeave}
            disabled={busy}
          >
            {busy ? "Leaving…" : "Leave course"}
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={cancel}
            disabled={busy}
          >
            Stay enrolled
          </button>
        </div>
      </div>
    </div>
  );
}
