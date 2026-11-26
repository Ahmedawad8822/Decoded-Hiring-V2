"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  answerLessonQuestionAction,
  closeLessonQuestionAction,
  reopenLessonQuestionAction,
} from "@/features/lesson-questions/actions";
import {
  normalizeQuestionBody,
  QUESTION_MAX_ANSWER,
} from "@/features/lesson-questions/constants";

export function QuestionActions({
  id,
  status,
  initialAnswer,
  initialIsPublic,
}: {
  id: string;
  status: "open" | "answered" | "closed";
  initialAnswer: string;
  initialIsPublic: boolean;
}) {
  const router = useRouter();
  const [answer, setAnswer] = useState(initialAnswer);
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleAnswer = async () => {
    if (busy) return;
    const normalized = normalizeQuestionBody(answer);
    if (!normalized) {
      setError("Write the answer first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await answerLessonQuestionAction({
        id,
        answerBody: normalized,
        isPublic,
      });
      if (!response.ok) {
        setError(response.error || "Could not save the answer");
        return;
      }
      setAnswer(normalized);
      router.refresh();
    } catch {
      setError("Could not save the answer. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleTransition = async (kind: "close" | "reopen", expected: string) => {
    if (busy) return;
    const confirmText =
      kind === "close"
        ? "Close this question? The learner keeps the answer, but it leaves the inbox queue."
        : "Reopen this question? It returns to the open queue.";
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      const response =
        kind === "close"
          ? await closeLessonQuestionAction(id, expected)
          : await reopenLessonQuestionAction(id, expected);
      if (!response.ok) {
        setError(response.error || "Could not update the question");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not update the question. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="s-stack s-gap-16">
      {status !== "closed" ? (
        <>
          <div>
            <label className="s-text-sm" htmlFor="question-answer-body">
              Answer
            </label>
            <textarea
              id="question-answer-body"
              className="s-margin-top-8"
              value={answer}
              rows={6}
              maxLength={QUESTION_MAX_ANSWER}
              onChange={(event) => {
                setAnswer(event.target.value);
                if (error) setError(null);
              }}
              aria-describedby="question-answer-counter"
            />
            <p id="question-answer-counter" className="s-text-sm s-muted s-margin-top-4">
              {normalizeQuestionBody(answer).length.toLocaleString("en-US")} /{" "}
              {QUESTION_MAX_ANSWER.toLocaleString("en-US")}
            </p>
          </div>
          <label className="s-text-sm">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(event) => setIsPublic(event.target.checked)}
            />{" "}
            Publish on lesson (visible to all enrolled learners, no names shown)
          </label>
          <div className="s-row s-gap-16">
            <button type="button" className="btn primary" onClick={handleAnswer} disabled={busy}>
              {busy ? "Saving…" : status === "answered" ? "Update answer" : "Send answer"}
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={() => handleTransition("close", status)}
              disabled={busy}
            >
              Close
            </button>
          </div>
        </>
      ) : (
        <div className="s-row s-gap-16">
          <button
            type="button"
            className="btn secondary"
            onClick={() => handleTransition("reopen", status)}
            disabled={busy}
          >
            Reopen
          </button>
        </div>
      )}
      {error && (
        <p className="s-text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
