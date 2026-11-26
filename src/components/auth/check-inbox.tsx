"use client";

import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth/client";

/** Where verification links land; `next` is re-validated on that page. */
export function verificationCallbackURL(next: string): string {
  return `/email-verified?next=${encodeURIComponent(next)}`;
}

/**
 * Shown after sign-up, and after signing in to an unverified account: the
 * account cannot be used until the emailed link is clicked.
 */
export function CheckInbox({
  email,
  next,
  intro,
  sendOnMount = false,
}: {
  email: string;
  next: string;
  intro: string;
  /** Request a fresh link immediately (the sign-in path; sign-up already sent one). */
  sendOnMount?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const sentOnMount = useRef(false);

  const resend = async () => {
    setStatus("sending");
    try {
      const res = await authClient.sendVerificationEmail({ email, callbackURL: verificationCallbackURL(next) });
      setStatus(res.error ? "error" : "sent");
    } catch {
      setStatus("error");
    }
  };

  useEffect(() => {
    if (!sendOnMount || sentOnMount.current) return;
    sentOnMount.current = true;
    void resend();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  return (
    <div role="status" aria-live="polite" style={{ marginTop: "16px", display: "grid", gap: "14px" }}>
      <div
        style={{
          padding: "12px 14px",
          borderRadius: "8px",
          background: "#e6f4ea",
          color: "#1e4620",
          fontSize: "13.5px",
          lineHeight: 1.6,
          border: "1px solid rgba(52, 168, 83, 0.4)",
        }}
      >
        {intro} We sent a verification link to <strong>{email}</strong>. Click it to finish setting up your
        account. The link works for 1 hour.
      </div>
      <p className="muted-strong" style={{ fontSize: "13px", lineHeight: 1.6 }}>
        Nothing there? Check your spam folder, or send a new link.
      </p>
      <button
        type="button"
        onClick={resend}
        disabled={status === "sending"}
        className="btn wide"
        style={{
          padding: "11px",
          borderRadius: "8px",
          border: "1px solid var(--line-strong)",
          background: "var(--paper-bright)",
          color: "var(--ink)",
          fontWeight: 600,
          fontSize: "14px",
          cursor: status === "sending" ? "wait" : "pointer",
        }}
      >
        {status === "sending" ? "Sending..." : "Send a new link"}
      </button>
      {status === "sent" && (
        <p style={{ fontSize: "13px", color: "#1e4620" }}>A new link is on its way.</p>
      )}
      {status === "error" && (
        <p style={{ fontSize: "13px", color: "#7c2d12" }}>
          We couldn&rsquo;t send a new link right now. Please wait a minute and try again.
        </p>
      )}
    </div>
  );
}
