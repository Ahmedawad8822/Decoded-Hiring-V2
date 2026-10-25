"use client";

import { useSearchParams } from "next/navigation";

import { LeadForm } from "@/features/leads/lead-form";
import type { LeadSubmissionKind } from "@/features/leads/types";

const REASON_KINDS: Record<string, LeadSubmissionKind> = {
  coaching: "coaching",
  workshop: "workshop",
  "ai-recruiter-os": "ai_os",
};

/**
 * Reads ?reason= on the client so /contact can be a static page. The reason
 * only selects the form variant and the audiencePath that is bound into the
 * submitLead action; the server action validates both, exactly as when they
 * were bound by the server component.
 */
export function ContactForm() {
  const params = useSearchParams();
  const reason = params.get("reason") ?? "general";
  const kind: LeadSubmissionKind = REASON_KINDS[reason] ?? "contact";

  return (
    <LeadForm
      kind={kind}
      sourceRoute="/contact"
      audiencePath={reason}
      submitLabel="Send the context"
    />
  );
}
