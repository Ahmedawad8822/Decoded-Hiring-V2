import type { Metadata } from "next";

// Auth surface: never indexed (remediation B.3). The page itself is a client
// component, so the metadata lives on this server layout.
export const metadata: Metadata = {
  title: "Sign in | Decoded Hiring",
  robots: { index: false, follow: false },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
