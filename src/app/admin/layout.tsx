import React from "react";
import { checkAdmin, getServerSession } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { readStudioAttention } from "./_ui/attention-data";
import { AdminStudioShell } from "./studio-shell";

// Studio styles are scoped to its shell; public pages keep their own visual layer.
import "./admin.css";

// All Studio admin routes are auth-gated and resolve a live D1 session
// server-side. force-dynamic at the layout level skips SSG for the entire
// subtree, so the 9 parallel prerender workers never spin up Miniflare
// (which caused SQLITE_BUSY_RECOVERY on the shared local D1 SQLite file) and
// never require BETTER_AUTH_SECRET at build time.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Studio · Content | Decoded Hiring",
  description: "Decoded Hiring V2 Content and Guide management.",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  // Navigation counts are optional chrome. The existing page gates still own
  // redirects, including the login and pre-enrollment security routes.
  let mayReadAttention = false;
  try { checkAdmin(session); mayReadAttention = true; }
  catch (error) { if (!(error instanceof AppError)) throw error; }
  const attention = mayReadAttention ? await readStudioAttention().then(({ leads, drafts, commerce }) => ({ leads: leads.total, drafts: drafts.length, bookings: commerce.summary.approvalQueue })) : undefined;
  return (
    <div className="env-studio">
      <AdminStudioShell user={session?.user} attention={attention}>{children}</AdminStudioShell>
    </div>
  );
}
