import type { Metadata } from "next";

import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { getSiteUrl, JsonLd, siteDescription, siteName } from "@/lib/seo";

import "./globals.css";
import "./master-design.css";
import "./content-design.css";

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  return {
    metadataBase: new URL(siteUrl),
    title: "Decoded Hiring | Recruitment strategy, systems and AI",
    description: siteDescription,
    openGraph: {
      title: "Decoded Hiring | Recruitment strategy, systems and AI",
      description: siteDescription,
      type: "website",
      locale: "en_US",
      siteName,
    },
  };
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" dir="ltr" data-scroll-behavior="smooth">
      <body>
        <JsonLd
          data={{
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: siteName,
            description: siteDescription,
            url: getSiteUrl().toString(),
            inLanguage: "en",
            author: {
              "@type": "Person",
              name: "Ahmed Awad",
              url: new URL("/about", getSiteUrl()).toString(),
            },
          }}
        />
        <div id="hg-master-draft" className="hg-shell" data-lang="en">
          <a className="skip-link" href="#main-content">
            Skip to content
          </a>
          <SiteHeader />
          <main id="main-content">{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
