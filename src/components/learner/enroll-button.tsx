"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { enrollFreeAction } from "@/features/enrollments/actions";

export function EnrollButton({ courseId, courseSlug }: { courseId: string; courseSlug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEnroll = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await enrollFreeAction(courseId);
      if (!res.ok) {
        setError(res.error || "Enrollment failed");
      } else {
        router.push(`/learn/courses/${courseSlug}`);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button type="button" className="btn primary" onClick={handleEnroll} disabled={busy}>
        {busy ? "Enrolling…" : "Start free — enroll now"}
      </button>
      {error && (
        <p role="alert" style={{ marginTop: 10, fontSize: 13, color: "#7c2d12" }}>
          {error}
        </p>
      )}
    </div>
  );
}
