"use client";

import { useEffect, useState } from "react";

function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

// Renders an instant in the LEARNER's own timezone: SSR paints the UTC date,
// then hydration swaps in the browser-timezone rendering (suppressHydrationWarning
// covers the intentional first-paint difference).
export function LocalDate({ iso, prefix }: { iso: string; prefix?: string }) {
  const [local, setLocal] = useState<string | null>(null);
  // Intentional one-time post-hydration swap: SSR paints UTC (matching the
  // server markup), then the browser timezone rendering takes over. Not a
  // data-fetch cascade — there is no server state to subscribe to.
  useEffect(() => {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocal(
        new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        }).format(date),
      );
    }
  }, [iso]);
  return (
    <span suppressHydrationWarning>
      {prefix ? `${prefix} ` : null}
      {local ?? formatUtc(iso)}
    </span>
  );
}
