"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  askLessonQuestionAction,
  deleteLessonQuestionAction,
} from "@/features/lesson-questions/actions";
import {
  normalizeQuestionBody,
  QUESTION_MAX_BODY,
} from "@/features/lesson-questions/constants";

export interface LearnerQuestionView {
  id: string;
  body: string;
  status: "open" | "answered" | "closed";
  answerBody: string | null;
  answeredAt: string | null;
}

export interface PublicQuestionView {
  id: string;
  body: string;
  answerBody: string;
  answeredAt: string;
}

function statusLabel(status: LearnerQuestionView["status"]): string {
  if (status === "answered") return "Answered";
  if (status === "closed") return "Closed";
  return "Open";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function newSubmitKey(): string {
  return `q_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function LessonQuestionsPanel({
  courseSlug,
  lessonSlug,
  initialMine,
  initialPublic,
}: {
  courseSlug: string;
  lessonSlug: string;
  initialMine: LearnerQuestionView[];
  initialPublic: PublicQuestionView[];
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [submitKey, setSubmitKey] = useState<string>(() => newSubmitKey());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleAsk = async () => {
    if (busy) return;
    const normalized = normalizeQuestionBody(body);
    if (!normalized) {
      setError("Write your question first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await askLessonQuestionAction({
        courseSlug,
        lessonSlug,
        body: normalized,
        idempotencyKey: submitKey,
      });
      if (!response.ok) {
        setError(response.error || "Could not send your question");
        return;
      }
      // Fresh key per sent question: a retry resends the same key, a new
      // question never reuses one.
      setBody("");
      setSubmitKey(newSubmitKey());
      router.refresh();
    } catch {
      setError("Could not send your question. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (busy || deletingId) return;
    if (!window.confirm("Delete this question? This cannot be undone.")) return;
    setDeletingId(id);
    setError(null);
    try {
      const response = await deleteLessonQuestionAction({ id });
      if (!response.ok) {
        setError(response.error || "Could not delete your question");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not delete your question. Please try again.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="notes-section learner-mt-36" aria-labelledby="lesson-questions-heading">
      <div className="notes-head">
        <div>
          <p className="a-micro learner-mb-10">QUESTIONS</p>
          <h2 className="a-h2" id="lesson-questions-heading">
            Ask the instructor
          </h2>
        </div>
        <p className="notes-private">Private to you</p>
      </div>

      <div className="notes-field">
        <label className="notes-label" htmlFor="lesson-question-body">
          Your question
        </label>
        <textarea
          id="lesson-question-body"
          className="notes-textarea"
          value={body}
          maxLength={QUESTION_MAX_BODY}
          onChange={(event) => {
            setBody(event.target.value);
            if (error) setError(null);
          }}
          aria-describedby="lesson-question-hint lesson-question-counter"
        />
        <div className="notes-meta">
          <p id="lesson-question-hint" className="notes-hint">
            Only the instructor sees your question unless they publish the answer.
          </p>
          <p id="lesson-question-counter" className="notes-counter mono">
            {normalizeQuestionBody(body).length.toLocaleString("en-US")} /{" "}
            {QUESTION_MAX_BODY.toLocaleString("en-US")}
          </p>
        </div>
      </div>

      <div className="notes-actions">
        <button type="button" className="btn primary" onClick={handleAsk} disabled={busy}>
          {busy ? "Sending…" : "Ask a question"}
        </button>
      </div>

      <p className={`notes-status${error ? " is-error" : ""}`} aria-live="polite">
        {error ?? ""}
      </p>

      {initialMine.length > 0 && (
        <div className="learner-mt-16">
          <h3 className="a-micro learner-mb-10">YOUR QUESTIONS</h3>
          <ul className="question-list">
            {initialMine.map((question) => (
              <li key={question.id} className="resource-row">
                <span className="rr-main">
                  <b>{question.body}</b>
                  <span>
                    {statusLabel(question.status)}
                    {question.answeredAt ? ` · Answered ${formatDate(question.answeredAt)}` : ""}
                  </span>
                  {question.answerBody && (
                    <p className="note-entry-body">{question.answerBody}</p>
                  )}
                </span>
                {question.status === "open" && (
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => handleDelete(question.id)}
                    disabled={deletingId === question.id}
                  >
                    {deletingId === question.id ? "Deleting…" : "Delete"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {initialPublic.length > 0 && (
        <div className="learner-mt-16">
          <h3 className="a-micro learner-mb-10">FROM OTHER LEARNERS</h3>
          <ul className="question-list">
            {initialPublic.map((question) => (
              <li key={question.id} className="resource-row">
                <span className="rr-main">
                  <b>{question.body}</b>
                  <span>A learner asked · Answered {formatDate(question.answeredAt)}</span>
                  <p className="note-entry-body">{question.answerBody}</p>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
