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
        <Link
          className="sr-link"
          href="/admin/commerce"
          aria-current={pathname.startsWith("/admin/commerce") ? "page" : undefined}
        >
          ◇ Scheduling & Commerce
        </Link>

        <div className="sr-section">Editorial AI</div>
        <Link
          className="sr-link"
          href="/admin/editorial"
          aria-current={pathname.startsWith("/admin/editorial") && !pathname.startsWith("/admin/editorial/memory") ? "page" : undefined}
        >
          ✦ Drafts
        </Link>
        <Link
          className="sr-link"
          href="/admin/knowledge"
          aria-current={pathname.startsWith("/admin/knowledge") ? "page" : undefined}
        >
          ◫ Knowledge
        </Link>
        <Link
          className="sr-link"
          href="/admin/editorial/memory"
          aria-current={pathname.startsWith("/admin/editorial/memory") ? "page" : undefined}
        >
          ◉ Memory
        </Link>
      </aside>

      {/* Studio Main Content Area */}
      <div className="studio-main">
        <header className="studio-topbar">
          <span className="st-crumb">
            Studio ·{" "}
            <b>
              {pathname.startsWith("/admin/knowledge")
                ? "Knowledge"
                : pathname.startsWith("/admin/editorial/memory")
                  ? "Editorial Memory"
                  : pathname.startsWith("/admin/editorial")
                    ? "Editorial"
                    : pathname.startsWith("/admin/courses")
                      ? "Courses"
                      : pathname.startsWith("/admin/commerce")
                        ? "Scheduling & Commerce"
                        : "Content"}
            </b>
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
