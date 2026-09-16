import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";

// (site) group owns the public editorial visual language: the V1-restored
// master/content styles plus the PUB component layer (extracted from the
// former root-level studio-tokens.css). Other route groups load their own.
import "../master-design.css";
import "../content-design.css";
import "./site.css";

export default function SiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div id="hg-master-draft" className="hg-shell" data-lang="en">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main-content">{children}</main>
      <SiteFooter />
    </div>
  );
}
