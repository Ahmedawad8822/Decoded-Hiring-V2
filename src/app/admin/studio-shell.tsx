"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

export function AdminStudioShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  // On login page, render clean centered door without studio sidebar
  if (pathname === "/admin/login") {
    return <>{children}</>;
  }

  const handleSignOut = async () => {
    await authClient.signOut();
    router.push("/admin/login");
    router.refresh();
  };

  return (
    <div className="studio">
      {/* Studio Navigation Rail */}
      <aside className="studio-rail" aria-label="Studio navigation">
        <div className="sr-brand">
          <b>STUDIO</b>
          <span>DECODED HIRING</span>
        </div>

        <div className="sr-section">Today</div>
        <Link className="sr-link" href="/prototypes/studio/command.html">
          ◧ Command Center
        </Link>
        <Link className="sr-link" href="/prototypes/studio/approvals.html">
          ✓ Approvals <span className="badge">3</span>
        </Link>
        <Link className="sr-link" href="/prototypes/studio/enquiries.html">
          ✉ Enquiries
        </Link>

        <div className="sr-section">Product</div>
        <Link
          className="sr-link"
          href="/admin/content"
          aria-current={pathname.startsWith("/admin/content") ? "page" : undefined}
        >
          ▤ Content
        </Link>
        <Link
          className="sr-link"
          href="/admin/courses"
          aria-current={pathname.startsWith("/admin/courses") ? "page" : undefined}
        >
          ◈ Courses
        </Link>
        <Link className="sr-link" href="/prototypes/studio/products.html">
          ◉ Products
        </Link>
        <Link className="sr-link" href="/prototypes/studio/bookings.html">
          ◷ Bookings
        </Link>
        <Link className="sr-link" href="/prototypes/studio/students.html">
          ◍ Students
        </Link>

        <div className="sr-section">Intelligence</div>
        <Link className="sr-link" href="/prototypes/studio/intelligence.html">
          ◒ Intelligence
        </Link>
        <Link className="sr-link" href="/prototypes/studio/editorial.html">
          ✎ AI Content Studio
        </Link>

        <div className="sr-section">System</div>
        <Link className="sr-link" href="/prototypes/studio/reliability.html">
          ⚑ Reliability
        </Link>
        <Link className="sr-link" href="/prototypes/studio/settings.html">
          ⚙ Settings
        </Link>
      </aside>

      {/* Studio Main Content Area */}
      <div className="studio-main">
        <header className="studio-topbar">
          <span className="st-crumb">
            Studio · <b>Content</b>
          </span>
          <span className="st-spacer"></span>

          <Link
            href="/guides"
            target="_blank"
            className="btn ghost small"
            style={{ textDecoration: "none", fontSize: "12px" }}
          >
            ↗ View Live Site
          </Link>

          <button
            type="button"
            onClick={handleSignOut}
            className="btn secondary small"
            style={{ fontSize: "12px" }}
          >
            Sign out
          </button>

          <span className="st-avatar" title="Ahmed Awad — Admin">
            AA
          </span>
        </header>

        <main className="studio-page" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}
