import { eq } from "drizzle-orm";

import { getDb, leadSubmissions, type LeadSubmission } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import {
  anonymousRateLimitFingerprint,
  consumePublicFixedWindowLimit,
} from "@/features/public-intake/rate-limit";
import type { LeadSubmissionKind } from "./types";

export type CreateLeadSubmissionInput = {
  idempotencyKey: string;
  kind: LeadSubmissionKind;
  fullName: string;
  email: string;
  positionTitle: string | null;
  companyName: string | null;
  countryCode: string;
  phoneE164: string | null;
  problemSummary: string | null;
  desiredOutcome: string | null;
  timing: string | null;
  teamSize: number | null;
  deliveryPreference: string | null;
  aiUseLevel: string | null;
  workflowToImprove: string | null;
  sourceRoute: string;
  audiencePath: string | null;
  privacyAcknowledged: boolean;
  researchAccepted: boolean;
  emailMarketing: boolean;
  whatsapp: boolean;
  calls: boolean;
  now: Date;
};

export type LeadDomainErrorCode =
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED";

export class LeadDomainError extends Error {
  constructor(
    message: string,
    public readonly code: LeadDomainErrorCode,
  ) {
    super(message);
    this.name = "LeadDomainError";
  }
}

function newId(): string {
  return `lead_${crypto.randomUUID().slice(0, 16)}`;
}

async function getLeadByIdempotencyKey(
  idempotencyKey: string,
): Promise<LeadSubmission | undefined> {
  const db = await getDb();
  return db
    .select()
    .from(leadSubmissions)
    .where(eq(leadSubmissions.idempotencyKey, idempotencyKey))
    .get();
}

function assertSameIntent(
  existing: LeadSubmission,
  input: CreateLeadSubmissionInput,
): LeadSubmission {
  const same =
    existing.kind === input.kind &&
    existing.fullName === input.fullName &&
    existing.email === input.email.toLowerCase() &&
    (existing.positionTitle ?? null) === input.positionTitle &&
    (existing.companyName ?? null) === input.companyName &&
    existing.countryCode === input.countryCode &&
    (existing.phoneE164 ?? null) === input.phoneE164 &&
    (existing.problemSummary ?? null) === input.problemSummary &&
    (existing.desiredOutcome ?? null) === input.desiredOutcome &&
    (existing.timing ?? null) === input.timing &&
    (existing.teamSize ?? null) === input.teamSize &&
    (existing.deliveryPreference ?? null) === input.deliveryPreference &&
    (existing.aiUseLevel ?? null) === input.aiUseLevel &&
    (existing.workflowToImprove ?? null) === input.workflowToImprove &&
    existing.sourceRoute === input.sourceRoute &&
    (existing.audiencePath ?? null) === input.audiencePath &&
    existing.privacyAcknowledged === input.privacyAcknowledged &&
    existing.researchAccepted === input.researchAccepted &&
    existing.emailMarketing === input.emailMarketing &&
    existing.whatsapp === input.whatsapp &&
    existing.calls === input.calls;

  if (!same) {
    throw new LeadDomainError(
      "This idempotency key is already bound to a different enquiry.",
      "IDEMPOTENCY_CONFLICT",
    );
  }
  return existing;
}

async function assertLeadVelocityAllowed(
  input: CreateLeadSubmissionInput,
): Promise<void> {
  const emailFingerprint = await anonymousRateLimitFingerprint(input.email);

  const emailAllowed = await consumePublicFixedWindowLimit({
    scopeKey: `lead:email:${emailFingerprint}`,
    now: input.now,
    windowMinutes: 15,
    maxCount: 5,
  });
  if (!emailAllowed) {
    throw new LeadDomainError(
      "Too many enquiry submissions were created in a short window.",
      "RATE_LIMITED",
    );
  }

  const kindAllowed = await consumePublicFixedWindowLimit({
    scopeKey: `lead:kind:${input.kind}`,
    now: input.now,
    windowMinutes: 15,
    maxCount: 40,
  });
  if (!kindAllowed) {
    throw new LeadDomainError(
      "Too many enquiry submissions were created in a short window.",
      "RATE_LIMITED",
    );
  }
}

export async function createLeadSubmission(
  input: CreateLeadSubmissionInput,
): Promise<LeadSubmission> {
  const existing = await getLeadByIdempotencyKey(input.idempotencyKey);
  if (existing) return assertSameIntent(existing, input);

  await assertLeadVelocityAllowed(input);

  const db = await getDb();
  const id = newId();
  const values = {
    id,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    status: "NEW" as const,
    fullName: input.fullName,
    email: input.email.toLowerCase(),
    positionTitle: input.positionTitle,
    companyName: input.companyName,
    countryCode: input.countryCode,
    phoneE164: input.phoneE164,
    problemSummary: input.problemSummary,
    desiredOutcome: input.desiredOutcome,
    timing: input.timing,
    teamSize: input.teamSize,
    deliveryPreference: input.deliveryPreference,
    aiUseLevel: input.aiUseLevel,
    workflowToImprove: input.workflowToImprove,
    sourceRoute: input.sourceRoute,
    audiencePath: input.audiencePath,
    privacyAcknowledged: input.privacyAcknowledged,
    researchAccepted: input.researchAccepted,
    emailMarketing: input.emailMarketing,
    whatsapp: input.whatsapp,
    calls: input.calls,
    createdAt: input.now,
    updatedAt: input.now,
  };

  try {
    await db.insert(leadSubmissions).values(values).run();
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      const winner = await getLeadByIdempotencyKey(input.idempotencyKey);
      if (winner) return assertSameIntent(winner, input);
    }
    throw error;
  }

  const created = await getLeadByIdempotencyKey(input.idempotencyKey);
  if (!created) {
    throw new Error("Lead submission committed but could not be re-read.");
  }
  return created;
}

export const __leadTestOnly =
  process.env.DH_LEADS_TEST_SEAM === "1"
    ? { getLeadByIdempotencyKey }
    : undefined;
