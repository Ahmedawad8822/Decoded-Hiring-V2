"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import qrcode from "qrcode-generator";
import { authClient } from "@/lib/auth/client";

type Step = "idle" | "password" | "enroll" | "codes" | "regenerate" | "disable";

const box: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "12px",
  background: "var(--paper-bright)",
  padding: "24px",
  maxWidth: "560px",
};
const input: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "8px",
  border: "1px solid var(--line-strong)",
  fontSize: "14px",
  background: "var(--paper-bright)",
  width: "100%",
};
const primary: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: "8px",
  background: "var(--ink)",
  color: "var(--paper)",
  fontWeight: 600,
  fontSize: "14px",
  border: "none",
  cursor: "pointer",
};
const secondary: React.CSSProperties = {
  ...primary,
  background: "transparent",
  color: "var(--ink)",
  border: "1px solid var(--line-strong)",
};

/** QR as an SVG data: URI (img-src allows data:, so no CSP change). */
function qrDataUri(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return `data:image/svg+xml;utf8,${encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }))}`;
}

export function SecurityClient({
  enabled,
  required,
  email,
}: {
  enabled: boolean;
  required: boolean;
  email: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [totpUri, setTotpUri] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const secret = useMemo(() => {
    try {
      return new URL(totpUri).searchParams.get("secret") ?? "";
    } catch {
      return "";
    }
  }, [totpUri]);
  const qrSrc = useMemo(() => (totpUri ? qrDataUri(totpUri) : ""), [totpUri]);

  function reset(next: Step) {
    setStep(next);
    setPassword("");
    setCode("");
    setError(null);
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err: unknown) {
      setError((err as Error).message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const startEnroll = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const res = await authClient.twoFactor.enable({ password, method: "totp", issuer: "Decoded Hiring" });
      if (res.error || !res.data || res.data.method !== "totp") {
        setError(res.error?.message || "Could not start enrollment. Check your password.");
        return;
      }
      setTotpUri(res.data.totpURI);
      setBackupCodes(res.data.backupCodes);
      setPassword("");
      setStep("enroll");
    });
  };

  const confirmEnroll = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const res = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (res.error) {
        setError(res.error.message || "That code did not match. Try the next one.");
        return;
      }
      setCode("");
      setStep("codes"); // backup codes are shown once, here
    });
  };

  const regenerate = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const res = await authClient.twoFactor.generateBackupCodes({ password });
      if (res.error || !res.data) {
        setError(res.error?.message || "Could not regenerate backup codes.");
        return;
      }
      setBackupCodes(res.data.backupCodes);
      setPassword("");
      setStep("codes");
    });
  };

  const disable = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const check = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (check.error) {
        setError(check.error.message || "That code did not match.");
        return;
      }
      const res = await authClient.twoFactor.disable({ password });
      if (res.error) {
        setError(res.error.message || "Could not disable two-factor authentication.");
        return;
      }
      reset("idle");
      router.refresh();
    });
  };

  function finish() {
    setBackupCodes([]);
    setTotpUri("");
    reset("idle");
    router.push("/admin/content");
    router.refresh();
  }

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    type = "text",
    extra?: React.InputHTMLAttributes<HTMLInputElement>
  ) => (
    <div style={{ display: "grid", gap: "6px" }}>
      <label htmlFor={id} style={{ fontSize: "12.5px", fontWeight: 600 }}>{label}</label>
      <input id={id} type={type} value={value} onChange={(e) => set(e.target.value)} style={input} {...extra} />
    </div>
  );

  return (
    <main id="main" style={{ padding: "32px 24px" }}>
      <h1 style={{ fontSize: "22px", fontWeight: 600, margin: "0 0 8px" }}>Security</h1>
      <p style={{ color: "var(--muted-strong)", fontSize: "13.5px", lineHeight: 1.6, margin: "0 0 20px" }}>
        Two-factor authentication protects the Studio ({email}) with a code from an authenticator app.
      </p>

      {!enabled && required && step === "idle" && (
        <div role="status" style={{ ...box, marginBottom: "16px", background: "var(--paper-dim)" }}>
          Studio admins must enable two-factor authentication before using the rest of the Studio.
        </div>
      )}

      {error && (
        <div role="alert" style={{ ...box, marginBottom: "16px", color: "#7c2d12", background: "var(--coral-soft, #f5d6cd)" }}>
          {error}
        </div>
      )}

      <section style={box} aria-labelledby="twofa-heading">
        <h2 id="twofa-heading" style={{ fontSize: "16px", fontWeight: 600, margin: "0 0 4px" }}>
          Authenticator app (TOTP)
        </h2>
        <p data-testid="twofa-status" style={{ margin: "0 0 16px", fontSize: "13.5px" }}>
          Status: <strong>{enabled || step === "codes" ? "Enabled" : "Not enabled"}</strong>
        </p>

        {step === "idle" && !enabled && (
          <button type="button" style={primary} onClick={() => reset("password")}>
            Enable two-factor authentication
          </button>
        )}

        {step === "idle" && enabled && (
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <button type="button" style={secondary} onClick={() => reset("regenerate")}>
              Regenerate backup codes
            </button>
            <button type="button" style={secondary} onClick={() => reset("disable")}>
              Disable
            </button>
          </div>
        )}

        {step === "password" && (
          <form onSubmit={startEnroll} style={{ display: "grid", gap: "14px" }}>
            {field("twofa-password", "Confirm your password", password, setPassword, "password", { autoComplete: "current-password", required: true })}
            <div style={{ display: "flex", gap: "12px" }}>
              <button type="submit" style={primary} disabled={busy}>Continue</button>
              <button type="button" style={secondary} onClick={() => reset("idle")}>Cancel</button>
            </div>
          </form>
        )}

        {step === "enroll" && (
          <form onSubmit={confirmEnroll} style={{ display: "grid", gap: "14px" }}>
            <p style={{ margin: 0, fontSize: "13.5px", lineHeight: 1.6 }}>
              Scan this QR code with your authenticator app, or enter the secret manually, then type the 6-digit code it shows.
            </p>
            {qrSrc && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrSrc} alt="TOTP QR code" width={200} height={200} style={{ background: "#fff", border: "1px solid var(--line)" }} />
            )}
            <div style={{ fontSize: "12.5px" }}>
              Manual secret: <code data-testid="twofa-secret" style={{ wordBreak: "break-all" }}>{secret}</code>
            </div>
            <details style={{ fontSize: "12.5px" }}>
              <summary>otpauth URI</summary>
              <code style={{ wordBreak: "break-all" }}>{totpUri}</code>
            </details>
            {field("twofa-verify", "6-digit code", code, setCode, "text", { inputMode: "numeric", autoComplete: "one-time-code", required: true })}
            <div style={{ display: "flex", gap: "12px" }}>
              <button type="submit" style={primary} disabled={busy}>Verify and enable</button>
              <button type="button" style={secondary} onClick={() => reset("idle")}>Cancel</button>
            </div>
          </form>
        )}

        {step === "codes" && (
          <div style={{ display: "grid", gap: "14px" }}>
            <p style={{ margin: 0, fontSize: "13.5px", lineHeight: 1.6 }}>
              Save these backup codes somewhere safe. Each works once if you lose your authenticator. They are shown only now.
            </p>
            <ul data-testid="twofa-backup-codes" style={{ margin: 0, paddingLeft: "18px", fontFamily: "monospace", fontSize: "14px" }}>
              {backupCodes.map((c) => <li key={c}>{c}</li>)}
            </ul>
            <button type="button" style={primary} onClick={finish}>I have saved my codes</button>
          </div>
        )}

        {step === "regenerate" && (
          <form onSubmit={regenerate} style={{ display: "grid", gap: "14px" }}>
            <p style={{ margin: 0, fontSize: "13.5px" }}>This invalidates your previous backup codes.</p>
            {field("twofa-password", "Confirm your password", password, setPassword, "password", { autoComplete: "current-password", required: true })}
            <div style={{ display: "flex", gap: "12px" }}>
              <button type="submit" style={primary} disabled={busy}>Regenerate</button>
              <button type="button" style={secondary} onClick={() => reset("idle")}>Cancel</button>
            </div>
          </form>
        )}

        {step === "disable" && (
          <form onSubmit={disable} style={{ display: "grid", gap: "14px" }}>
            <p style={{ margin: 0, fontSize: "13.5px" }}>
              Enter your password and a current authenticator code.
              {required && " Two-factor is required, so you will need to enroll again to keep using the Studio."}
            </p>
            {field("twofa-password", "Password", password, setPassword, "password", { autoComplete: "current-password", required: true })}
            {field("twofa-disable-code", "6-digit code", code, setCode, "text", { inputMode: "numeric", autoComplete: "one-time-code", required: true })}
            <div style={{ display: "flex", gap: "12px" }}>
              <button type="submit" style={primary} disabled={busy}>Disable two-factor</button>
              <button type="button" style={secondary} onClick={() => reset("idle")}>Cancel</button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
