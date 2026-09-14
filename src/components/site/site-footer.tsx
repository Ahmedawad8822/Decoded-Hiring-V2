import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

export function SiteFooter() {
  return (
    <footer className="hg-site-footer">
      <div className="hg-footer-statement">
        <span className="hg-brand-mark" aria-hidden="true">
          AA
        </span>
        <div>
          <strong>Decoded Hiring</strong>
          <span>Better recruitment thinking, made visible.</span>
        </div>
      </div>
      <nav aria-label="Explore">
        <strong>Explore</strong>
        <Link href="/about">About</Link>
        <Link href="/programmes">Programmes</Link>
        <Link href="/field-notes">Field Notes</Link>
        <Link href="/guides">Guides</Link>
      </nav>
      <nav aria-label="Programmes">
        <strong>Programmes</strong>
        <Link href="/mission-01">Mission 01</Link>
        <Link href="/workshop">Workshop</Link>
        <Link href="/coaching">Coaching</Link>
        <Link href="/ai-recruiter-os">AI Recruiter OS</Link>
      </nav>
      <nav aria-label="Trust and contact">
        <strong>Trust</strong>
        <Link href="/contact">
          Contact <ArrowUpRight aria-hidden="true" />
        </Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/cookies">Cookies</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/admin/login">Staff sign in</Link>
      </nav>
      <div className="hg-footer-base">
        <span>© {new Date().getFullYear()} Ahmed Awad</span>
        <span>Built for thoughtful recruitment.</span>
      </div>
    </footer>
  );
}
