"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getRequestClientIpHash } from "@/features/public-intake/rate-limit";
import { createLeadSubmission, LeadDomainError } from "./service";
import type { LeadActionState, LeadSubmissionKind } from "./types";

const optionalText = (maximum: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().max(maximum).nullable(),
  );

const optionalPhone = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string()
    .trim()
    .regex(/^\+[1-9][0-9]{7,14}$/)
    .nullable(),
);

const leadSchema = z
  .object({
    kind: z.enum(["workshop", "coaching", "ai_os", "contact"]),
    idempotencyKey: z.uuid(),
    fullName: z.string().trim().min(2).max(120),
    email: z.email().trim().toLowerCase().max(254),
    positionTitle: optionalText(120),
    companyName: optionalText(160),
    countryCode: z.enum(["EG", "SA", "AE", "QA", "KW", "BH", "OM"]),
    phoneE164: optionalPhone,
    problemSummary: optionalText(2000),
    desiredOutcome: optionalText(1200),
    timing: optionalText(120),
    teamSize: z.preprocess(
      (value) => (value === "" || value === null ? null : Number(value)),
      z.number().int().positive().max(100000).nullable(),
    ),
    deliveryPreference: z.preprocess(
      (value) => (value === "" ? null : value),
      z
        .enum([
          "private_team",
          "open_cohort",
          "remote",
          "in_person",
          "flexible",
        ])
        .nullable(),
    ),
    aiUseLevel: z.preprocess(
      (value) => (value === "" ? null : value),
      z
        .enum([
          "exploring",
          "using_tools",
          "building_workflows",
          "building_agents",
        ])
        .nullable(),
    ),
    workflowToImprove: optionalText(160),
    sourceRoute: z.string().trim().startsWith("/").max(240),
    audiencePath: optionalText(80),
    privacyAcknowledged: z.boolean(),
    researchAccepted: z.boolean(),
    emailMarketing: z.boolean(),
    whatsapp: z.boolean(),
    calls: z.boolean(),
    website: z.string().max(0),
  })
  .superRefine((value, ctx) => {
    if (!value.privacyAcknowledged) {
      ctx.addIssue({
        code: "custom",
        path: ["privacyAcknowledged"],
        message: "Please acknowledge the privacy note.",
      });
    }
    if (value.kind === "ai_os" && !value.researchAccepted) {
      ctx.addIssue({
        code: "custom",
        path: ["researchAccepted"],
        message: "Research consent is required for the waitlist.",
      });
    }
    if (value.kind === "ai_os" && !value.aiUseLevel) {
      ctx.addIssue({
        code: "custom",
        path: ["aiUseLevel"],
        message: "Please select how you are using AI today.",
      });
    }
    if (
      value.kind === "ai_os" &&
      (!value.workflowToImprove || value.workflowToImprove.length < 3)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workflowToImprove"],
        message: "Please name the workflow you would improve first.",
      });
    }
    if (
      value.kind !== "ai_os" &&
      (!value.problemSummary || value.problemSummary.length < 20)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["problemSummary"],
        message: "Please share at least 20 characters of useful context.",
      });
    }
    if ((value.whatsapp || value.calls) && !value.phoneE164) {
      ctx.addIssue({
        code: "custom",
        path: ["phoneE164"],
        message: "Add a phone number before opting into WhatsApp or calls.",
      });
    }
  });

function toBoolean(value: FormDataEntryValue | null) {
  return value === "on" || value === "true";
}

export async function submitLead(
  kind: LeadSubmissionKind,
  sourceRoute: string,
  audiencePath: string,
  _previous: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const requestId = randomUUID();
  const parsed = leadSchema.safeParse({
    kind,
    idempotencyKey: formData.get("idempotencyKey"),
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    positionTitle: formData.get("positionTitle"),
    companyName: formData.get("companyName"),
    countryCode: formData.get("countryCode"),
    phoneE164: formData.get("phoneE164"),
    problemSummary: formData.get("problemSummary"),
    desiredOutcome: formData.get("desiredOutcome"),
    timing: formData.get("timing"),
    teamSize: formData.get("teamSize") ?? null,
    deliveryPreference: formData.get("deliveryPreference") ?? null,
    aiUseLevel: formData.get("aiUseLevel") ?? null,
    workflowToImprove: formData.get("workflowToImprove"),
    // Provenance is bound by the server-rendered component/action closure,
    // not trusted from hidden browser fields.
    sourceRoute,
    audiencePath,
    privacyAcknowledged: toBoolean(formData.get("privacyAcknowledged")),
    researchAccepted: toBoolean(formData.get("researchAccepted")),
    emailMarketing: toBoolean(formData.get("emailMarketing")),
    whatsapp: toBoolean(formData.get("whatsapp")),
    calls: toBoolean(formData.get("calls")),
    website: formData.get("website") ?? "",
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: "Some details need attention before sending.",
      requestId,
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  try {
    await createLeadSubmission({
      clientIpHash: await getRequestClientIpHash(),
      idempotencyKey: parsed.data.idempotencyKey,
      kind: parsed.data.kind,
      fullName: parsed.data.fullName,
      email: parsed.data.email,
      positionTitle: parsed.data.positionTitle,
      companyName: parsed.data.companyName,
      countryCode: parsed.data.countryCode,
      phoneE164: parsed.data.phoneE164,
      problemSummary: parsed.data.problemSummary,
      desiredOutcome: parsed.data.desiredOutcome,
      timing: parsed.data.timing,
      teamSize: parsed.data.teamSize,
      deliveryPreference: parsed.data.deliveryPreference,
      aiUseLevel: parsed.data.aiUseLevel,
      workflowToImprove: parsed.data.workflowToImprove,
      sourceRoute: parsed.data.sourceRoute,
      audiencePath: parsed.data.audiencePath,
      privacyAcknowledged: parsed.data.privacyAcknowledged,
      researchAccepted: parsed.data.researchAccepted,
      emailMarketing: parsed.data.emailMarketing,
      whatsapp: parsed.data.whatsapp,
      calls: parsed.data.calls,
      now: new Date(),
    });

    return {
      ok: true,
      message:
        "Your request has been saved securely. Ahmed can review the context from the Decoded Hiring business inbox as that admin surface comes online.",
    };
  } catch (error: unknown) {
    if (error instanceof LeadDomainError) {
      return {
        ok: false,
        message:
          error.code === "RATE_LIMITED"
            ? "Too many enquiry submissions were created in a short window. Please try again later."
            : "This submission identity is already bound to different enquiry details. Refresh the page before trying again.",
        requestId,
      };
    }

    return {
      ok: false,
      message:
        "Your request could not be saved safely. Please try again later.",
      requestId,
    };
  }
}
