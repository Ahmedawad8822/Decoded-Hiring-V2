"use client";

import React, { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";

// The response is identical whether or not the address has an account
// (Better Auth is already generic here; this page never adds a distinction).
const GENERIC_MESSAGE = "If an account exists for that email, we've sent a reset link.";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setError("Please enter your email address.");
      return;
    }
    setStatus("sending");
    setError(null);
    try {
      await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    } catch {
      // Network failure: still show the generic message so the page never
      // reveals whether the address has an account.
    }
    setStatus("done");
  };

  return (
    <main
      id="main"
      style={{
        minHeight: "70vh",
        display: "grid",
        placeItems: "center",
        padding: "clamp(24px, 5vw, 48px) 24px",
      }}
    >
      <div style={{ width: "100%", maxWidth: "440px" }}>
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-surface, 12px)",
            background: "var(--paper-bright)",
            padding: "clamp(24px, 5vw, 40px)",
          }}
        >
          <h1 className="editorial" style={{ fontSize: "clamp(1.8rem, 1.4rem + 1.6vw, 2.4rem)" }}>
            Reset your password.
          </h1>
          <p className="muted-strong" style={{ marginTop: "10px", fontSize: "14px", lineHeight: 1.6 }}>
            Enter the email you signed up with and we&rsquo;ll send you a reset link.
          </p>

          {(error || status === "done") && (
            <div role="alert" aria-live="assertive" style={{ marginTop: "16px" }}>
              {error && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "8px",
                    background: "var(--coral-soft, #f5d6cd)",
                    color: "#7c2d12",
                    fontSize: "13px",
                    border: "1px solid rgba(235, 116, 94, 0.4)",
                  }}
                >
                  {error}
                </div>
              )}
              {status === "done" && !error && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "8px",
                    background: "#e6f4ea",
                    color: "#1e4620",
                    fontSize: "13px",
                    border: "1px solid rgba(52, 168, 83, 0.4)",
                  }}
                >
                  {GENERIC_MESSAGE}
                </div>
              )}
            </div>
          )}

          {status !== "done" && (
            <form onSubmit={handleSubmit} style={{ display: "grid", gap: "16px", marginTop: "20px" }}>
              <div style={{ display: "grid", gap: "6px" }}>
                <label htmlFor="forgot-email" style={{ fontSize: "12.5px", fontWeight: 600 }}>
                  Email <span style={{ color: "var(--coral)" }}>*</span>
                </label>
                <input
                  id="forgot-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  style={{
                    padding: "10px 14px",
                    borderRadius: "8px",
                    border: "1px solid var(--line-strong)",
                    fontSize: "14px",
                    background: "var(--paper-bright)",
                  }}
                />
              </div>

              <button
                type="submit"
                disabled={status === "sending"}
                className="btn primary wide"
                style={{
                  marginTop: "8px",
                  padding: "12px",
                  borderRadius: "8px",
                  background: "var(--ink)",
                  color: "var(--paper)",
                  fontWeight: 600,
                  fontSize: "14px",
                  cursor: status === "sending" ? "wait" : "pointer",
                  border: "none",
                }}
              >
                {status === "sending" ? "Sending..." : "Send reset link"}
              </button>
            </form>
          )}

          <p style={{ fontSize: "12.5px", color: "var(--muted)", marginTop: "20px", textAlign: "center" }}>
            Remembered it?{" "}
            <Link
              href="/login"
              style={{ color: "var(--ink)", textDecoration: "underline", textUnderlineOffset: "3px" }}
            >
              Back to sign in
            </Link>
          </p>
        </div>
        <p style={{ fontSize: "11.5px", color: "var(--muted)", textAlign: "center", marginTop: "16px" }}>
          <Link href="/" style={{ textDecoration: "underline", textUnderlineOffset: "3px" }}>
            ← Back to decodedhiring.com
          </Link>
        </p>
      </div>
    </main>
  );
}
