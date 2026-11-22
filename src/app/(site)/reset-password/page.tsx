"use client";

import React, { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth/client";

// Mirrors the existing credential policy (signup page + Better Auth default):
// at least 8 characters.
const MIN_PASSWORD_LENGTH = 8;

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <InvalidToken message="This reset link is missing its token. Links expire after 1 hour and can only be used once." />
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setStatus("saving");
    setError(null);
    let succeeded = false;
    try {
      const res = await authClient.resetPassword({ newPassword: password, token });
      if (res.error) {
        setError(
          /invalid|expired|token/i.test(res.error.message || "")
            ? "invalid-token"
            : res.error.message || "Could not update your password. Please try again.",
        );
      } else {
        succeeded = true;
        setStatus("done");
      }
    } catch (err: unknown) {
      setError((err as Error).message || "An unexpected error occurred.");
    } finally {
      if (!succeeded) setStatus("idle");
    }
  };

  if (status === "done") {
    return (
      <div>
        <h1 className="editorial" style={{ fontSize: "clamp(1.8rem, 1.4rem + 1.6vw, 2.4rem)" }}>
          Password updated.
        </h1>
        <div
          role="status"
          aria-live="polite"
          style={{
            marginTop: "16px",
            padding: "10px 14px",
            borderRadius: "8px",
            background: "#e6f4ea",
            color: "#1e4620",
            fontSize: "13px",
            border: "1px solid rgba(52, 168, 83, 0.4)",
          }}
        >
          Your password has been changed. All other sessions were signed out.
        </div>
        <p style={{ fontSize: "13px", marginTop: "20px", textAlign: "center" }}>
          <Link
            href="/login"
            style={{ color: "var(--ink)", textDecoration: "underline", textUnderlineOffset: "3px" }}
          >
            Log in with your new password →
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="editorial" style={{ fontSize: "clamp(1.8rem, 1.4rem + 1.6vw, 2.4rem)" }}>
        Choose a new password.
      </h1>
      <p className="muted-strong" style={{ marginTop: "10px", fontSize: "14px", lineHeight: 1.6 }}>
        At least {MIN_PASSWORD_LENGTH} characters. Your other sessions will be signed out.
      </p>

      {error && error !== "invalid-token" && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            marginTop: "16px",
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
      {error === "invalid-token" && (
        <InvalidToken message="This reset link is invalid or has expired. Links expire after 1 hour and can only be used once." />
      )}

      {error !== "invalid-token" && (
        <form onSubmit={handleSubmit} style={{ display: "grid", gap: "16px", marginTop: "20px" }}>
          <div style={{ display: "grid", gap: "6px" }}>
            <label htmlFor="reset-password" style={{ fontSize: "12.5px", fontWeight: 600 }}>
              New password <span style={{ color: "var(--coral)" }}>*</span>
            </label>
            <input
              id="reset-password"
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              style={{
                padding: "10px 14px",
                borderRadius: "8px",
                border: "1px solid var(--line-strong)",
                fontSize: "14px",
                background: "var(--paper-bright)",
              }}
            />
          </div>

          <div style={{ display: "grid", gap: "6px" }}>
            <label htmlFor="reset-confirm" style={{ fontSize: "12.5px", fontWeight: 600 }}>
              Confirm new password <span style={{ color: "var(--coral)" }}>*</span>
            </label>
            <input
              id="reset-confirm"
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat your new password"
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
            disabled={status === "saving"}
            className="btn primary wide"
            style={{
              marginTop: "8px",
              padding: "12px",
              borderRadius: "8px",
              background: "var(--ink)",
              color: "var(--paper)",
              fontWeight: 600,
              fontSize: "14px",
              cursor: status === "saving" ? "wait" : "pointer",
              border: "none",
            }}
          >
            {status === "saving" ? "Updating..." : "Update password"}
          </button>
        </form>
      )}
    </div>
  );
}

function InvalidToken({ message }: { message: string }) {
  return (
    <div>
      <h1 className="editorial" style={{ fontSize: "clamp(1.8rem, 1.4rem + 1.6vw, 2.4rem)" }}>
        That link didn&rsquo;t work.
      </h1>
      <div
        role="alert"
        style={{
          marginTop: "16px",
          padding: "10px 14px",
          borderRadius: "8px",
          background: "var(--coral-soft, #f5d6cd)",
          color: "#7c2d12",
          fontSize: "13px",
          border: "1px solid rgba(235, 116, 94, 0.4)",
        }}
      >
        {message}
      </div>
      <p style={{ fontSize: "13px", marginTop: "20px", textAlign: "center" }}>
        <Link
          href="/forgot-password"
          style={{ color: "var(--ink)", textDecoration: "underline", textUnderlineOffset: "3px" }}
        >
          Request a new reset link →
        </Link>
      </p>
    </div>
  );
}

export default function ResetPasswordPage() {
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
          <Suspense>
            <ResetPasswordForm />
          </Suspense>
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
