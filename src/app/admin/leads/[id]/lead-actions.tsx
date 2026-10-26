"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  closeLeadAction,
  reopenLeadAction,
  reviewLeadAction,
} from "@/features/leads/admin-actions";
import type { LeadSubmissionStatus } from "@/features/leads/types";

export function LeadActions({ id, status }: { id: string; status: LeadSubmissionStatus }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: typeof reviewLeadAction) {
    setError(null);
    startTransition(async () => {
      const result = await action(id, status);
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {status === "NEW" && (
          <button type="button" className="btn small" disabled={pending} onClick={() => run(reviewLeadAction)}>
            Mark reviewed
          </button>
        )}
        {(status === "NEW" || status === "REVIEWED") && (
          <button type="button" className="btn secondary small" disabled={pending} onClick={() => run(closeLeadAction)}>
            Mark closed
          </button>
        )}
        {(status === "REVIEWED" || status === "CLOSED") && (
          <button type="button" className="btn secondary small" disabled={pending} onClick={() => run(reopenLeadAction)}>
            Reopen to NEW
          </button>
        )}
      </div>
      {error && (
        <p role="alert" style={{ color: "var(--danger, #b00020)", marginTop: 8 }}>
          {error}
        </p>
      )}
    </div>
  );
}
