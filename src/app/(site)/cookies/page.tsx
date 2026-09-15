import { LegalPage } from "@/components/site/legal-page";
import { publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata({
  title: "Cookie and Analytics Notice | Decoded Hiring",
  description:
    "How Decoded Hiring uses essential storage and consent-gated product analytics.",
  path: "/cookies",
});

export default function CookiesPage() {
  return (
    <LegalPage
      title="Cookie and Analytics Notice"
      description="The service keeps essential access working and starts optional analytics only after your choice."
      path="/cookies"
    >
      <section>
        <h2>Essential storage</h2>
        <p>
          Authentication and security storage is required to sign you in, keep
          the private classroom secure, remember your session and protect forms.
          It cannot be disabled through the site while using account features.
        </p>
      </section>
      <section>
        <h2>Optional analytics</h2>
        <p>
          PostHog product analytics initializes only after analytics consent.
          Events use an internal or pseudonymous identifier and do not include
          your email, phone, inquiry text, quiz answers or practical
          submissions. Session replay is disabled.
        </p>
      </section>
      <section>
        <h2>Changing your choice</h2>
        <p>
          You can change the analytics choice from your account privacy
          settings. Withdrawing consent stops future optional capture; it does
          not affect essential authentication or security processing.
        </p>
      </section>
      <section>
        <h2>Embedded services</h2>
        <p>
          Course videos use a click-to-load YouTube privacy-enhanced embed. No
          video frame is loaded until you choose to play it, at which point
          Google&apos;s service terms and storage may apply.
        </p>
      </section>
    </LegalPage>
  );
}
