import type { Metadata } from "next";

// Landing page for email-verification links: never indexed (same as /login).
export const metadata: Metadata = {
  title: "Email verification | Decoded Hiring",
  robots: { index: false, follow: false },
};

export default function EmailVerifiedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
