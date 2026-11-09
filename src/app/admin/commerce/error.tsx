"use client";
import { PageHeader, Button } from "../_ui";

export default function CommerceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="s-padding-24 s-stack s-gap-12 s-max-width-720"
      role="alert"

    >
      <PageHeader eyebrow="Studio" title={<>
        Bookings & offers is unavailable
      </>} />
      <p className="muted s-margin-0" >
        The operational view could not be loaded. No booking, payment or provider
        state was changed.
      </p>
      {error.digest && (
        <p className="muted s-margin-0 s-text-sm" >
          Reference: {error.digest}
        </p>
      )}
      <Button className="btn secondary small s-justify-self-start" type="button" onClick={reset} >
        Retry
      </Button>
    </div>
  );
}
