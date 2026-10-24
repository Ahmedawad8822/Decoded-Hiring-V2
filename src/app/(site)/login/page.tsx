"use client";

import React, { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { safeRedirectPath } from "@/lib/safe-redirect";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") || "/learn";
  const forbidden = searchParams.get("error") === "forbidden";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    forbidden ? "That account does not have access here. Please sign in with a learner account." : null
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await authClient.signIn.email({ email, password });
      if (res.error) {
        setError(res.error.message || "Invalid credentials. Please try again.");
      } else {
        router.push(safeRedirectPath(redirect));
        router.refresh();
      }
    } catch (err: unknown) {
      setError((err as Error).message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
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
            Pick up where you left off.
          </h1>
          <p className="muted-strong" style={{ marginTop: "10px", fontSize: "14px", lineHeight: 1.6 }}>
            Sign in with your email and password — the classroom remembers your place.
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
              <label htmlFor="login-email" style={{ fontSize: "12.5px", fontWeight: 600 }}>
                Email <span style={{ color: "var(--coral)" }}>*</span>
              </label>
              <input
                id="login-email"
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

            <div style={{ display: "grid", gap: "6px" }}>
              <label htmlFor="login-password" style={{ fontSize: "12.5px", fontWeight: 600 }}>
                Password <span style={{ color: "var(--coral)" }}>*</span>
              </label>
              <input
                id="login-password"
                type="password"
                required
                autoComplete="current-password"
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
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <p style={{ fontSize: "12.5px", color: "var(--muted)", marginTop: "20px", textAlign: "center" }}>
            New here?{" "}
            <Link
              href="/signup"
              style={{ color: "var(--ink)", textDecoration: "underline", textUnderlineOffset: "3px" }}
            >
              Create a free account
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

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
