import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { LearnerShell } from "@/components/learner/learner-shell";
import "./classroom.css";

// Authenticated classroom: always render per request, never prerender statically.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Classroom | Decoded Hiring",
  description: "Your Decoded Hiring courses — continue learning where you left off.",
};

export default async function LearnLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session?.user) {
    redirect("/login?redirect=/learn");
  }

  return (
    <>
      <LearnerShell userName={session.user.name || "Learner"}>{children}</LearnerShell>
    </>
  );
}
