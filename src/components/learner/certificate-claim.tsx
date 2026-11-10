"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { claimCertificateAction } from "@/features/certificates/actions";

export function CertificateClaim({ courseSlug, accountName }: { courseSlug: string; accountName: string }) {
  const router = useRouter();
  const [name, setName] = useState(accountName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <form onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await claimCertificateAction({ courseSlug, recipientName: name });
      if (!result.ok) setError(result.error);
      else router.push(`/certificates/${result.data.id}`);
    } finally { setBusy(false); }
  }}>
    <label className="learner-section-title">Name on certificate
      <input name="recipientName" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={80} autoComplete="name" />
    </label>
    <p>Please check the spelling. Contact the course team for corrections after issue.</p>
    {error && <p role="alert">{error}</p>}
    <button className="btn primary" disabled={busy}>{busy ? "Issuing…" : "Get your certificate"}</button>
  </form>;
}
