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

  const handleDevQuickFill = () => {
    setEmail("ahmed@decodedhiring.local");
    setPassword("Ahmed-Decoded-Dev-2026!");
    setError(null);
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

          <h1 style={{ fontSize: "22px", fontWeight: 600, margin: "0 0 8px" }}>Studio sign-in</h1>
          <p style={{ color: "var(--muted-strong)", fontSize: "13.5px", lineHeight: 1.6, margin: 0 }}>
            Staff &amp; editorial access. Sign in with your registered admin credentials to manage guides and publishing.
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

          {/* Development quick-fill (guarded strictly by environment check per Correction 7) */}
          {process.env.NODE_ENV === "development" && (
            <div
              style={{
                marginTop: "20px",
                paddingTop: "16px",
                borderTop: "1px dashed var(--line)",
                textAlign: "center",
              }}
            >
              <button
                type="button"
                onClick={handleDevQuickFill}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--blue)",
                  fontSize: "12px",
                  cursor: "pointer",
                  textDecoration: "underline",
                  textUnderlineOffset: "3px",
                }}
              >
                ⚡ Dev: Fill Local Admin Credentials
              </button>
            </div>
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
