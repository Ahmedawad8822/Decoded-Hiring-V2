"use client";
import { Button } from "./_ui";

import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { Drawer } from "./_ui/interactive";
import { Icon, type IconName } from "./_ui/icon";
import { AttentionProvider, useAttention, type Attention } from "./_ui/attention";

const groups: { label: string; items: { label: string; href: string; icon: IconName; section: string; badge?: keyof Attention }[] }[] = [
  { label: "", items: [{ label: "Home", href: "/admin", icon: "home", section: "home" }] },
  { label: "Publish", items: [{ label: "Content", href: "/admin/content", icon: "content", section: "content" }, { label: "Courses", href: "/admin/courses", icon: "courses", section: "courses" }] },
  { label: "Business", items: [{ label: "Bookings & offers", href: "/admin/commerce", icon: "calendar", section: "commerce", badge: "bookings" }, { label: "Leads", href: "/admin/leads", icon: "leads", section: "leads", badge: "leads" }] },
  { label: "Editorial AI", items: [{ label: "Drafts", href: "/admin/editorial", icon: "sparkles", section: "editorial", badge: "drafts" }, { label: "Knowledge", href: "/admin/knowledge", icon: "knowledge", section: "editorial" }, { label: "Memory", href: "/admin/editorial/memory", icon: "memory", section: "editorial" }] },
  { label: "Admin", items: [{ label: "Audit log", href: "/admin/audit", icon: "audit", section: "admin" }, { label: "Security", href: "/admin/security", icon: "security", section: "admin" }] },
];
// Keep these three editorial destinations explicit for the existing navigation
// discoverability contract, while sharing their active-state and badge chrome.
function NavigationLink({ href, ...props }: ComponentProps<typeof Link>) {
  if (href === "/admin/editorial") return <Link href="/admin/editorial" {...props} />;
  if (href === "/admin/knowledge") return <Link href="/admin/knowledge" {...props} />;
  if (href === "/admin/editorial/memory") return <Link href="/admin/editorial/memory" {...props} />;
  return <Link href={href} {...props} />;
}
function Navigation({ pathname }: { pathname: string }) {
  const counts = useAttention();
  return <><Link href="/admin" className="sr-brand"><b>Decoded<span className="brand-period">.</span></b><span className="studio-tag"><i />Studio</span></Link>
    <nav aria-label="Studio">{groups.map(group => <div className="sr-group" key={group.label}>{group.label && <div className="sr-section">{group.label}</div>}{group.items.map(item => {
      const active = item.href === "/admin" ? pathname === "/admin" : item.href === "/admin/editorial" ? pathname.startsWith(item.href) && !pathname.includes("/memory") : pathname.startsWith(item.href);
      const count = item.badge ? counts[item.badge] : undefined;
      return <NavigationLink key={item.href} className="sr-link" data-section={item.section} href={item.href} aria-current={active ? "page" : undefined}><Icon name={item.icon} /><span>{item.label}</span>{count !== undefined && count > 0 && <span className="nav-badge" aria-label={`${count} need attention`}>{count}</span>}</NavigationLink>;
    })}</div>)}</nav><div className="sr-footer"><span className="live-dot" />Your publishing workspace</div></>;
}
function Shell({ children, user }: { children: ReactNode; user?: { name?: string | null; email?: string | null } | null }) {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname === "/admin/login") return <div className="studio studio-login">{children}</div>;
  const current = groups.flatMap(g => g.items).filter(i => i.href === "/admin" ? pathname === i.href : pathname.startsWith(i.href)).at(-1) || groups[0].items[0];
  const initials = user?.name?.split(/\s+/).filter(Boolean).slice(0, 2).map(n => n[0]).join("") || "DS";
  const signOut = async () => { await authClient.signOut(); router.push("/admin/login"); router.refresh(); };
  return <div className="studio" data-section={current.section}>
    <aside className="studio-rail" aria-label="Studio navigation"><Navigation pathname={pathname} /></aside>
    <div className="studio-main"><header className="studio-topbar">
      <Drawer><Navigation pathname={pathname} /></Drawer>
      <span className="st-crumb"><span>Studio <span className="crumb-divider">/</span> </span><b>{current.label}</b></span>
      <span className="st-spacer" />
      <Link href="/" target="_blank" prefetch={false} className="btn ghost live-site" aria-label="View live site"><span>View live site</span><Icon name="external" width="16" height="16" /></Link>
      <details className="avatar-menu"><summary aria-label="Account menu"><span className="st-avatar">{initials}</span></summary><div className="avatar-panel"><strong>{user?.name || "Studio admin"}</strong><span>{user?.email}</span><Link href="/admin/security">Security</Link><Button type="button" onClick={signOut}>Sign out</Button></div></details>
    </header><main className="studio-page" id="main">{children}</main></div>
  </div>;
}
export function AdminStudioShell(props: { children: ReactNode; user?: { name?: string | null; email?: string | null } | null; attention?: Attention }) { return <AttentionProvider initialCounts={props.attention}><Shell {...props} /></AttentionProvider>; }
