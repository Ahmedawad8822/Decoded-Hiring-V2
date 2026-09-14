import Link from "next/link";
import { ArrowUpRight, Bot, Building2, Network, Search } from "lucide-react";
import Image from "next/image";

import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { breadcrumbSchema, JsonLd, publicMetadata } from "@/lib/seo";

export const metadata = publicMetadata({
  path: "/about",
  title: "About Ahmed Awad | Decoded Hiring",
  description:
    "How twelve years across agency recruitment, in-house work and regional talent acquisition leadership shaped Ahmed Awad's recruitment systems.",
});

const chapters = [
  {
    number: "01",
    label: "Agency",
    title: "First, I learned to move.",
    copy: "Agency recruitment taught me that every search has commercial consequences. Pace matters, but only when the role, market and direction are clear.",
  },
  {
    number: "02",
    label: "In-house",
    title: "Then I learned what happens after the placement.",
    copy: "Inside the business, success is no longer a filled vacancy. Hiring decisions shape managers, team dynamics, delivery and what happens after the offer.",
  },
  {
    number: "03",
    label: "Regional leadership",
    title: "Leadership made inconsistency impossible to ignore.",
    copy: "At regional scale, individual skill is not enough. A talent function needs shared standards, visible trade-offs and a system that survives different markets and personalities.",
  },
  {
    number: "04",
    label: "Technology + AI",
    title: "Repetition hides inside every workflow.",
    copy: "Technology becomes useful when the professional can separate what should be automated, what needs review and what must remain a human judgment.",
  },
];

export default function AboutPage() {
  return (
    <article className="hg-page is-active hg-authority-page">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Person",
          name: "Ahmed Awad",
          url: "https://decodedhiring.com/about",
          image:
            "https://decodedhiring.com/images/ahmed-about-window-portrait.png",
          jobTitle: "Talent Acquisition and Staffing Professional",
          knowsAbout: [
            "Talent acquisition",
            "Recruitment strategy",
            "Recruitment technology",
            "Artificial intelligence in recruitment",
          ],
          sameAs: ["https://www.linkedin.com/in/ahmedawadrashidy/"],
        }}
      />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "About", path: "/about" },
        ])}
      />
      <section className="hg-section hg-authority-hero hg-about-hero">
        <div>
          <Breadcrumbs
            items={[{ label: "Home", href: "/" }, { label: "About" }]}
          />
          <p className="hg-kicker">The person behind the system</p>
          <h1 className="hg-display">
            I learned recruitment from both sides of the brief.
          </h1>
          <p className="hg-body">
            Agency work taught me speed, search and commercial pressure.
            In-house leadership taught me culture, politics and accountability
            after the offer. Twelve years later, I am still trying to make
            recruitment judgment more visible, teachable and useful.
          </p>
          <div className="hg-actions">
            <a className="hg-primary" href="#story">
              Explore the work <ArrowUpRight aria-hidden="true" />
            </a>
          </div>
        </div>
        <figure className="hg-authority-portrait hg-about-portrait">
          <Image
            src="/images/ahmed-about-window-portrait.png"
            alt="Ahmed Awad reflecting beside a window"
            fill
            priority
            sizes="(max-width: 800px) 100vw, 42vw"
          />
          <figcaption>Agency → in-house → regional leadership → AI</figcaption>
        </figure>
      </section>

      <section className="hg-section hg-about-thesis">
        <p className="hg-kicker">The operating thesis</p>
        <h2>Hiring gets better when the thinking becomes visible.</h2>
        <div className="hg-about-signal" aria-label="Ahmed's four perspectives">
          <span>
            <Search aria-hidden="true" /> Search
          </span>
          <span>
            <Building2 aria-hidden="true" /> Business
          </span>
          <span>
            <Network aria-hidden="true" /> Systems
          </span>
          <span>
            <Bot aria-hidden="true" /> Technology
          </span>
        </div>
      </section>

      <section className="hg-section hg-story" id="story">
        <p className="hg-kicker">Four chapters · one operating view</p>
        <h2 className="hg-title">
          The career changed. The question kept getting bigger.
        </h2>
        <div className="hg-story-list hg-story-track">
          {chapters.map((chapter) => (
            <article className="hg-story-row" key={chapter.number}>
              <span>{chapter.number}</span>
              <div>
                <small>{chapter.label}</small>
                <h3>{chapter.title}</h3>
              </div>
              <p>{chapter.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="hg-section hg-belief-panel">
        <p className="hg-kicker">The belief</p>
        <h2 className="hg-title">Intelligent and human are not opposites.</h2>
        <p className="hg-body">
          The best recruitment systems create more space for context,
          relationships and honest judgment. They do not remove accountability.
          They make it easier to see.
        </p>
        <div className="hg-actions">
          <Link className="hg-primary" href="/programmes">
            Choose your next move <ArrowUpRight aria-hidden="true" />
          </Link>
          <Link className="hg-secondary" href="/field-notes">
            Read Field Notes
          </Link>
        </div>
      </section>
    </article>
  );
}
