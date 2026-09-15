import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { getAllAdminGuides } from "@/features/guides/service";
import { GuideManagerClient } from "./guide-manager-client";

export const metadata = {
  title: "Content · Studio | Decoded Hiring",
  description: "Real Guide publishing management.",
};

export default async function AdminContentPage() {
  const session = await getServerSession();

  // Server-side authorization gate per Domain 1
  if (!session?.user) {
    redirect("/admin/login");
  }

  const role = (session.user as { role?: string }).role;
  if (role !== "admin") {
    redirect("/admin/login?error=forbidden");
  }

  const guides = await getAllAdminGuides();

  return <GuideManagerClient initialGuides={guides} currentUser={session.user} />;
}
