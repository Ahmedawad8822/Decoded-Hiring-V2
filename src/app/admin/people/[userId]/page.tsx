import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import {
  emailKindLabel,
  getPersonProfile,
  type PersonCourseRow,
} from "@/features/people/service";
import { Card, DataTable, EmptyState, PageHeader, RelativeTime, StatusPill, humanLabel } from "../../_ui";
import { PersonNote, PersonTags } from "./person-profile-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Person · Studio | Decoded Hiring",
  description: "Everything known about one learner, in one place.",
  robots: { index: false, follow: false },
};

function formatDateUTC(date: Date): string {
  return date.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

function formatMoney(amountMinor: number | null, currency: string | null): string {
  if (amountMinor === null || !currency) return "—";
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}

function courseStatus(row: PersonCourseRow): { label: string; status: string } {
  if (row.status === "cancelled") return { label: "Left", status: "cancelled" };
  if (row.status === "completed") return { label: "Completed", status: "completed" };
  return { label: "Active", status: "active" };
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="s-margin-top-24" aria-label={title}>
      <h2 className="s-text-base">
        {title}
        {count !== undefined && <span className="a-micro"> · {count}</span>}
      </h2>
      <div className="s-margin-top-8">{children}</div>
    </section>
  );
}

export default async function AdminPersonPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  await requireAdminPage();
  const { userId } = await params;
  const profile = await getPersonProfile(userId);
  if (!profile) notFound();

  const now = new Date().getTime();

  return (
    <>
      <PageHeader
        eyebrow="People"
        title={profile.user.name}
        description={profile.user.email}
      />
      <Link href="/admin/people">← People</Link>

      <Card>
        <p className="s-text-sm">
          <b>{profile.user.name}</b> · {profile.user.email}
        </p>
        <p className="muted s-text-sm s-margin-top-4">
          Joined {formatDateUTC(profile.user.createdAt)} · Email{" "}
          {profile.user.emailVerified ? "verified" : "not verified"}
        </p>
      </Card>

      <Section title="Tags">
        <Card>
          <PersonTags
            userId={profile.user.id}
            initialTags={profile.tags.map((t) => ({ tag: t.tag, source: t.source }))}
          />
        </Card>
      </Section>

      <Section title="Private note">
        <Card>
          <PersonNote
            userId={profile.user.id}
            initialNote={
              profile.note ? { body: profile.note.body, updatedAt: profile.note.updatedAt } : null
            }
          />
        </Card>
      </Section>

      <Section title="Courses" count={profile.courses.length}>
        {profile.courses.length === 0 ? (
          <EmptyState icon="courses" title="Not enrolled anywhere yet">
            Enrollments appear here once they join a course.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Course</th>
                  <th scope="col">Progress</th>
                  <th scope="col">Enrolled</th>
                  <th scope="col">Last activity</th>
                  <th scope="col">Status</th>
                  <th scope="col">Learners tab</th>
                </tr>
              </thead>
              <tbody>
                {profile.courses.map((course) => {
                  const badge = courseStatus(course);
                  return (
                    <tr key={course.enrollmentId}>
                      <td>
                        <span className="cell-main">{course.courseTitle}</span>
                        <span className="cell-sub s-block s-text-xs">/{course.courseSlug}</span>
                      </td>
                      <td>
                        <span className="learner-progress" role="img" aria-label={`${course.percent}% complete`}>
                          <i style={{ width: `${course.percent}%` }} />
                        </span>
                        <span className="cell-sub s-block">
                          {course.completedRequired} of {course.totalRequired} · {course.percent}%
                        </span>
                      </td>
                      <td>{formatDateUTC(course.enrolledAt)}</td>
                      <td>
                        <RelativeTime date={course.lastActivityAt} now={now} />
                      </td>
                      <td>
                        <StatusPill status={badge.status}>{badge.label}</StatusPill>
                      </td>
                      <td>
                        <Link
                          href={`/admin/courses/${course.courseId}/learners?q=${encodeURIComponent(profile.user.email)}`}
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          </div>
        )}
      </Section>

      <Section title="Quiz attempts" count={profile.quizAttempts.length}>
        {profile.quizAttempts.length === 0 ? (
          <EmptyState icon="content" title="No quiz attempts yet">
            Graded submissions appear here, newest first.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Lesson</th>
                  <th scope="col">Score</th>
                  <th scope="col">Result</th>
                  <th scope="col">Date</th>
                </tr>
              </thead>
              <tbody>
                {profile.quizAttempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <td>
                      <span className="cell-main">{attempt.lessonTitle}</span>
                      <span className="cell-sub s-block s-text-xs">{attempt.courseTitle}</span>
                    </td>
                    <td className="num">{attempt.scorePercent}%</td>
                    <td>
                      <StatusPill status={attempt.passed ? "completed" : "cancelled"}>
                        {attempt.passed ? "Passed" : "Failed"}
                      </StatusPill>
                    </td>
                    <td>{formatDateUTC(attempt.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}
      </Section>

      <Section title="Certificates" count={profile.certificates.length}>
        {profile.certificates.length === 0 ? (
          <EmptyState icon="courses" title="No certificates yet">
            Issued certificates appear here with a verify link.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Course</th>
                  <th scope="col">Issued</th>
                  <th scope="col">State</th>
                  <th scope="col">Verify</th>
                </tr>
              </thead>
              <tbody>
                {profile.certificates.map((certificate) => (
                  <tr key={certificate.id}>
                    <td>
                      <span className="cell-main">{certificate.courseTitle}</span>
                      <span className="cell-sub s-block s-text-xs">{certificate.recipientName}</span>
                    </td>
                    <td>{formatDateUTC(certificate.issuedAt)}</td>
                    <td>
                      {certificate.revokedAt ? (
                        <span>
                          <StatusPill status="cancelled">Revoked</StatusPill>
                          {certificate.revokedReason && (
                            <span className="cell-sub s-block s-text-xs">{certificate.revokedReason}</span>
                          )}
                        </span>
                      ) : (
                        <StatusPill status="completed">Valid</StatusPill>
                      )}
                    </td>
                    <td>
                      <Link href={`/certificates/${certificate.id}`}>Verify</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}
      </Section>

      <Section title="Bookings" count={profile.bookings.length}>
        {profile.bookings.length === 0 ? (
          <EmptyState icon="calendar" title="No bookings yet">
            Bookings under this email appear here.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Starts</th>
                  <th scope="col">Requested</th>
                </tr>
              </thead>
              <tbody>
                {profile.bookings.map((booking) => (
                  <tr key={booking.id}>
                    <td>{booking.bookingTypeTitle}</td>
                    <td>
                      <StatusPill status={booking.status}>{humanLabel(booking.status)}</StatusPill>
                    </td>
                    <td>{booking.startAt ? formatDateUTC(booking.startAt) : "—"}</td>
                    <td>{formatDateUTC(booking.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}
      </Section>

      <Section title="Orders" count={profile.orders.length}>
        {profile.orders.length === 0 ? (
          <EmptyState icon="orders" title="No orders yet">
            Orders for this account or email appear here.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Offer</th>
                  <th scope="col">Status</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {profile.orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <span className="cell-main">{order.offerTitle}</span>
                      <span className="cell-sub s-block s-text-xs">{humanLabel(order.offerKind)}</span>
                    </td>
                    <td>
                      <StatusPill status={order.status}>{humanLabel(order.status)}</StatusPill>
                    </td>
                    <td>{formatMoney(order.amountMinor, order.currency)}</td>
                    <td>{formatDateUTC(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}
      </Section>

      <Section title="Leads" count={profile.leads.length}>
        {profile.leads.length === 0 ? (
          <EmptyState icon="leads" title="No leads yet">
            Form submissions under this email appear here.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {profile.leads.map((lead) => (
                  <tr key={lead.id}>
                    <td>{humanLabel(lead.kind)}</td>
                    <td>
                      <span className="cell-main">{lead.fullName}</span>
                      <span className="cell-sub s-block s-text-xs">{lead.sourceRoute}</span>
                    </td>
                    <td>
                      <StatusPill status={lead.status}>{humanLabel(lead.status)}</StatusPill>
                    </td>
                    <td>{formatDateUTC(lead.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}
      </Section>

      <Section title="Emails sent" count={profile.emails.length}>
        {profile.emails.length === 0 ? (
          <EmptyState icon="inbox" title="No emails sent yet">
            Transactional emails to this address appear here (subjects only).
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Status</th>
                  <th scope="col">Sent</th>
                </tr>
              </thead>
              <tbody>
                {profile.emails.map((email) => (
                  <tr key={email.id}>
                    <td>{emailKindLabel(email.kind)}</td>
                    <td>{email.subject}</td>
                    <td>
                      <StatusPill status={email.status}>{humanLabel(email.status)}</StatusPill>
                    </td>
                    <td>{email.sentAt ? formatDateUTC(email.sentAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}
      </Section>

      <Section title="Timeline" count={profile.timeline.length}>
        {profile.timeline.length === 0 ? (
          <EmptyState icon="clock" title="Nothing here yet">
            Enrollments, completions, quizzes, bookings, orders, leads and emails land here.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What happened</th>
                </tr>
              </thead>
              <tbody>
                {profile.timeline.map((item, index) => (
                  <tr key={`${item.kind}-${item.date.getTime()}-${index}`}>
                    <td>
                      <RelativeTime date={item.date} now={now} />
                      <span className="cell-sub s-block s-text-xs">{formatDateUTC(item.date)}</span>
                    </td>
                    <td>
                      {item.href ? <Link href={item.href}>{item.label}</Link> : item.label}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}
      </Section>
    </>
  );
}
