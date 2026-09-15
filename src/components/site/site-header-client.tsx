"use client";

import { useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  ChevronDown,
  CircleUserRound,
  LogIn,
  Settings,
  UserRound,
} from "lucide-react";

type HeaderUser = {
  displayName: string;
  email: string | null;
};

type SiteHeaderClientProps = {
  user: HeaderUser | null;
  managedProgrammes: { href: string; label: string }[];
};

const learnLinks = [
  { href: "/programmes", label: "Programmes" },
  { href: "/mission-01", label: "Mission 01" },
  { href: "/workshop", label: "Workshop" },
  { href: "/coaching", label: "Coaching" },
  { href: "/ai-recruiter-os", label: "AI Recruiter OS" },
] as const;

const exploreLinks = [
  { href: "/about", label: "About" },
  { href: "/field-notes", label: "Field Notes" },
  { href: "/guides", label: "Guides" },
  { href: "/contact", label: "Contact" },
] as const;

export function SiteHeaderClient({
  user,
  managedProgrammes,
}: SiteHeaderClientProps) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const visibleLearnLinks = [...learnLinks, ...managedProgrammes];

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const closeAllMenus = useCallback(() => {
    if (!navRef.current) return;
    const allDetails = navRef.current.querySelectorAll<HTMLDetailsElement>("details.hg-nav-menu");
    allDetails.forEach((d) => {
      d.open = false;
    });
  }, []);

  // Close menus on route change
  useEffect(() => {
    closeAllMenus();
  }, [pathname, closeAllMenus]);

  // Handle Escape key and click-outside dismissal
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeAllMenus();
      }
    }

    function handlePointerDown(e: PointerEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        closeAllMenus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [closeAllMenus]);

  // Ensure only one dropdown menu is open at a time
  function handleToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    const target = e.currentTarget;
    if (target.open && navRef.current) {
      const allDetails = navRef.current.querySelectorAll<HTMLDetailsElement>("details.hg-nav-menu");
      allDetails.forEach((d) => {
        if (d !== target) {
          d.open = false;
        }
      });
    }
  }

  return (
    <header className="hg-topbar">
      <Link className="hg-brand" href="/" aria-label="Ahmed Awad home">
        <span className="hg-brand-mark" aria-hidden="true">
          AA
        </span>
        <span className="hg-brand-copy">
          <strong>Ahmed Awad</strong>
          <span>Hiring, decoded</span>
        </span>
      </Link>

      <nav className="hg-controls" ref={navRef} aria-label="Primary navigation">
        <Link
          className="hg-page-control"
          href="/"
          aria-current={isActive("/") ? "page" : undefined}
        >
          Home
        </Link>

        <details className="hg-nav-menu" onToggle={handleToggle}>
          <summary
            className="hg-page-control"
            aria-controls="nav-learn-popover"
            aria-current={
              visibleLearnLinks.some(({ href }) => isActive(href))
                ? "page"
                : undefined
            }
          >
            Learn <ChevronDown aria-hidden="true" />
          </summary>
          <div className="hg-nav-popover" id="nav-learn-popover">
            {visibleLearnLinks.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                aria-current={isActive(href) ? "page" : undefined}
              >
                {label}
              </Link>
            ))}
          </div>
        </details>

        <details className="hg-nav-menu" onToggle={handleToggle}>
          <summary
            className="hg-page-control"
            aria-controls="nav-explore-popover"
            aria-current={
              exploreLinks.some(({ href }) => isActive(href))
                ? "page"
                : undefined
            }
          >
            Explore <ChevronDown aria-hidden="true" />
          </summary>
          <div className="hg-nav-popover" id="nav-explore-popover">
            {exploreLinks.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                aria-current={isActive(href) ? "page" : undefined}
              >
                {label}
              </Link>
            ))}
          </div>
        </details>

        {user ? (
          <details className="hg-nav-menu hg-account-menu" onToggle={handleToggle}>
            <summary
              className="hg-login-entry"
              aria-controls="nav-account-popover"
              aria-label="Open account menu"
            >
              <CircleUserRound aria-hidden="true" />
              <span className="hg-account-name">{user.displayName}</span>
              <ChevronDown aria-hidden="true" />
            </summary>
            <div className="hg-nav-popover hg-account-popover" id="nav-account-popover">
              <span className="hg-account-identity">
                <strong>{user.displayName}</strong>
                {user.email ? <small>{user.email}</small> : null}
              </span>
              <Link href="/account/programmes">
                <BookOpen aria-hidden="true" /> My programmes
              </Link>
              <Link href="/account">
                <UserRound aria-hidden="true" /> Profile
              </Link>
              <Link href="/account/settings">
                <Settings aria-hidden="true" /> Settings
              </Link>
            </div>
          </details>
        ) : (
          <Link className="hg-login-entry" href="/login">
            <LogIn aria-hidden="true" /> Log in
          </Link>
        )}
      </nav>
    </header>
  );
}
