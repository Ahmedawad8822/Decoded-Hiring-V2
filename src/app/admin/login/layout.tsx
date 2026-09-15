import type { Metadata } from "next";

// Auth surface: never indexed (remediation B.3). The page itself is a client
// component, so the metadata lives on this server layout. The admin group
// layout already sets noindex for the studio; this keeps it explicit on the
// login route too.
export const metadata: Metadata = {
  title: "Studio sign-in | Decoded Hiring",
  robots: { index: false, follow: false },
};

export default function AdminLoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
