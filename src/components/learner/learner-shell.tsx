"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

export function LearnerShell({
  userName,
  children,
}: {
  userName: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const isActive = (href: string) =>
    href === "/learn" ? pathname === "/learn" : pathname.startsWith(href);

  const handleSignOut = async () => {
    await authClient.signOut();
    router.push("/");
    router.refresh();
  };

  return (
    <div className="env-learner" style={{ minHeight: "100vh" }}>
      <header className="lrn-topbar">
        <div className="wrap bar">
          <Link className="lrn-brand" href="/learn">
            <strong>HIRING, DECODED</strong>
            <span>CLASSROOM</span>
          </Link>
          <nav className="lrn-nav" aria-label="Learner">
            <Link href="/learn" aria-current={isActive("/learn") && pathname === "/learn" ? "page" : undefined}>
              Home
            </Link>
            <Link href="/learn/courses" aria-current={pathname.startsWith("/learn/courses") ? "page" : undefined}>
              Courses
            </Link>
            <span className="lrn-user" style={{ fontSize: 12.5 }} title={userName}>
              {userName}
            </span>
            <button
              type="button"
              onClick={handleSignOut}
              className="btn ghost small"
              style={{ fontSize: 12 }}
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      {children}

      <nav className="lrn-tabs" aria-label="Learner">
        <Link href="/learn" aria-current={pathname === "/learn" ? "page" : undefined}>
          <span className="tab-ico" aria-hidden="true">◈</span>Home
        </Link>
        <Link href="/learn/courses" aria-current={pathname.startsWith("/learn/courses") ? "page" : undefined}>
          <span className="tab-ico" aria-hidden="true">▤</span>Courses
        </Link>
      </nav>
    </div>
  );
}
