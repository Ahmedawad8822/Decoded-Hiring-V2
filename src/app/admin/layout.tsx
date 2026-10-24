import React from "react";
import { AdminStudioShell } from "./studio-shell";

// admin group owns the Studio visual layer (STU components extracted from the
// former root-level studio-tokens.css). Universal tokens/base come from root.
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

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="env-studio" style={{ minHeight: "100vh", background: "var(--paper)" }}>
      <AdminStudioShell>{children}</AdminStudioShell>
    </div>
  );
}