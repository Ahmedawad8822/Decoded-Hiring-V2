import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Unified V2 Review Hub | Decoded Hiring",
  description:
    "Single review hub for both the restored V1 public website (Mission 03) and the approved V2 product prototypes (Mission 02D).",
};

interface ReviewLink {
  href: string;
  id?: string;
  badge?: string;
  title: string;
  description: string;
}

interface ReviewSection {
  id: string;
  groupLabel: string;
  subtitle: string;
  links: ReviewLink[];
}

const SECTIONS: ReviewSection[] = [
  {
    id: "group-1-public",
    groupLabel: "PUBLIC WEBSITE · RESTORED FROM V1 — MISSION 03",
    subtitle:
      "Native Next.js application routes ported from V1 with legacy backend dependencies decoupled. Fully functional with real CSS and components.",
    links: [
      {
        href: "/",
        id: "PUB-01",
        badge: "Route /",
        title: "Home",
        description:
          "Positioning hero, dynamic Situation Map, 5-stage strategy process, offering paths, and newsletter subscription.",
      },
      {
        href: "/programmes",
        id: "PUB-02",
        badge: "Route /programmes",
        title: "Programmes",
        description:
          "All three delivery formats: Mission 01 free classroom, 4-day team workshop, and 1:1 executive coaching.",
      },
      {
        href: "/mission-01",
        id: "PUB-03",
        badge: "Route /mission-01",
        title: "Mission 01",
        description:
          "Free online recruiting course with 5 core modules, role brief framework, and instant enrollment flow.",
      },
      {
        href: "/workshop",
        id: "PUB-04",
        badge: "Route /workshop",
        title: "Workshop",
        description:
          "Four-day hands-on team programme, 7-stage OS architecture, full curriculum breakdown, and discovery booking.",
      },
      {
        href: "/coaching",
        id: "PUB-05",
        badge: "Route /coaching",
        title: "Coaching",
        description:
          "Symptom diagnostic board, working session canvas, and direct scheduling application.",
      },
      {
        href: "/about",
        id: "PUB-06",
        badge: "Route /about",
        title: "About",
        description:
          "Founder background, editorial manifesto, and the principles behind Decoded Hiring.",
      },
      {
        href: "/contact",
        id: "PUB-07",
        badge: "Route /contact",
        title: "Contact",
        description:
          "Consultation enquiry form with qualification fields, budget tier selection, and validation.",
      },
      {
        href: "/ai-recruiter-os",
        id: "PUB-08",
        badge: "Route /ai-recruiter-os",
        title: "AI Recruiter OS",
        description:
          "AI transformation overview for corporate recruitment teams and agency founders.",
      },
      {
        href: "/privacy",
        id: "LEGAL-01",
        badge: "Route /privacy",
        title: "Privacy",
        description:
          "Data privacy declaration, GDPR compliance, cookie transparency, and retention policy.",
      },
      {
        href: "/terms",
        id: "LEGAL-02",
        badge: "Route /terms",
        title: "Terms",
        description:
          "Enrollment terms, IP rights, cancellation rules, and commercial agreements.",
      },
      {
        href: "/cookies",
        id: "LEGAL-03",
        badge: "Route /cookies",
        title: "Cookies",
        description:
          "Categorized cookie audit, consent management rules, and tracking definitions.",
      },
      {
        href: "/guides",
        id: "PUB-04-IDX",
        badge: "Real Route /guides",
        title: "Guides Index (Production)",
        description:
          "Live database-driven guides index listing published guides with category tagging and responsive editorial grid.",
      },
      {
        href: "/guides/talent-acquisition-strategy",
        id: "PUB-04-REAL",
        badge: "Real Route /guides/[slug]",
        title: "Guide: Talent Acquisition Strategy (Production)",
        description:
          "Real published guide served from D1 SQLite via Drizzle. Includes 2-column sticky TOC rail, semantic list bullet hardening, and Article SEO schema.",
      },
      {
        href: "/prototypes/public/guide.html",
        id: "PUB-04g",
        badge: "Guide Prototype",
        title: "Guide: Talent Acquisition Strategy (Prototype)",
        description:
          "Full editorial guide prototype with responsive 2-column sticky TOC layout, stabilized lists, pull-quotes, evidence tables, and cluster strip.",
      },
    ],
  },
  {
    id: "group-2-admin",
    groupLabel: "GROUP 2 — ADMIN / COMMAND CENTER",
    subtitle:
      "Operational calm, product-centered architecture, ≤2 levels deep. Fully approved 02D remediation screens served statically by this server.",
    links: [
      {
        href: "/prototypes/studio/command.html",
        id: "STU-01",
        badge: "Admin",
        title: "Command Center",
        description:
          "The five core operational questions answered before showing raw metrics. Prioritized agent recommendations with evidence.",
      },
      {
        href: "/prototypes/studio/approvals.html",
        id: "STU-02",
        badge: "Admin",
        title: "Approvals Queue",
        description:
          "Unified decision queue for pending bookings, editorial drafts, and high-risk actions. Mandatory rejection rationale.",
      },
      {
        href: "/prototypes/studio/content.html",
        id: "STU-03/04",
        badge: "Admin",
        title: "Content",
        description:
          "Single surface for both list overview and block-based editorial composition. Includes SEO panel and revision history.",
      },
      {
        href: "/prototypes/studio/curriculum.html",
        id: "STU-12",
        badge: "Admin",
        title: "Curriculum / Course Management",
        description:
          "Section and lesson management, drag-and-drop ordering, required flags, and enrollment-guarded deletion.",
      },
      {
        href: "/prototypes/studio/products.html",
        id: "STU-13..15",
        badge: "Admin",
        title: "Products",
        description:
          "Catalog of all 4 offerings with live Access Mode switching (Free, Paid, Paid Session, Manual Invoice, Disabled).",
      },
      {
        href: "/prototypes/studio/bookings.html",
        id: "STU-18",
        badge: "Admin",
        title: "Bookings",
        description:
          "Live hold countdown timers, policy enforcement per appointment type, and full operational audit trails.",
      },
      {
        href: "/prototypes/studio/settings.html",
        id: "STU-28",
        badge: "Admin",
        title: "Settings",
        description:
          "Grouped by consequence, write-only credential storage, permission-denied state demo, and typed destructive confirm.",
      },
      {
        href: "/prototypes/studio/enquiries.html",
        id: "STU-17",
        badge: "Admin",
        title: "Enquiries",
        description:
          "Follow-up state progression, UTM/source tracking, and empty state designed to guide operator action.",
      },
      {
        href: "/prototypes/studio/students.html",
        id: "STU-16",
        badge: "Admin",
        title: "Students",
        description:
          "Learner progress tracking, order history, and manual enrollment grant with required audit reason.",
      },
      {
        href: "/prototypes/studio/courses.html",
        id: "STU-11",
        badge: "Admin",
        title: "Courses",
        description:
          "Published, pilot, and draft course statuses with direct links to curriculum, products, and sales pages.",
      },
      {
        href: "/prototypes/studio/intelligence.html",
        id: "STU-23/24",
        badge: "Admin",
        title: "Intelligence & Error States",
        description:
          "Organic discovery clusters, AI query referrals, skeleton loading states, and honest error handling demo.",
      },
      {
        href: "/prototypes/studio/editorial.html",
        id: "STU-25/26",
        badge: "Admin",
        title: "AI Content Studio",
        description:
          "J8 autonomous loop visible, draft generation with full provenance, editorial calendar, and source library.",
      },
      {
        href: "/prototypes/studio/reliability.html",
        id: "STU-27",
        badge: "Admin",
        title: "Reliability",
        description:
          "J9 incident post-mortem trail, agent autonomy guardrail policies, and continuous improvement backlog.",
      },
      {
        href: "/admin/content",
        id: "STU-03-REAL",
        badge: "Real Route /admin/content",
        title: "Content & Guide Management (Production)",
        description:
          "Real working application flow: list existing guides, create new, edit, save draft, live preview, publish, unpublish, and archive with D1 persistence.",
      },
      {
        href: "/admin/login",
        id: "STU-30-REAL",
        badge: "Real Route /admin/login",
        title: "Studio Sign-In (Production Better Auth)",
        description:
          "Real staff authentication using Better Auth with persistent sessions, secure cookies, and admin role authorization.",
      },
      {
        href: "/prototypes/studio/login.html",
        id: "STU-30",
        badge: "Admin Prototype",
        title: "Studio Sign-In (Prototype)",
        description:
          "Passkey and 2FA authentication door separate from the public learner gateway.",
      },
    ],
  },
  {
    id: "group-3-learner",
    groupLabel: "GROUP 3 — LEARNER",
    subtitle:
      "Student classroom experience, distraction-free reading, and appointment management.",
    links: [
      {
        href: "/prototypes/learner/home.html",
        id: "LRN-01",
        badge: "Learner",
        title: "Learner Home",
        description:
          "Personalized learner dashboard with active course progress and quick-resume shortcuts.",
      },
      {
        href: "/prototypes/learner/courses.html",
        id: "LRN-02",
        badge: "Learner",
        title: "Courses",
        description:
          "Catalog of enrolled and available courses with clear completion statuses.",
      },
      {
        href: "/prototypes/learner/lesson.html",
        id: "LRN-03",
        badge: "Learner",
        title: "Lesson",
        description:
          "Distraction-free classroom environment with curriculum slide-out drawer and progress marking.",
      },
      {
        href: "/prototypes/learner/account.html",
        id: "LRN-05",
        badge: "Learner",
        title: "Account",
        description:
          "Profile information, learning preferences, email notifications, and security.",
      },
      {
        href: "/prototypes/learner/bookings.html",
        id: "LRN-06",
        badge: "Learner",
        title: "Bookings",
        description:
          "Upcoming scheduled sessions with direct access to meeting links, reschedule, and cancellation.",
      },
    ],
  },
  {
    id: "group-4-commerce",
    groupLabel: "GROUP 4 — COMMERCE",
    subtitle:
      "Provider-neutral checkout state machine and Access Mode CTA interactions.",
    links: [
      {
        href: "/prototypes/commerce/checkout.html",
        id: "COM-06",
        badge: "State: Available",
        title: "Checkout",
        description:
          "Standard initial payment entry form with order summary and provider-agnostic inputs.",
      },
      {
        href: "/prototypes/commerce/checkout.html?state=pending",
        id: "COM-07",
        badge: "State: Pending",
        title: "Pending",
        description:
          "Payment processing state with server-truth verification and synchronized booking hold notes.",
      },
      {
        href: "/prototypes/commerce/checkout.html?state=success",
        id: "COM-08",
        badge: "State: Success",
        title: "Success",
        description:
          "Idempotent grant confirmation with enrollment receipt and direct gateway into the course.",
      },
      {
        href: "/prototypes/commerce/checkout.html?state=failure",
        id: "COM-09",
        badge: "State: Failure",
        title: "Failure",
        description:
          "Specific decline reason class, card retry path, and graceful fallback to manual invoice.",
      },
      {
        href: "/prototypes/commerce/checkout.html?state=manual",
        id: "COM-09m",
        badge: "State: Manual",
        title: "Manual / Invoice",
        description:
          "Manual order submission where Ahmed reviews personally and records completion before access is granted.",
      },
      {
        href: "/prototypes/public/course.html#lab-h",
        id: "COM-01..04",
        badge: "Interactive Lab",
        title: "Course CTA State Machine Lab",
        description:
          "Live interactive switcher testing all 5 Access Modes (Free, Paid, Paid Session, Manual, Disabled) on a real sales page.",
      },
    ],
  },
  {
    id: "group-5-scheduling",
    groupLabel: "GROUP 5 — SCHEDULING",
    subtitle:
      "Timezone-honest scheduling with atomic holds, approval gates, and policy-governed reschedule.",
    links: [
      {
        href: "/prototypes/scheduling/booking.html",
        id: "SCH-01..05",
        badge: "Wizard",
        title: "Coaching Booking",
        description:
          "Five-step booking flow with live countdown timer, timezone detection, and intake questionnaire.",
      },
      {
        href: "/prototypes/scheduling/discovery.html",
        id: "SCH-06",
        badge: "Discovery",
        title: "Workshop Discovery Booking",
        description:
          "Team qualification form and calendar picker for corporate workshop intake sessions.",
      },
      {
        href: "/prototypes/scheduling/confirmed.html",
        id: "SCH-07",
        badge: "Confirmed",
        title: "Confirmation",
        description:
          "Calendar invite generation, preparation checklist, and appointment management links.",
      },
      {
        href: "/prototypes/studio/bookings.html",
        id: "SCH-08",
        badge: "Pending",
        title: "Approval / Pending",
        description:
          "Approval pending queue displaying live holding countdown timer and decision audit trail.",
      },
      {
        href: "/prototypes/scheduling/reschedule.html",
        id: "SCH-09",
        badge: "Reschedule",
        title: "Reschedule",
        description:
          "Policy window check (e.g. 24h rule) and slot replacement without losing booking context.",
      },
      {
        href: "/prototypes/scheduling/reschedule.html#cancel",
        id: "SCH-10",
        badge: "Cancellation",
        title: "Cancellation",
        description:
          "Structured cancellation flow with consequence summary, fee explanation, and audit trail.",
      },
    ],
  },
];

