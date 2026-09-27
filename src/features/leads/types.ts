export const LEAD_SUBMISSION_KINDS = [
  "workshop",
  "coaching",
  "ai_os",
  "contact",
] as const;

export type LeadSubmissionKind =
  (typeof LEAD_SUBMISSION_KINDS)[number];

export const LEAD_SUBMISSION_STATUSES = [
  "NEW",
  "REVIEWED",
  "CLOSED",
] as const;

export type LeadSubmissionStatus =
  (typeof LEAD_SUBMISSION_STATUSES)[number];

export type LeadActionState =
  | undefined
  | { ok: true; message: string }
  | {
      ok: false;
      message: string;
      requestId: string;
      fieldErrors?: Record<string, string[]>;
    };
