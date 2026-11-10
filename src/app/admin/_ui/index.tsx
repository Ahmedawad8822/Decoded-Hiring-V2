import Link from "next/link";
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./icon";
export { Icon } from "./icon";
export { FileDrop, Drawer, Tabs, StatusFilters, useToast } from "./interactive";

export function Button({ variant, size = "md", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return <button className={`btn ${variant || (/\b(primary|secondary|ghost|danger)\b/.test(className) ? "" : "secondary")} ${size === "sm" ? "small" : ""} ${className}`} {...props} />;
}
export function IconButton({ icon, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return <Button variant="ghost" aria-label={label} title={label} {...props}><Icon name={icon} /></Button>;
}
export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={`ui-card ${className}`} {...props} />; }
export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return <header className="page-header"><div><p className="page-eyebrow"><span />{eyebrow}</p><h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{action && <div className="page-action">{action}</div>}</header>;
}
export function StatCard({ icon, value, label, attention = false, href, detail }: { icon: IconName; value: number; label: string; attention?: boolean; href?: string; detail?: string }) {
  const body = <><span className="stat-icon"><Icon name={icon} /></span><strong className="stat-value">{value.toLocaleString("en")}</strong><span className="stat-label">{label}</span>{detail && <small>{detail}</small>}{attention && value > 0 && <span className="stat-attention">Needs attention <Icon name="arrow" width="14" height="14" /></span>}</>;
  const className = `ui-card stat-card ${value === 0 ? "is-zero" : ""} ${attention && value > 0 ? "needs-attention" : ""}`;
  return href ? <Link href={href} className={className}>{body}</Link> : <div className={className}>{body}</div>;
}
export function StatusPill({ children, status, className = "", ...props }: HTMLAttributes<HTMLSpanElement> & { status?: string }) {
  const key = (status || (typeof children === "string" ? children : "draft")).toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  return <span className={`lifecycle ${key} ${className}`} {...props}>{children}</span>;
}
export function FilterChips({ label, items }: { label: string; items: { label: string; href: string; active: boolean; count?: number }[] }) {
  return <nav aria-label={label} className="filter-chips">{items.map(item => <Link key={item.href} href={item.href} aria-current={item.active ? "page" : undefined}>{item.label}{item.count !== undefined && <span>{item.count}</span>}</Link>)}</nav>;
}
export function DataTable({ className = "", ...props }: HTMLAttributes<HTMLTableElement>) { return <div className="table-wrap"><table className={`data ${className}`} {...props} /></div>; }
export function EmptyState({ icon = "inbox", title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-art"><Icon name={icon} width="36" height="36" /><span /><span /></div><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}
export function Field({ label, help, children, htmlFor }: { label: string; help?: string; children: ReactNode; htmlFor?: string }) {
  return <div className="ui-field"><label htmlFor={htmlFor}>{label}</label>{children}{help && <p className="help">{help}</p>}</div>;
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} />; }
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} />; }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} />; }
export function Toast({ title, children, error }: { title: string; children: ReactNode; error?: boolean }) { return <div className={`toast ${error ? "error" : ""}`} role={error ? "alert" : "status"}><b>{title}</b><span>{children}</span></div>; }
export function humanLabel(value: string) {
  const labels: Record<string, string> = { ai_os: "AI Recruiter OS", field_note: "Field note", course_section: "Section", course_lesson: "Lesson", lesson_resource: "Lesson file", booking_type: "Booking type", availability_window: "Availability", lead_submission: "Lead", PAID_ONE_TIME: "One-time payment", PAID_SESSION: "Paid session", MANUAL_INVOICE: "Invoice", PAYMENT_DISABLED: "Payments disabled", AHMED_APPROVAL: "Owner approval", AUTO_CONFIRM: "Automatic confirmation", REQUEST_ONLY: "Request only" };
  return labels[value] || value.toLowerCase().replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
}
export function RelativeTime({ date, now }: { date: Date; now: number }) {
  const minutes = Math.round((date.getTime() - now) / 60000);
  const unit = Math.abs(minutes) >= 1440 ? "day" : Math.abs(minutes) >= 60 ? "hour" : "minute";
  const value = Math.round(minutes / (unit === "day" ? 1440 : unit === "hour" ? 60 : 1));
  return <time dateTime={date.toISOString()} title={date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}>{new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(value, unit)}</time>;
}
