import { LeadForm } from "@/features/leads/lead-form";
import { Suspense } from "react";
import { publicMetadata } from "@/lib/seo";
import { ContactForm } from "./contact-form";

export const metadata = publicMetadata({
  path: "/contact",
  title: "Get in touch | Ahmed Awad",
  description:
    "Start a conversation about recruitment, the workshop, coaching or AI Recruiter OS.",
});

// Static: ?reason= is read client-side in <ContactForm> (useSearchParams inside
// Suspense), so this page shell prerenders. The fallback is the generic contact
// form, which is also what visitors without ?reason= get.
export default function ContactPage() {
  return (
    <article className="hg-page is-active">
      <section className="hg-section hg-form-stage">
        <p className="hg-kicker">Start with the real problem</p>
        <h1 className="hg-title">Tell me what you are trying to change.</h1>
        <p className="hg-body">
          Share the useful context. Ahmed will review it and reply with the
          most sensible next step.
        </p>
        <Suspense
          fallback={
            <LeadForm
              kind="contact"
              sourceRoute="/contact"
              audiencePath="general"
              submitLabel="Send the context"
            />
          }
        >
          <ContactForm />
        </Suspense>
      </section>
    </article>
  );
}
