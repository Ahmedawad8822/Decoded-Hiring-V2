import Link from "next/link";
import { safeRedirectPath } from "@/lib/safe-redirect";

// Better Auth's /api/auth/verify-email redirects here: with `?error=` when the
// link is expired or invalid, otherwise after marking the email verified and
// signing the learner in (autoSignInAfterVerification).
export default async function EmailVerifiedPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeRedirectPath(typeof params.next === "string" ? params.next : null);
  const failed = typeof params.error === "string" && params.error.length > 0;

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
          {failed ? (
            <>
              <h1 className="editorial" style={{ fontSize: "clamp(1.8rem, 1.4rem + 1.6vw, 2.4rem)" }}>
                This link has expired.
              </h1>
              <p className="muted-strong" style={{ marginTop: "10px", fontSize: "14px", lineHeight: 1.6 }}>
                Verification links work for 1 hour and only once. Sign in with your email and password and
                we&rsquo;ll send you a fresh link.
              </p>
              <Link
                href={`/login?redirect=${encodeURIComponent(next)}`}
                className="btn primary wide"
                style={{ display: "block", textAlign: "center", marginTop: "20px", padding: "12px", borderRadius: "8px", background: "var(--ink)", color: "var(--paper)", fontWeight: 600, fontSize: "14px" }}
              >
                Sign in
              </Link>
            </>
          ) : (
            <>
              <h1 className="editorial" style={{ fontSize: "clamp(1.8rem, 1.4rem + 1.6vw, 2.4rem)" }}>
                Your email is verified.
              </h1>
              <p className="muted-strong" style={{ marginTop: "10px", fontSize: "14px", lineHeight: 1.6 }}>
                Thanks for confirming. Your account is ready.
              </p>
              <Link
                href={next}
                className="btn primary wide"
                style={{ display: "block", textAlign: "center", marginTop: "20px", padding: "12px", borderRadius: "8px", background: "var(--ink)", color: "var(--paper)", fontWeight: 600, fontSize: "14px" }}
              >
                Continue to your courses
              </Link>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
