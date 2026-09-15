import React from "react";
import { AdminStudioShell } from "./studio-shell";

export const metadata = {
  title: "Studio · Content | Decoded Hiring",
  description: "Decoded Hiring V2 Content and Guide management.",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="env-studio" style={{ minHeight: "100vh", background: "var(--paper)" }}>
      <AdminStudioShell>{children}</AdminStudioShell>
    </div>
  );
}
