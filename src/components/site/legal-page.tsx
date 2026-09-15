import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { breadcrumbSchema, JsonLd } from "@/lib/seo";

export function LegalPage({
  title,
  description,
  path,
  children,
  lastUpdated = "26 August 2026",
}: {
  title: string;
  description: string;
  path: string;
  children: React.ReactNode;
  lastUpdated?: string | null;
}) {
  return (
    <article className="hg-page is-active hg-authority-page">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: title, path },
        ])}
      />
      <header className="hg-section hg-legal-hero">
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: title }]} />
        <p className="hg-kicker">Decoded Hiring · trust centre</p>
        <h1 className="hg-display">{title}</h1>
        <p className="hg-body">{description}</p>
        {lastUpdated ? <small>Last updated: {lastUpdated}</small> : null}
      </header>
      <div className="hg-legal-body">{children}</div>
    </article>
  );
}
