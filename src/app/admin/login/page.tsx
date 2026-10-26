"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // G3: set once sign-in returned the 2FA challenge (password already accepted).
  const [challenge, setChallenge] = useState(false);
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError(useBackup ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator app.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = useBackup
        ? await authClient.twoFactor.verifyBackupCode({ code: trimmed })
        : await authClient.twoFactor.verifyTotp({ code: trimmed });
      if (res.error) {
        setError(res.error.message || "That code did not work. Please try again.");
      } else {
        router.push("/admin/content");
        router.refresh();
      }
    } catch (err: unknown) {
      setError((err as Error).message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await authClient.signIn.email({
        email,
        password,
      });

      if (res.error) {
        setError(res.error.message || "Invalid credentials. Please try again.");
      } else if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
        setChallenge(true);
        setPassword("");
      } else {
        router.push("/admin/content");
        router.refresh();
      }
    } catch (err: unknown) {
      setError((err as Error).message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1px solid var(--line-strong)",
    fontSize: "14px",
    background: "var(--paper-bright)",
  };
  const buttonStyle: React.CSSProperties = {
    marginTop: "8px",
    padding: "12px",
    borderRadius: "8px",
    background: "var(--ink)",
    color: "var(--paper)",
    fontWeight: 600,
    fontSize: "14px",
    cursor: loading ? "wait" : "pointer",
    border: "none",
  };

  return (
    <main
      id="main"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "24px",
        background: "var(--paper-dim)",
      }}
    >
      <div style={{ width: "100%", maxWidth: "420px" }}>
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-surface, 12px)",
            background: "var(--paper-bright)",
            padding: "clamp(24px, 5vw, 40px)",
          }}
        >
          <div style={{ marginBottom: "28px" }}>
            <Link
              href="/"
              style={{
                textDecoration: "none",
                display: "inline-flex",
                flexDirection: "column",
                color: "var(--ink)",
              }}
            >
              <strong style={{ fontSize: "16px", fontWeight: 700 }}>Ahmed Awad</strong>
              <span
                style={{
                  fontSize: "9px",
                  letterSpacing: ".12em",
                  color: "var(--muted)",
                  fontWeight: 600,
                }}
              >
                HIRING, DECODED
              </span>
            </Link>
          </div>

          <h1 style={{ fontSize: "22px", fontWeight: 600, margin: "0 0 8px" }}>
            {challenge ? "Two-factor verification" : "Studio sign-in"}
          </h1>
          <p style={{ color: "var(--muted-strong)", fontSize: "13.5px", lineHeight: 1.6, margin: 0 }}>
            {challenge
              ? useBackup
                ? "Enter one of your single-use backup codes."
                : "Enter the 6-digit code from your authenticator app."
              : "Staff & editorial access. Sign in with your registered admin credentials to manage guides and publishing."}
          </p>

          {error && (
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
              {error}
            </div>
          )}

          {challenge ? (
            <form onSubmit={handleVerify} style={{ display: "grid", gap: "16px", marginTop: "20px" }}>
              <div style={{ display: "grid", gap: "6px" }}>
                <label htmlFor="twofa-code" style={{ fontSize: "12.5px", fontWeight: 600 }}>
                  {useBackup ? "Backup code" : "Authentication code"}
                </label>
                <input
                  id="twofa-code"
                  type="text"
                  inputMode={useBackup ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={useBackup ? "xxxxx-xxxxx" : "123456"}
                  style={inputStyle}
                />
              </div>
              <button type="submit" disabled={loading} className="btn primary wide" style={buttonStyle}>
                {loading ? "Verifying..." : "Verify and continue"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setUseBackup(!useBackup);
                  setCode("");
                  setError(null);
                }}
                style={{ background: "none", border: "none", color: "var(--ink)", textDecoration: "underline", textUnderlineOffset: "3px", fontSize: "12.5px", cursor: "pointer" }}
              >
                {useBackup ? "Use authenticator app instead" : "Use a backup code"}
              </button>
            </form>
          ) : (
          <form onSubmit={handleSubmit} style={{ display: "grid", gap: "16px", marginTop: "20px" }}>
            <div style={{ display: "grid", gap: "6px" }}>
              <label htmlFor="email" style={{ fontSize: "12.5px", fontWeight: 600 }}>
                Admin Email <span style={{ color: "var(--coral)" }}>*</span>
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@decodedhiring.local"
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
              <label htmlFor="password" style={{ fontSize: "12.5px", fontWeight: 600 }}>
                Password <span style={{ color: "var(--coral)" }}>*</span>
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
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
              disabled={loading}
              className="btn primary wide"
              style={{
                marginTop: "8px",
                padding: "12px",
                borderRadius: "8px",
                background: "var(--ink)",
                color: "var(--paper)",
                fontWeight: 600,
                fontSize: "14px",
                cursor: loading ? "wait" : "pointer",
                border: "none",
              }}
            >
              {loading ? "Signing in..." : "Sign in to Studio"}
            </button>
          </form>
          )}

          <p style={{ fontSize: "12px", color: "var(--muted)", marginTop: "18px", textAlign: "center" }}>
            Learner?{" "}
            <Link href="/" style={{ color: "var(--ink)", textDecoration: "underline", textUnderlineOffset: "3px" }}>
              Return to public website →
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
