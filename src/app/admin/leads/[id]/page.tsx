import { Card, PageHeader, humanLabel } from "../../_ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth";
import { getLead } from "@/features/leads/admin";
import { LeadActions } from "./lead-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lead · Studio | Decoded Hiring",
  description: "Lead submission detail.",
  robots: { index: false, follow: false },
};

function show(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function ts(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export default async function AdminLeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminPage();
  const { id } = await params;
  const lead = await getLead(id);
  if (!lead) notFound();

  const fields: Array<[string, string | number | boolean | null]> = [
    ["Kind", humanLabel(lead.kind)],
    ["Status", humanLabel(lead.status)],
    ["Full name", lead.fullName],
    ["Email", lead.email],
    ["Phone", lead.phoneE164],
    ["Position", lead.positionTitle],
    ["Company", lead.companyName],
    ["Country", lead.countryCode],
    ["Problem summary", lead.problemSummary],
    ["Desired outcome", lead.desiredOutcome],
    ["Timing", lead.timing],
    ["Team size", lead.teamSize],
    ["Delivery preference", lead.deliveryPreference],
    ["AI use level", lead.aiUseLevel],
    ["Workflow to improve", lead.workflowToImprove],
    ["Source route", lead.sourceRoute],
    ["Audience path", lead.audiencePath],
    ["Privacy acknowledged", lead.privacyAcknowledged],
    ["Research accepted", lead.researchAccepted],
    ["Email marketing", lead.emailMarketing],
    ["WhatsApp", lead.whatsapp],
    ["Calls", lead.calls],
    ["Created (UTC)", ts(lead.createdAt)],
    ["Updated (UTC)", ts(lead.updatedAt)],
    ["Idempotency key", lead.idempotencyKey],
  ];

  return (
    <div >
      <p className="s-margin-bottom-8" >
        <Link href="/admin/leads">← Back to leads</Link>
      </p>
      <PageHeader eyebrow="Leads" title={`Lead: ${lead.fullName}`} description="Contact details, context, and consent in one place." />

      <div className="s-margin-bottom-20" >
        <LeadActions id={lead.id} status={lead.status} />
      </div>

      <Card><dl className="s-stack s-definition-grid s-gap-8px-24px" >
        {fields.map(([label, value]) => (
          <div className="s-contents" key={label} >
            <dt className="s-muted" >{label}</dt>
            <dd className="s-margin-0 s-white-space-pre-wrap s-overflow-wrap-anywhere" >{show(value)}</dd>
          </div>
        ))}
      </dl></Card>
    </div>
  );
}
