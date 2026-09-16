"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { markLessonCompleteAction } from "@/features/progress/actions";

/**
 * Learner mark-complete control. Prev/next navigation lives in the lesson
 * shell (.ls-actions / .ls-mobile-bar) — this button only flips its own
 * state so there is exactly one Next per action row.
 */
export function CompleteButton({
  enrollmentId,
  lessonId,
  alreadyDone,
}: {
  enrollmentId: string;
  lessonId: string;
  alreadyDone: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(alreadyDone);
  const [error, setError] = useState<string | null>(null);

  const handleComplete = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await markLessonCompleteAction(enrollmentId, lessonId);
      if (!res.ok) {
        setError(res.error || "Could not mark lesson complete");
      } else {
        setDone(true);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <span className="btn primary" style={{ pointerEvents: "none", opacity: 0.85 }}>
        ✓ Completed
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 8 }}>
      <button type="button" className="btn primary" onClick={handleComplete} disabled={busy}>
        {busy ? "Saving…" : "Mark lesson complete"}
      </button>
      {error && (
        <span role="alert" style={{ fontSize: 13, color: "#7c2d12" }}>
          {error}
        </span>
      )}
    </span>
  );
}
