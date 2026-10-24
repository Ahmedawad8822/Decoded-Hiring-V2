"use client";

import React, { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { safeRedirectPath } from "@/lib/safe-redirect";

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") || "/learn";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email || !password) {
      setError("Please fill in your name, email, and password.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await authClient.signUp.email({ name: name.trim(), email, password });
      if (res.error) {
        setError(res.error.message || "Could not create your account. Please try again.");
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
      <div style={{ width: "100%", maxWidth: "460px" }}>
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-surface, 12px)",
            background: "var(--paper-bright)",
            padding: "clamp(24px, 5vw, 40px)",
          }}
        >
          <h1 className="editorial" style={{ fontSize: "clamp(1.8rem, 1.4rem + 1.6vw, 2.4rem)" }}>
            Create your account.
            <br />
            <em style={{ fontStyle: "italic" }}>Enter the classroom.</em>
          </h1>
          <p className="muted-strong" style={{ marginTop: "10px", fontSize: "14px", lineHeight: 1.6 }}>
            Free courses enroll instantly — no checkout, no card, no waitlist.
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
              <label htmlFor="signup-name" style={{ fontSize: "12.5px", fontWeight: 600 }}>
                Name <span style={{ color: "var(--coral)" }}>*</span>
              </label>
              <input
                id="signup-name"
                type="text"
                required
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="What should the classroom call you?"
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
              <label htmlFor="signup-email" style={{ fontSize: "12.5px", fontWeight: 600 }}>
                Email <span style={{ color: "var(--coral)" }}>*</span>
              </label>
              <input
                id="signup-email"
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
              <label htmlFor="signup-password" style={{ fontSize: "12.5px", fontWeight: 600 }}>
                Password <span style={{ color: "var(--coral)" }}>*</span>
              </label>
              <input
                id="signup-password"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
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
              {loading ? "Creating account..." : "Create account & start free"}
            </button>
          </form>

          <p style={{ fontSize: "12.5px", color: "var(--muted)", marginTop: "20px", textAlign: "center" }}>
            Already learning?{" "}
            <Link
              href="/login"
              style={{ color: "var(--ink)", textDecoration: "underline", textUnderlineOffset: "3px" }}
            >
              Pick up where you left off
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
