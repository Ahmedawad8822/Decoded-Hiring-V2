"use client";

export default function CommerceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-surface)",
        background: "var(--paper-bright)",
        padding: 24,
        display: "grid",
        gap: 12,
        maxWidth: 720,
      }}
    >
      <h1 className="a-h1" style={{ margin: 0 }}>
        Scheduling & Commerce is unavailable
      </h1>
      <p className="muted" style={{ margin: 0 }}>
        The operational view could not be loaded. No booking, payment or provider
        state was changed.
      </p>
      <p style={{ margin: 0, fontSize: 12 }}>
        {error.message || "Unexpected Studio error."}
      </p>
      <button className="btn secondary small" type="button" onClick={reset} style={{ justifySelf: "start" }}>
        Retry
      </button>
    </div>
  );
}
