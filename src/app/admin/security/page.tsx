import { requireAdminPage, isAdmin2faRequired } from "@/lib/auth";
import { SecurityClient } from "./security-client";

export const metadata = {
  title: "Security · Studio | Decoded Hiring",
  description: "Two-factor authentication for Studio admins.",
};

export default async function AdminSecurityPage() {
  // The one admin page an admin without 2FA may open (G3): it is where they enroll.
  const session = await requireAdminPage({ allowWithout2fa: true });
  const enabled =
    (session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled === true;
  return <SecurityClient enabled={enabled} required={isAdmin2faRequired()} email={session.user.email} />;
}
