import { Card, PageHeader, humanLabel } from "../../_ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth";
import { getAdminQuestion } from "@/features/lesson-questions/service";
import { QuestionActions } from "./question-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Question · Studio | Decoded Hiring",
  description: "Learner question detail with answer form.",
  robots: { index: false, follow: false },
};

function ts(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export default async function AdminQuestionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminPage();
  const { id } = await params;
  const question = await getAdminQuestion(id);
  if (!question) notFound();

  return (
    <div>
      <p className="s-margin-bottom-8">
        <Link href="/admin/questions">← Back to questions</Link>
      </p>
      <PageHeader
        eyebrow="Questions"
        title={`Question on ${question.lessonTitle}`}
        description={`Asked in ${question.courseTitle} · ${humanLabel(question.status)}${question.isPublic ? " · Published on lesson" : ""}`}
      />

      <Card>
        <dl className="s-stack s-definition-grid s-gap-8px-24px">
          <div className="s-contents">
            <dt className="s-muted">Learner</dt>
            <dd className="s-margin-0">
              <Link href={`/admin/people/${question.learnerId}`}>
                {question.learnerName} ({question.learnerEmail})
              </Link>
            </dd>
          </div>
          <div className="s-contents">
            <dt className="s-muted">Course</dt>
            <dd className="s-margin-0">{question.courseTitle}</dd>
          </div>
          <div className="s-contents">
            <dt className="s-muted">Lesson</dt>
            <dd className="s-margin-0">
              {question.lessonTitle} ({`/learn/courses/${question.courseSlug}/lessons/${question.lessonSlug}`})
            </dd>
          </div>
          <div className="s-contents">
            <dt className="s-muted">Question</dt>
            <dd className="s-margin-0 s-white-space-pre-wrap s-overflow-wrap-anywhere">
              {question.body}
            </dd>
          </div>
          {question.answerBody && (
            <div className="s-contents">
              <dt className="s-muted">Answer</dt>
              <dd className="s-margin-0 s-white-space-pre-wrap s-overflow-wrap-anywhere">
                {question.answerBody}
              </dd>
            </div>
          )}
          <div className="s-contents">
            <dt className="s-muted">Asked (UTC)</dt>
            <dd className="s-margin-0">{ts(question.createdAt)}</dd>
          </div>
          <div className="s-contents">
            <dt className="s-muted">Answered (UTC)</dt>
            <dd className="s-margin-0">{ts(question.answeredAt)}</dd>
          </div>
        </dl>
      </Card>

      <div className="s-margin-top-20">
        <Card>
          <QuestionActions
            id={question.id}
            status={question.status}
            initialAnswer={question.answerBody ?? ""}
            initialIsPublic={question.isPublic}
          />
        </Card>
      </div>
    </div>
  );
}
