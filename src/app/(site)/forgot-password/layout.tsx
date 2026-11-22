import type { Metadata } from "next";

// Auth-recovery surface: never indexed. The page is a client component, so
// the metadata lives on this server layout (same as /login and /signup).
export const metadata: Metadata = {
  title: "Forgot password | Decoded Hiring",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
