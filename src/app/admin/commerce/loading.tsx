
import { PageHeader } from "../_ui";
export default function CommerceLoading() {
  return (
    <div className="s-stack s-gap-18" aria-busy="true" aria-live="polite">
      <div>
        <PageHeader eyebrow="Studio" title={<>
          Scheduling & Commerce
        </>} />
        <p className="muted">Loading operational truth…</p>
      </div>
      <div className="s-stack s-columns-auto s-gap-12"

      >
        {Array.from({ length: 6 }, (_, index) => (
          <div className="s-min-height-92 s-padding-18 s-opacity-0-65 ui-card"
            key={index}

          >
            <span className="muted s-text-sm" >
              Loading…
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
