import { LeadForm } from "@/features/leads/lead-form";
import type { LeadSubmissionKind } from "@/features/leads/types";
import { publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata({
  path: "/contact",
  title: "Get in touch | Ahmed Awad",
  description:
    "Start a conversation about recruitment, the workshop, coaching or AI Recruiter OS.",
});

const REASON_KINDS: Record<string, LeadSubmissionKind> = {
  coaching: "coaching",
  workshop: "workshop",
  "ai-recruiter-os": "ai_os",
};

export default async function ContactPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const query = await searchParams;
  const reason = query.reason ?? "general";
  const kind: LeadSubmissionKind = REASON_KINDS[reason] ?? "contact";

  return (
    <article className="hg-page is-active">
      <section className="hg-section hg-form-stage">
        <p className="hg-kicker">Start with the real problem</p>
        <h1 className="hg-title">Tell me what you are trying to change.</h1>
        <p className="hg-body">
          Share the useful context. Ahmed will review it and reply with the
          most sensible next step.
        </p>
        <LeadForm
          kind={kind}
          sourceRoute="/contact"
          audiencePath={reason}
          submitLabel="Send the context"
        />
      </section>
    </article>
  );
}
