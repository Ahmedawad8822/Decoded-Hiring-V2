import { LegalPage } from "@/components/site/legal-page";
import { publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata({
  title: "Terms of Use | Decoded Hiring",
  description:
    "The current terms for using Decoded Hiring's public resources and private free classroom.",
  path: "/terms",
});

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Use"
      description="The practical rules for using this site, its free learning experience and its original materials."
      path="/terms"
    >
      <section>
        <h2>Current service boundary</h2>
        <p>
          Decoded Hiring currently provides public educational content, a free
          private classroom and ways to express interest or start a
          conversation. No checkout or paid-course purchase is offered in this
          version.
        </p>
      </section>
      <section>
        <h2>Your account</h2>
        <p>
          Keep access to your account secure and provide accurate information.
          Do not share access, automate abuse, attempt to reach another
          learner&apos;s data or interfere with the service. Access may be
          restricted when necessary to protect learners or the platform.
        </p>
      </section>
      <section>
        <h2>Learning content and intellectual property</h2>
        <p>
          Course content, frameworks, diagrams and original resources remain the
          intellectual property of Ahmed Awad unless another source is clearly
          identified. You may use downloaded working files for your own
          professional learning. You may not resell, republish or present the
          material as your own.
        </p>
      </section>
      <section>
        <h2>Professional judgment</h2>
        <p>
          The material is educational and does not replace legal, employment,
          data-protection or business advice. You remain responsible for hiring
          decisions, candidate treatment, bias review and compliance in your
          organization and country.
        </p>
      </section>
      <section>
        <h2>Discussions and submitted work</h2>
        <p>
          Do not submit candidate personal data, confidential employer material
          or content you do not have permission to share. Classroom discussion
          may be visible to other enrolled learners and can be moderated to keep
          the environment safe and useful.
        </p>
      </section>
      <section>
        <h2>Availability and changes</h2>
        <p>
          Features may change while the service develops. Reasonable care is
          taken to protect progress and access, but uninterrupted availability
          is not guaranteed. Material changes to these terms will be dated here.
        </p>
      </section>
    </LegalPage>
  );
}
