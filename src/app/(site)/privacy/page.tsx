import { LegalPage } from "@/components/site/legal-page";
import { publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata({
  title: "Privacy Notice | Decoded Hiring",
  description:
    "How Decoded Hiring collects, uses, protects and gives you control over personal data.",
  path: "/privacy",
});

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Notice"
      description="A plain-language account of what is collected, why it is needed and the choices you retain."
      path="/privacy"
    >
      <section>
        <h2>Who is responsible</h2>
        <p>
          Ahmed Awad operates Decoded Hiring and is responsible for the personal
          data described here. Privacy requests can be sent to
          support@decodedhiring.com.
        </p>
      </section>
      <section>
        <h2>What is collected</h2>
        <p>
          Depending on what you use, this may include account identity, name,
          work email, role, company, country, optional phone number, your chosen
          communication channel, inquiry details, course progress, practical
          submissions, quiz results, discussion activity and consent records.
          Security logs and privacy-safe product events may also be recorded.
        </p>
      </section>
      <section>
        <h2>Why it is used</h2>
        <ul>
          <li>Provide authentication, onboarding and the private classroom.</li>
          <li>
            Save progress, learning evidence and eligible completion records.
          </li>
          <li>
            Reply to an inquiry or deliver a specifically requested resource.
          </li>
          <li>Send marketing only where separate permission was given.</li>
          <li>Protect the service, prevent abuse and diagnose failures.</li>
          <li>
            Understand aggregate product use when analytics consent is active.
          </li>
        </ul>
      </section>
      <section>
        <h2>Phone, WhatsApp and marketing</h2>
        <p>
          Phone details are optional unless you explicitly choose WhatsApp or a
          call. Operational replies, marketing email and phone-based promotion
          are separate purposes with separate choices. You can withdraw an
          optional permission at any time without losing access to unrelated
          services.
        </p>
      </section>
      <section>
        <h2>Service providers and international processing</h2>
        <p>
          Decoded Hiring uses Vercel for hosting, Supabase for database and
          authentication, Brevo for transactional and consented email, PostHog
          for consent-gated analytics and error tracking, and Google/YouTube for
          sign-in, meetings and embedded course video. These providers may
          process data outside your country under their applicable safeguards.
        </p>
      </section>
      <section>
        <h2>Retention and control</h2>
        <p>
          Data is kept only while needed for the service, an active
          relationship, security, legal obligations or an evidenced consent.
          Final retention windows will be published before commercial launch.
          You may request access, correction or deletion, or object to optional
          processing, by emailing support@decodedhiring.com. Identity
          verification may be required before fulfilling a request.
        </p>
      </section>
      <section>
        <h2>Who the service is for</h2>
        <p>
          The current service is designed for recruitment professionals aged 18
          or older. It is not designed for children or for storing candidate
          personal data inside course discussions, inquiries or practical work.
        </p>
      </section>
    </LegalPage>
  );
}
