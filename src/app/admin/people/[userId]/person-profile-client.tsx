"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, RelativeTime, Textarea } from "../../_ui";
import {
  addPersonTagAction,
  removePersonTagAction,
  savePersonNoteAction,
} from "@/features/people/actions";

// ============================================================================
// Person profile editor (Batch I): tags + private admin note.
// ----------------------------------------------------------------------------
// Local state is the source of truth for instant feedback; every successful
// mutation also calls router.refresh() so the server-rendered sections stay
// in sync (and a full reload shows the same state from the database).
// ============================================================================

export function PersonTags({
  userId,
  initialTags,
}: {
  userId: string;
  initialTags: Array<{ tag: string; source: "quiz" | "admin" }>;
}) {
  const router = useRouter();
  const [tags, setTags] = useState(initialTags);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const tag = input.trim().toLowerCase();
    if (!tag || busy) return;
    setBusy(true);
    setError(null);
    const res = await addPersonTagAction({ userId, tag });
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.error || "Could not add the tag");
      return;
    }
    setInput("");
    setTags((prev) =>
      prev.some((t) => t.tag === res.data!.tag)
        ? prev
        : [...prev, { tag: res.data!.tag, source: "admin" as const }].sort((a, b) =>
            a.tag < b.tag ? -1 : 1,
          ),
    );
    router.refresh();
  };

  const remove = async (tag: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await removePersonTagAction({ userId, tag });
    setBusy(false);
    if (!res.ok) {
      setError(res.error || "Could not remove the tag");
      return;
    }
    setTags((prev) => prev.filter((t) => t.tag !== tag));
    router.refresh();
  };

  return (
    <div>
      {tags.length === 0 ? (
        <p className="muted s-text-sm">No tags yet — quizzes add them automatically, or add one below.</p>
      ) : (
        <ul className="s-row s-gap-8 s-flex-wrap-wrap s-list-none s-padding-0" aria-label="Learner tags">
          {tags.map((t) => (
            <li
              key={t.tag}
              className="lifecycle"
              title={t.source === "quiz" ? "Set automatically by a quiz answer" : "Set by an admin"}
            >
              {t.tag}
              <Button
                className="btn ghost small"
                type="button"
                aria-label={`Remove tag ${t.tag}`}
                disabled={busy}
                onClick={() => void remove(t.tag)}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="s-row s-gap-8 s-margin-top-12 s-flex-wrap-wrap s-align-items-center" onSubmit={(e) => void add(e)}>
        <Input
          className="s-padding-6px-10px s-text-sm s-min-width-200"
          aria-label="Add a tag"
          placeholder="new-tag"
          maxLength={40}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <Button className="btn secondary small" type="submit" disabled={busy || input.trim() === ""}>
          {busy ? "Saving…" : "Add tag"}
        </Button>
      </form>
      <p className="help s-text-xs">Lowercase letters, numbers and dashes · up to 40 characters</p>
      {error && (
        <p className="s-text-sm s-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function PersonNote({
  userId,
  initialNote,
}: {
  userId: string;
  initialNote: { body: string; updatedAt: Date } | null;
}) {
  const router = useRouter();
  const [body, setBody] = useState(initialNote?.body ?? "");
  const [savedAt, setSavedAt] = useState<Date | null>(initialNote?.updatedAt ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await savePersonNoteAction({ userId, body });
    setBusy(false);
    if (!res.ok) {
      setError(res.error || "Could not save the note");
      return;
    }
    if (res.data?.cleared) {
      setBody("");
      setSavedAt(null);
      setNotice("Note cleared.");
    } else {
      setSavedAt(new Date());
      setNotice(null);
    }
    router.refresh();
  };

  return (
    <form onSubmit={(e) => void save(e)}>
      <Textarea
        aria-label="Private admin note"
        placeholder="Private note — only admins ever see this."
        rows={4}
        maxLength={5000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="s-row s-gap-10 s-margin-top-8 s-align-items-center s-flex-wrap-wrap">
        <Button className="btn primary small" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save note"}
        </Button>
        {savedAt && !notice && (
          <span className="a-micro">
            Saved <RelativeTime date={savedAt} now={new Date().getTime()} />
          </span>
        )}
        {notice && (
          <span className="a-micro" role="status">
            {notice}
          </span>
        )}
      </div>
      {error && (
        <p className="s-text-sm s-danger s-margin-top-8" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
