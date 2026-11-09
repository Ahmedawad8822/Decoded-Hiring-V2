import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { readStudioAttention } from "./_ui/attention-data";
import { getAllAdminGuides } from "@/features/guides/service";
import { getAllAdminFieldNotes } from "@/features/field-notes/service";
import { getAllAdminCourses, getCourseEnrollmentCounts } from "@/features/courses/service";
import { listAdminAudit } from "@/features/audit/service";
import { Card, EmptyState, Icon, PageHeader, RelativeTime, StatCard, humanLabel } from "./_ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home · Studio | Decoded Hiring", robots: { index: false, follow: false } };
export default async function AdminHomePage() {
  const session = await requireAdminPage();
  const [{ leads, drafts, commerce }, guides, notes, courses, audit] = await Promise.all([
    readStudioAttention(), getAllAdminGuides(), getAllAdminFieldNotes(),
    getAllAdminCourses(), listAdminAudit({ pageSize: 7 }),
  ]);
  const enrollments = await getCourseEnrollmentCounts(courses.map(course => course.id));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = session.user.name?.trim().split(/\s+/)[0];
  return <div className="page-stack home-page">

    <PageHeader eyebrow="Your workspace, at a glance" title={`${greeting}${firstName ? `, ${firstName}` : ""}.`} description="A little clarity for your next move. Here’s what’s happening across Decoded." action={<Link className="btn primary" href="/admin/content?new=guide"><Icon name="plus" />Create something</Link>} />
    <section aria-label="Studio overview" className="stat-grid home-stats">
      <StatCard icon="leads" value={leads.total} label="New leads" attention href="/admin/leads" />
      <StatCard icon="sparkles" value={drafts.length} label="Drafts in review" attention href="/admin/editorial?status=IN_REVIEW" />
      <StatCard icon="calendar" value={commerce.summary.approvalQueue} label="Bookings to approve" attention href="/admin/commerce?tab=bookings" />
      <StatCard icon="orders" value={commerce.summary.openOrders} label="Open orders" attention href="/admin/commerce?tab=orders" />
      <StatCard icon="content" value={[...guides, ...notes].filter(item => item.status === "published").length} label="Published guides & notes" href="/admin/content" />
      <StatCard icon="courses" value={Object.values(enrollments).reduce((sum, count) => sum + count, 0)} label="Course enrollments" detail="Across all courses" href="/admin/courses" />
    </section>
    <div className="home-columns"><Card className="quick-actions"><p className="page-eyebrow">Make your next move</p><h2>Start with an idea.</h2><p className="muted">Give it a place to grow.</p>
      {[{ title: "New guide", hint: "Share a deeper perspective", href: "/admin/content?new=guide", icon: "content" as const }, { title: "New field note", hint: "Capture a timely observation", href: "/admin/content?new=field-note", icon: "edit" as const }, { title: "New course", hint: "Build the next learning journey", href: "/admin/courses?new=course", icon: "courses" as const }, { title: "New AI draft", hint: "Create with your knowledge library", href: "/admin/editorial/new", icon: "sparkles" as const }].map(item => <Link href={item.href} key={item.title} aria-label={item.title}><span className="quick-icon"><Icon name={item.icon} /></span><span><strong>{item.title}</strong><small>{item.hint}</small></span><Icon name="arrow" /></Link>)}
    </Card><Card className="activity-card"><div className="section-heading"><h2>Recent activity</h2><Link href="/admin/audit" className="btn ghost small">View all <Icon name="arrow" /></Link></div>
        {audit.entries.length ? <ol className="activity-list">{audit.entries.map(entry => <li key={entry.id}><span className="activity-dot"><Icon name="check" width="16" height="16" /></span><div><strong>{humanLabel(entry.action)}</strong><span>{humanLabel(entry.entityType)}</span></div><RelativeTime date={entry.createdAt} now={new Date().getTime()} /></li>)}</ol> : <EmptyState icon="audit" title="A fresh start" action={<Link className="btn secondary" href="/admin/content?new=guide">Write your first guide</Link>}>Your latest Studio changes will appear here.</EmptyState>}
      </Card></div>
  </div>;
}
