export default function CommerceLoading() {
  return (
    <div style={{ display: "grid", gap: 18 }} aria-busy="true" aria-live="polite">
      <div>
        <h1 className="a-h1" style={{ marginBottom: 6 }}>
          Scheduling & Commerce
        </h1>
        <p className="muted">Loading operational truth…</p>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
        }}
      >
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            style={{
              minHeight: 92,
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-surface)",
              background: "var(--paper-bright)",
              padding: 18,
              opacity: 0.65,
            }}
          >
            <span className="muted" style={{ fontSize: 12 }}>
              Loading…
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