export default function ReviewHubPage() {
  return (
    <div className="review-hub-page">
      <style>{`
        .review-hub-page {
          max-width: 1240px;
          margin: 0 auto;
          padding: 3rem 1.5rem 6rem;
          font-family: var(--sans, sans-serif);
          color: var(--ink, #1e211f);
        }

        .rh-hero {
          border-bottom: 1px solid var(--line, rgba(30, 33, 31, 0.18));
          padding-bottom: 2.5rem;
          margin-bottom: 3rem;
        }

        .rh-eyebrow {
          display: inline-block;
          font-family: var(--mono, monospace);
          font-size: 0.75rem;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--blue, #285ee8);
          background: var(--blue-soft, #dfe7ff);
          padding: 0.25rem 0.6rem;
          border-radius: 9999px;
          margin-bottom: 1rem;
          font-weight: 600;
        }

        .rh-title {
          font-family: var(--display, Georgia, serif);
          font-size: clamp(2rem, 4vw, 3rem);
          font-weight: 400;
          line-height: 1.15;
          margin: 0 0 1rem;
          letter-spacing: -0.01em;
        }

        .rh-lead {
          font-size: 1.125rem;
          line-height: 1.6;
          color: var(--muted, #686a64);
          max-width: 52rem;
          margin: 0 0 1.5rem;
        }

        .rh-quick-stats {
          display: flex;
          flex-wrap: wrap;
          gap: 0.75rem;
          align-items: center;
        }

        .rh-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.8125rem;
          font-family: var(--mono, monospace);
          background: var(--paper-bright, #fffdf8);
          border: 1px solid var(--line, rgba(30, 33, 31, 0.18));
          padding: 0.35rem 0.75rem;
          border-radius: 6px;
        }

        .rh-pill-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #22c55e;
        }

        .rh-group-section {
          margin-bottom: 3.5rem;
        }

        .rh-group-header {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          margin-bottom: 1.5rem;
          padding-bottom: 0.75rem;
          border-bottom: 1px solid var(--line, rgba(30, 33, 31, 0.18));
        }

        .rh-group-title {
          font-family: var(--mono, monospace);
          font-size: 0.8125rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--ink, #1e211f);
          margin: 0;
        }

        .rh-group-subtitle {
          font-size: 0.9375rem;
          color: var(--muted, #686a64);
          margin: 0;
          line-height: 1.5;
        }

        .rh-cards-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 1.25rem;
        }

        .rh-card {
          display: flex;
          flex-direction: column;
          background: var(--paper-bright, #fffdf8);
          border: 1px solid var(--line, rgba(30, 33, 31, 0.18));
          border-radius: 12px;
          padding: 1.25rem;
          text-decoration: none;
          color: inherit;
          transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
        }

        .rh-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 18px rgba(30, 33, 31, 0.06);
          border-color: var(--blue, #285ee8);
        }

        .rh-card-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.75rem;
          gap: 0.5rem;
        }

        .rh-card-id {
          font-family: var(--mono, monospace);
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--blue, #285ee8);
          letter-spacing: 0.04em;
        }

        .rh-card-badge {
          font-family: var(--mono, monospace);
          font-size: 0.6875rem;
          padding: 0.2rem 0.5rem;
          border-radius: 4px;
          background: rgba(30, 33, 31, 0.06);
          color: var(--muted, #686a64);
          font-weight: 500;
        }

        .rh-card-title {
          font-size: 1.0625rem;
          font-weight: 600;
          margin: 0 0 0.5rem;
          color: var(--ink, #1e211f);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .rh-arrow {
          color: var(--blue, #285ee8);
          transition: transform 0.15s ease;
          font-size: 1.125rem;
        }

        .rh-card:hover .rh-arrow {
          transform: translateX(3px);
        }

        .rh-card-desc {
          font-size: 0.875rem;
          color: var(--muted, #686a64);
          line-height: 1.5;
          margin: 0 0 1rem;
          flex-grow: 1;
        }

        .rh-card-url {
          font-family: var(--mono, monospace);
          font-size: 0.75rem;
          color: var(--blue, #285ee8);
          word-break: break-all;
          border-top: 1px dashed rgba(30, 33, 31, 0.12);
          padding-top: 0.6rem;
        }

        .rh-footer-note {
          background: var(--paper-bright, #fffdf8);
          border: 1px solid var(--line, rgba(30, 33, 31, 0.18));
          border-radius: 12px;
          padding: 1.5rem;
          margin-top: 4rem;
          display: flex;
          flex-wrap: wrap;
          justify-content: space-between;
          align-items: center;
          gap: 1rem;
        }

        .rh-footer-links {
          display: flex;
          gap: 1rem;
          flex-wrap: wrap;
        }

        .rh-btn-outline {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.5rem 1rem;
          border: 1px solid var(--line, rgba(30, 33, 31, 0.18));
          border-radius: 8px;
          text-decoration: none;
          color: var(--ink, #1e211f);
          font-size: 0.875rem;
          font-weight: 500;
          background: #ffffff;
        }

        .rh-btn-outline:hover {
          border-color: var(--ink, #1e211f);
        }
      `}</style>

      {/* HERO */}
      <header className="rh-hero">
        <span className="rh-eyebrow">ONE APPLICATION · ONE SERVER · ONE HUB</span>
        <h1 className="rh-title">Decoded Hiring V2 — Unified Review Hub</h1>
        <p className="rh-lead">
          Review both the restored V1 public website (Mission 03) and the approved V2 product
          prototypes (Mission 02D) through a single Next.js local server. No secondary Python
          servers or manual port juggling required.
        </p>
        <div className="rh-quick-stats">
          <span className="rh-pill">
            <span className="rh-pill-dot"></span>
            Server: Single Next.js Dev Instance
          </span>
          <span className="rh-pill">Route: /review</span>
          <span className="rh-pill">11 Public Pages + 24 Prototype Screens</span>
          <Link
            href="/prototypes/index.html"
            className="rh-pill"
            style={{ color: "var(--blue, #285ee8)", textDecoration: "none" }}
          >
            Prototype Pack Spec (02B Index) ↗
          </Link>
        </div>
      </header>

      {/* SECTIONS */}
      {SECTIONS.map((section) => (
        <section
          key={section.id}
          id={section.id}
          className="rh-group-section"
          aria-labelledby={`${section.id}-heading`}
        >
          <div className="rh-group-header">
            <h2 id={`${section.id}-heading`} className="rh-group-title">
              {section.groupLabel}
            </h2>
            <p className="rh-group-subtitle">{section.subtitle}</p>
          </div>

          <div className="rh-cards-grid">
            {section.links.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="rh-card"
                title={`Open ${item.title}`}
              >
                <div className="rh-card-top">
                  {item.id && <span className="rh-card-id">{item.id}</span>}
                  {item.badge && <span className="rh-card-badge">{item.badge}</span>}
                </div>
                <div className="rh-card-title">
                  <span>{item.title}</span>
                  <span className="rh-arrow" aria-hidden="true">
                    →
                  </span>
                </div>
                <p className="rh-card-desc">{item.description}</p>
                <span className="rh-card-url">{item.href}</span>
              </a>
            ))}
          </div>
        </section>
      ))}

      {/* FOOTER CALLOUT */}
      <aside className="rh-footer-note">
        <div>
          <strong>Unified Local Server Operational Notice:</strong>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted, #686a64)", fontSize: "0.875rem" }}>
            All static prototype assets are served natively from{" "}
            <code style={{ fontFamily: "var(--mono, monospace)" }}>/prototypes/...</code> through Next.js.
          </p>
        </div>
        <div className="rh-footer-links">
          <Link href="/" className="rh-btn-outline">
            Open Public Site (/)
          </Link>
          <a href="/prototypes/studio/command.html" className="rh-btn-outline">
            Open Command Center
          </a>
        </div>
      </aside>
    </div>
  );
}
