"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { submitQuizAttemptAction } from "@/features/quizzes/actions";
import type { LearnerQuiz, LearnerQuizStats } from "@/features/quizzes/types";

interface QuizFeedback {
  id: string;
  correct: boolean;
  correctOptionIds: string[];
  explanation?: string;
}

interface QuizSubmission {
  scorePercent: number;
  correctCount: number;
  totalCount: number;
  passed: boolean;
  questions: QuizFeedback[];
  nextHref: string | null;
  lessonCompleted: boolean;
}

export function QuizPanel({
  quiz,
  mode,
  stats,
  courseSlug,
  lessonSlug,
}: {
  quiz: LearnerQuiz;
  mode: "enrolled" | "preview";
  stats: LearnerQuizStats;
  courseSlug: string;
  lessonSlug: string;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<QuizSubmission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Learner polish: on narrow screens (CSS media query, not user-agent
  // sniffing) one question shows per step with Back/Next. Desktop keeps the
  // full list. `step` is inert on desktop: every question renders and the
  // step nav is hidden by CSS.
  const [step, setStep] = useState(0);
  const questionRefs = useRef<Array<HTMLFieldSetElement | null>>([]);
  const focusStepRef = useRef<number | null>(null);
  const totalQuestions = quiz.questions.length;
  const lastStep = Math.max(totalQuestions - 1, 0);

  const goStep = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), lastStep);
    focusStepRef.current = clamped;
    setStep(clamped);
  };

  // Keyboard/screen-reader friendly: moving steps moves focus to the newly
  // shown question (only for step-nav moves, never on first paint).
  useEffect(() => {
    if (focusStepRef.current === step) {
      focusStepRef.current = null;
      questionRefs.current[step]?.focus({ preventScroll: true });
    }
  }, [step]);

  const isPreview = mode === "preview";
  const locked = isPreview || Boolean(result);
  const feedbackById = new Map((result?.questions ?? []).map((entry) => [entry.id, entry]));

  const choose = (questionId: string, optionId: string, kind: "single" | "multiple") => {
    if (locked) return;
    setAnswers((current) => {
      if (kind === "single") return { ...current, [questionId]: [optionId] };
      const selected = current[questionId] ?? [];
      return {
        ...current,
        [questionId]: selected.includes(optionId)
          ? selected.filter((id) => id !== optionId)
          : [...selected, optionId],
      };
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (locked) return;
    setBusy(true);
    setError(null);
    try {
      const response = await submitQuizAttemptAction({ courseSlug, lessonSlug, answers });
      if (!response.ok || !response.data) {
        setError(response.error || "Could not submit the quiz");
      } else {
        setResult(response.data);
        router.refresh();
      }
    } catch {
      setError("Could not submit the quiz. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const tryAgain = () => {
    setResult(null);
    setAnswers({});
    setError(null);
    setStep(0);
  };

  return (
    <section className="quiz-section learner-mt-36" aria-labelledby="lesson-quiz-heading">
      <div className="quiz-head">
        <div>
          <p className="a-micro learner-mb-10">LESSON QUIZ</p>
          <h2 className="a-h2" id="lesson-quiz-heading">Check your understanding</h2>
        </div>
        {!isPreview && (
          <p className="quiz-stats mono">
            {stats.attemptCount === 0
              ? "Not attempted yet"
              : `Best ${stats.bestScore ?? 0}% · ${stats.attemptCount} attempt${stats.attemptCount === 1 ? "" : "s"}`}
          </p>
        )}
      </div>

      <p className="quiz-pass-note">
        {quiz.requirePass
          ? `Pass mark: ${quiz.passPercent}% — required to complete this lesson.`
          : `Pass mark: ${quiz.passPercent}%.`}
      </p>

      {isPreview && (
        <div className="quiz-preview-note">
          <p>This quiz is part of the enrolled course. Enroll to submit your answers.</p>
          <Link className="btn primary learner-link" href={`/learn/courses/${courseSlug}`}>
            Enroll to take the quiz →
          </Link>
        </div>
      )}

      <form
        className={`quiz-form is-stepped${step === lastStep ? " is-last-step" : ""}`}
        onSubmit={handleSubmit}
        aria-describedby="quiz-help"
      >
        <p id="quiz-help" className="quiz-help">
          {quiz.questions.length} question{quiz.questions.length === 1 ? "" : "s"} · Select the best answer
          {quiz.questions.some((question) => question.kind === "multiple") ? "s" : ""}.
        </p>

        {quiz.questions.map((question, questionIndex) => {
          const feedback = feedbackById.get(question.id);
          const correctIds = new Set(feedback?.correctOptionIds ?? []);
          return (
            <fieldset
              key={question.id}
              ref={(node) => {
                questionRefs.current[questionIndex] = node;
              }}
              tabIndex={-1}
              data-step={questionIndex}
              className={`quiz-question${questionIndex === step ? " is-active" : ""}${feedback ? (feedback.correct ? " is-correct" : " is-wrong") : ""}`}
              disabled={locked}
            >
              <legend>
                <span className="quiz-number">{questionIndex + 1}.</span> {question.prompt}
                {question.kind === "multiple" && <span className="quiz-kind">Select all that apply</span>}
              </legend>
              <div className="quiz-options">
                {question.options.map((option) => {
                  const id = `${question.id}-${option.id}`;
                  const checked = (answers[question.id] ?? []).includes(option.id);
                  const revealCorrect = feedback && correctIds.has(option.id);
                  return (
                    <label
                      key={option.id}
                      htmlFor={id}
                      className={`quiz-option${revealCorrect ? " is-answer" : ""}`}
                    >
                      <input
                        id={id}
                        type={question.kind === "single" ? "radio" : "checkbox"}
                        name={question.id}
                        value={option.id}
                        checked={checked}
                        onChange={() => choose(question.id, option.id, question.kind)}
                      />
                      <span>{option.text}</span>
                    </label>
                  );
                })}
              </div>
              {feedback && (
                <p className={`quiz-feedback${feedback.correct ? " is-correct" : " is-wrong"}`}>
                  <strong>{feedback.correct ? "Correct." : "Not quite."}</strong>{" "}
                  {feedback.correct
                    ? ""
                    : `Correct answer: ${question.options
                        .filter((option) => correctIds.has(option.id))
                        .map((option) => option.text)
                        .join(" · ") || "—"}`}
                  {feedback.explanation ? ` ${feedback.explanation}` : ""}
                </p>
              )}
            </fieldset>
          );
        })}

        {error && (
          <p className="quiz-error" role="alert">
            {error}
          </p>
        )}

        <div className="quiz-actions">
          {!isPreview && !result && (
            <span className="quiz-submit-wrap">
              <button type="submit" className="btn primary" disabled={busy} aria-busy={busy}>
                {busy ? "Checking…" : "Submit answers"}
              </button>
            </span>
          )}
          {result && (
            <button type="button" className="btn secondary" onClick={tryAgain}>
              Try again
            </button>
          )}
          {result?.lessonCompleted && result.nextHref && (
            <Link className="btn primary" href={result.nextHref}>
              Continue →
            </Link>
          )}
          {totalQuestions > 1 && (
            <div className="quiz-step-nav" role="group" aria-label="Question steps">
              <button
                type="button"
                className="btn secondary small"
                onClick={() => goStep(step - 1)}
                disabled={step === 0}
                aria-label="Previous question"
              >
                ← Back
              </button>
              <p className="quiz-step-count mono" aria-live="polite">
                Question {step + 1} of {totalQuestions}
              </p>
              {step < lastStep && (
                <button
                  type="button"
                  className="btn secondary small"
                  onClick={() => goStep(step + 1)}
                  aria-label="Next question"
                >
                  Next →
                </button>
              )}
            </div>
          )}
        </div>
      </form>

      <div className="quiz-result" aria-live="polite" role="status">
        {result && (
          <p className={`quiz-result-text${result.passed ? " passed" : " failed"}`}>
            You scored {result.scorePercent}% ({result.correctCount} of {result.totalCount} correct).{" "}
            {result.passed
              ? "You passed."
              : quiz.requirePass
                ? `You need ${quiz.passPercent}% to pass.`
                : "You can try again anytime."}
          </p>
        )}
      </div>
    </section>
  );
}
