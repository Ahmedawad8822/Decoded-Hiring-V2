import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { LearnerShell } from "@/components/learner/learner-shell";

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
      <link rel="stylesheet" href="/prototypes/tokens.css" />
      <link rel="stylesheet" href="/prototypes/base.css" />
      <link rel="stylesheet" href="/prototypes/components.css" />
      <LearnerShell userName={session.user.name || "Learner"}>{children}</LearnerShell>
    </>
  );
}
