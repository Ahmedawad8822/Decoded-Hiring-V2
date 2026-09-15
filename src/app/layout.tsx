import type { Metadata } from "next";

import { getSiteUrl, JsonLd, siteDescription, siteName } from "@/lib/seo";

// ROOT owns only the truly universal layer: V1 public reset/tokens
// (globals.css) and the shared token/base/primitive layer extracted from the
// former studio-tokens.css. Route-group styles load in their own layouts:
// (site) -> master-design + content-design + site.css; learn -> classroom.css;
// admin -> admin.css.
import "./globals.css";
import "./universal.css";

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
        {children}
      </body>
    </html>
  );
}
