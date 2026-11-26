import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getAdminLandingPageBySlug, resolveTargetSummary } from "@/features/landing-pages/service";
import { requireAdminPage } from "@/lib/auth";

// Staff preview of a landing page in any status. Reached via the rewrite in
// next.config.ts from /go/<slug>?preview=true (the browser URL does not
// change). Dynamic by design: it reads the session, requireAdminPage redirects
// anyone who is not an admin to /admin/login, and it is never cached or
// indexed.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function PreviewLandingPage(props: PageProps) {
  await requireAdminPage();
  const { slug } = await props.params;
  const page = await getAdminLandingPageBySlug(slug);
  if (!page) notFound();
  const target = await resolveTargetSummary(page);

  return (
    <div className="wrap" style={{ paddingBlock: "32px", maxWidth: "720px" }}>
      <aside
        role="status"
        style={{
          background: "#fff3cd",
          borderBottom: "1px solid #ffeeba",
          color: "#856404",
          padding: "10px 20px",
          textAlign: "center",
          fontSize: "13px",
          fontWeight: 600,
        }}
      >
        PREVIEW MODE · This landing page is currently {page.status.toUpperCase()}
        {page.trashedAt ? " and in TRASH" : ""} and is not publicly discoverable.
      </aside>
      <p className="hg-kicker">{page.campaignName}</p>
      <h1>{page.title}</h1>
      <p>
        Target: {page.targetKind} · CTA: {page.ctaLabel} · Slug: /go/{page.slug}
      </p>
      {target && (
        <p>
          Target summary: {target.title} → {target.href}
        </p>
      )}
      <p>
        <a className="hg-primary" href={`/go/${page.slug}`}>
          Open the public page
        </a>
      </p>
    </div>
  );
}
