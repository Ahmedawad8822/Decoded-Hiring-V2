"use client";
import { Button } from "../../_ui";

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
      <div className="s-row s-gap-8 s-flex-wrap-wrap" >
        {status === "NEW" && (
          <Button type="button" className="btn small" disabled={pending} onClick={() => run(reviewLeadAction)}>
            Mark reviewed
          </Button>
        )}
        {(status === "NEW" || status === "REVIEWED") && (
          <Button type="button" className="btn secondary small" disabled={pending} onClick={() => run(closeLeadAction)}>
            Mark closed
          </Button>
        )}
        {(status === "REVIEWED" || status === "CLOSED") && (
          <Button type="button" className="btn secondary small" disabled={pending} onClick={() => run(reopenLeadAction)}>
            Reopen to NEW
          </Button>
        )}
      </div>
      {error && (
        <p className="s-danger s-margin-top-8" role="alert" >
          {error}
        </p>
      )}
    </div>
  );
}
