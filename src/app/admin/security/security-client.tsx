"use client";
import { Input, PageHeader, Button } from "../_ui";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

type Step = "idle" | "password" | "enroll" | "codes" | "regenerate" | "disable";

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
  const [qrSrc, setQrSrc] = useState("");
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
      // Load before enabling TOTP so a chunk-load failure leaves enrollment untouched.
      const { default: qrcode } = await import("qrcode-generator");
      const res = await authClient.twoFactor.enable({ password, method: "totp", issuer: "Decoded Hiring" });
      if (res.error || !res.data || res.data.method !== "totp") {
        setError(res.error?.message || "Could not start enrollment. Check your password.");
        return;
      }
      const qr = qrcode(0, "M");
      qr.addData(res.data.totpURI);
      qr.make();
      // SVG data: URI (img-src allows data:, so no CSP change).
      setQrSrc(`data:image/svg+xml;utf8,${encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }))}`);
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
    setQrSrc("");
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
    <div className="s-stack s-gap-6px" >
      <label className="s-text-sm s-bold" htmlFor={id} >{label}</label>
      <Input className="ui-input" id={id} type={type} value={value} onChange={(e) => set(e.target.value)}  {...extra} />
    </div>
  );

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Admin" title={<>Security</>} />
      <p className="s-muted s-text-sm s-line-height-1-6 s-margin-0-0-20px" >
        Two-factor authentication protects the Studio ({email}) with a code from an authenticator app.
      </p>

      {!enabled && required && step === "idle" && (
        <div className="ui-card security-card s-margin-bottom-16px" role="status" >
          Studio admins must enable two-factor authentication before using the rest of the Studio.
        </div>
      )}

      {error && (
        <div className="ui-card security-card s-margin-bottom-16px s-danger" role="alert" >
          {error}
        </div>
      )}

      <section className="ui-card security-card" aria-labelledby="twofa-heading">
        <h2 className="s-bold s-margin-0-0-4px" id="twofa-heading" >
          Authenticator app (TOTP)
        </h2>
        <p className="s-margin-0-0-16px s-text-sm" data-testid="twofa-status" >
          Status: <strong>{enabled || step === "codes" ? "Enabled" : "Not enabled"}</strong>
        </p>

        {step === "idle" && !enabled && (
          <Button className="btn primary" type="button" onClick={() => reset("password")}>
            Enable two-factor authentication
          </Button>
        )}

        {step === "idle" && enabled && (
          <div className="s-row s-gap-12px s-flex-wrap-wrap" >
            <Button className="btn secondary" type="button" onClick={() => reset("regenerate")}>
              Regenerate backup codes
            </Button>
            <Button className="btn secondary" type="button" onClick={() => reset("disable")}>
              Disable
            </Button>
          </div>
        )}

        {step === "password" && (
          <form className="s-stack s-gap-14px" onSubmit={startEnroll} >
            {field("twofa-password", "Confirm your password", password, setPassword, "password", { autoComplete: "current-password", required: true })}
            <div className="s-row s-gap-12px" >
              <Button className="btn primary" type="submit" disabled={busy}>Continue</Button>
              <Button className="btn secondary" type="button" onClick={() => reset("idle")}>Cancel</Button>
            </div>
          </form>
        )}

        {step === "enroll" && (
          <form className="s-stack s-gap-14px" onSubmit={confirmEnroll} >
            <p className="s-margin-0 s-text-sm s-line-height-1-6" >
              Scan this QR code with your authenticator app, or enter the secret manually, then type the 6-digit code it shows.
            </p>
            {qrSrc && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrSrc} alt="TOTP QR code" width={200} height={200} />
            )}
            <div className="s-text-sm" >
              Manual secret: <code className="s-word-break-break-all" data-testid="twofa-secret" >{secret}</code>
            </div>
            <details className="s-text-sm" >
              <summary>otpauth URI</summary>
              <code className="s-word-break-break-all" >{totpUri}</code>
            </details>
            {field("twofa-verify", "6-digit code", code, setCode, "text", { inputMode: "numeric", autoComplete: "one-time-code", required: true })}
            <div className="s-row s-gap-12px" >
              <Button className="btn primary" type="submit" disabled={busy}>Verify and enable</Button>
              <Button className="btn secondary" type="button" onClick={() => reset("idle")}>Cancel</Button>
            </div>
          </form>
        )}

        {step === "codes" && (
          <div className="s-stack s-gap-14px" >
            <p className="s-margin-0 s-text-sm s-line-height-1-6" >
              Save these backup codes somewhere safe. Each works once if you lose your authenticator. They are shown only now.
            </p>
            <ul className="s-margin-0 s-padding-left-18px s-text-sm" data-testid="twofa-backup-codes" >
              {backupCodes.map((c) => <li key={c}>{c}</li>)}
            </ul>
            <Button className="btn primary" type="button" onClick={finish}>I have saved my codes</Button>
          </div>
        )}

        {step === "regenerate" && (
          <form className="s-stack s-gap-14px" onSubmit={regenerate} >
            <p className="s-margin-0 s-text-sm" >This invalidates your previous backup codes.</p>
            {field("twofa-password", "Confirm your password", password, setPassword, "password", { autoComplete: "current-password", required: true })}
            <div className="s-row s-gap-12px" >
              <Button className="btn primary" type="submit" disabled={busy}>Regenerate</Button>
              <Button className="btn secondary" type="button" onClick={() => reset("idle")}>Cancel</Button>
            </div>
          </form>
        )}

        {step === "disable" && (
          <form className="s-stack s-gap-14px" onSubmit={disable} >
            <p className="s-margin-0 s-text-sm" >
              Enter your password and a current authenticator code.
              {required && " Two-factor is required, so you will need to enroll again to keep using the Studio."}
            </p>
            {field("twofa-password", "Password", password, setPassword, "password", { autoComplete: "current-password", required: true })}
            {field("twofa-disable-code", "6-digit code", code, setCode, "text", { inputMode: "numeric", autoComplete: "one-time-code", required: true })}
            <div className="s-row s-gap-12px" >
              <Button className="btn primary" type="submit" disabled={busy}>Disable two-factor</Button>
              <Button className="btn secondary" type="button" onClick={() => reset("idle")}>Cancel</Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
