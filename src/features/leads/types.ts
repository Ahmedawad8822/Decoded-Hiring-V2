export const LEAD_SUBMISSION_KINDS = [
  "workshop",
  "coaching",
  "ai_os",
  "contact",
] as const;

export type LeadSubmissionKind =
  (typeof LEAD_SUBMISSION_KINDS)[number];

export type LeadActionState =
  | undefined
  | { ok: true; message: string }
  | {
      ok: false;
      message: string;
      requestId: string;
      fieldErrors?: Record<string, string[]>;
    };
