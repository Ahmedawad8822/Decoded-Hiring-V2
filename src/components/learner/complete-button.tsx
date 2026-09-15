"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { markLessonCompleteAction } from "@/features/progress/actions";

export function CompleteButton({
  enrollmentId,
  lessonId,
  alreadyDone,
  nextHref,
}: {
  enrollmentId: string;
  lessonId: string;
  alreadyDone: boolean;
  nextHref: string | null;
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
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <span className="btn primary" style={{ pointerEvents: "none", opacity: 0.85 }}>
          ✓ Completed
        </span>
        {nextHref && (
          <button type="button" className="btn secondary" onClick={() => router.push(nextHref)}>
            Next →
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="btn primary" onClick={handleComplete} disabled={busy}>
          {busy ? "Saving…" : "Mark lesson complete"}
        </button>
        {nextHref && (
          <button type="button" className="btn secondary" onClick={() => router.push(nextHref)}>
            Next →
          </button>
        )}
      </div>
      {error && (
        <p role="alert" style={{ marginTop: 10, fontSize: 13, color: "#7c2d12" }}>
          {error}
        </p>
      )}
    </div>
  );
}
