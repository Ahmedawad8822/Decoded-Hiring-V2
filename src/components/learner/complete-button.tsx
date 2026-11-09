"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markLessonCompleteAction } from "@/features/progress/actions";

/** Completion navigates to a server-owned target; Prev/Next remain free navigation. */
export function CompleteButton({
  enrollmentId, lessonId, alreadyDone, continueHref,
}: {
  enrollmentId: string;
  lessonId: string;
  alreadyDone: boolean;
  continueHref: string;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleComplete = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await markLessonCompleteAction(enrollmentId, lessonId);
        if (!res.ok || !res.data) {
          setError(res.error || "Could not mark lesson complete");
        } else {
          router.push(res.data.nextHref);
        }
      } catch {
        setError("Could not mark lesson complete. Please try again.");
      }
    });
  };

  if (alreadyDone) {
    return (
      <span className="lesson-completion-control">
        <span className="lesson-completed">Completed ✓</span>
        <Link className="btn primary" href={continueHref}>Continue →</Link>
      </span>
    );
  }

  return (
    <span className="lesson-completion-control">
      <button type="button" className="btn primary" onClick={handleComplete} disabled={busy}
        aria-busy={busy}>
        {busy ? "Saving…" : "Complete & continue"}
      </button>
      {error && <span role="alert" aria-live="assertive" className="lesson-completion-error">{error}</span>}
    </span>
  );
}
