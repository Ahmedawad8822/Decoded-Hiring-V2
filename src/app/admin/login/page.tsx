"use client";
import { PageHeader, Input, Button } from "../_ui";

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

  return (
    <main className="login-main"
      id="main"

    >
      <div className="login-wrap" >
        <div className="login-card"

        >
          <Link href="/" className="login-brand"><strong>Decoded<span className="s-accent">.</span></strong><span>Studio</span></Link>

          <PageHeader eyebrow="Studio" title={<>
            {challenge ? "Two-factor verification" : "Studio sign-in"}
          </>} />
          <p className="s-muted s-text-sm s-line-height-1-6 s-margin-0" >
            {challenge
              ? useBackup
                ? "Enter one of your single-use backup codes."
                : "Enter the 6-digit code from your authenticator app."
              : "Your ideas, courses, and conversations. All in one workspace."}
          </p>

          {error && (
            <div className="s-margin-top-16px s-padding-10px-14px s-danger s-text-sm"
              role="alert"

            >
              {error}
            </div>
          )}

          {challenge ? (
            <form className="s-stack s-gap-16px s-margin-top-20px" onSubmit={handleVerify} >
              <div className="s-stack s-gap-6px" >
                <label className="s-text-sm s-bold" htmlFor="twofa-code" >
                  {useBackup ? "Backup code" : "Authentication code"}
                </label>
                <Input className="ui-input"
                  id="twofa-code"
                  type="text"
                  inputMode={useBackup ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={useBackup ? "xxxxx-xxxxx" : "123456"}

                />
              </div>
              <Button type="submit" disabled={loading} className="btn primary wide btn primary" >
                {loading ? "Verifying..." : "Verify and continue"}
              </Button>
              <Button className="s-text-sm btn primary"
                type="button"
                onClick={() => {
                  setUseBackup(!useBackup);
                  setCode("");
                  setError(null);
                }}

              >
                {useBackup ? "Use authenticator app instead" : "Use a backup code"}
              </Button>
            </form>
          ) : (
            <form className="s-stack s-gap-16px s-margin-top-20px" onSubmit={handleSubmit} >
              <div className="s-stack s-gap-6px" >
                <label className="s-text-sm s-bold" htmlFor="email" >
                  Admin Email <span className="s-danger" >*</span>
                </label>
                <Input className="s-padding-10px-14px s-text-sm"
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@decodedhiring.local"

                />
              </div>

              <div className="s-stack s-gap-6px" >
                <label className="s-text-sm s-bold" htmlFor="password" >
                  Password <span className="s-danger" >*</span>
                </label>
                <Input className="s-padding-10px-14px s-text-sm"
                  id="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"

                />
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="btn primary wide s-margin-top-8px s-padding-12px s-bold s-text-sm btn primary"

              >
                {loading ? "Signing in..." : "Sign in to Studio"}
              </Button>
            </form>
          )}

          <p className="s-text-sm s-muted s-margin-top-18px s-text-align-center" >
            Learner?{" "}
            <Link href="/" >
              Return to public website →
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
