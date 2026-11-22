"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteLessonNoteAction, saveLessonNoteAction } from "@/features/notes/actions";
import { NOTE_MAX_BODY, normalizeNoteBody } from "@/features/notes/constants";

function formatSavedTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

export function LessonNotesPanel({
  courseSlug,
  lessonSlug,
  initialBody,
  initialUpdatedAt,
}: {
  courseSlug: string;
  lessonSlug: string;
  initialBody: string;
  initialUpdatedAt: string | null;
}) {
  const router = useRouter();
  const [body, setBody] = useState(initialBody);
  const [savedBody, setSavedBody] = useState(initialBody);
  const [savedAt, setSavedAt] = useState<string | null>(initialUpdatedAt);
  const [hasSaved, setHasSaved] = useState(Boolean(initialBody));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = body !== savedBody;

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const handleSave = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const response = await saveLessonNoteAction({ courseSlug, lessonSlug, body });
      if (!response.ok) {
        setError(response.error || "Could not save your note");
        return;
      }
      const normalized = normalizeNoteBody(body);
      setBody(normalized);
      setSavedBody(normalized);
      setSavedAt(response.data?.updatedAt ?? null);
      setHasSaved(Boolean(normalized));
      router.refresh();
    } catch {
      setError("Could not save your note. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (busy) return;
    if (!window.confirm("Delete this note? This cannot be undone.")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await deleteLessonNoteAction({ courseSlug, lessonSlug });
      if (!response.ok) {
        setError(response.error || "Could not delete your note");
        return;
      }
      setBody("");
      setSavedBody("");
      setSavedAt(null);
      setHasSaved(false);
      router.refresh();
    } catch {
      setError("Could not delete your note. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void handleSave();
    }
  };

  const status = error
    ? error
    : dirty
      ? "Unsaved changes"
      : savedAt && hasSaved
        ? `Saved · ${formatSavedTime(savedAt)}`
        : hasSaved
          ? "Saved"
          : "No note yet";

  return (
    <section className="notes-section learner-mt-36" aria-labelledby="lesson-notes-heading">
      <div className="notes-head">
        <div>
          <p className="a-micro learner-mb-10">MY NOTES</p>
          <h2 className="a-h2" id="lesson-notes-heading">
            Notes for this lesson
          </h2>
        </div>
        <p className="notes-private">Private to you</p>
      </div>

      <div className="notes-field">
        <label className="notes-label" htmlFor="lesson-note-body">
          Your note
        </label>
        <textarea
          id="lesson-note-body"
          className="notes-textarea"
          value={body}
          maxLength={NOTE_MAX_BODY}
          onChange={(event) => {
            setBody(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          aria-describedby="lesson-note-hint lesson-note-counter"
        />
        <div className="notes-meta">
          <p id="lesson-note-hint" className="notes-hint">
            Plain text only. Saving an empty note deletes it.
          </p>
          <p id="lesson-note-counter" className="notes-counter mono">
            {normalizeNoteBody(body).length.toLocaleString("en-US")} / {NOTE_MAX_BODY.toLocaleString("en-US")}
          </p>
        </div>
      </div>

      <div className="notes-actions">
        <button type="button" className="btn primary" onClick={handleSave} disabled={busy}>
          {busy ? "Saving…" : "Save note"}
        </button>
        <button
          type="button"
          className="btn secondary"
          onClick={handleDelete}
          disabled={busy || !hasSaved}
        >
          Delete note
        </button>
      </div>

      <p
        className={`notes-status${error ? " is-error" : ""}`}
        aria-live="polite"
      >
        {status}
      </p>
    </section>
  );
}
