"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminCertificateRow } from "@/features/certificates/service";
import { mutateCertificateAction } from "@/features/certificates/actions";
import { Button, Card, EmptyState, Input } from "../../../_ui";

function CertificateRow({ certificate }: { certificate: AdminCertificateRow }) {
  const router = useRouter();
  const [name, setName] = useState(certificate.recipientName);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (input: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const result = await mutateCertificateAction(input);
      if (!result.ok) setError(result.error);
      else router.refresh();
    } finally { setBusy(false); }
  };
  return <Card className="s-padding-22px-24px s-stack s-gap-14">
    <h2>{certificate.recipientName}</h2>
    <p>Issued {certificate.issuedAt.toLocaleDateString("en-GB", { timeZone: "UTC" })} · {certificate.revokedAt ? "Revoked" : "Valid"}</p>
    {certificate.revokedAt && <p>{certificate.revokedReason}</p>}
    <Link href={`/certificates/${certificate.id}`}>Verify certificate</Link>
    {error && <p role="alert">{error}</p>}
    <form className="s-stack s-gap-14" onSubmit={(event) => {
      event.preventDefault();
      void run({ id: certificate.id, operation: "edit", recipientName: name });
    }}>
      <label>Edit recipient name
        <Input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={80} />
      </label>
      <Button type="submit" disabled={busy}>Save recipient name</Button>
    </form>
    {certificate.revokedAt
      ? <Button disabled={busy} onClick={() => void run({ id: certificate.id, operation: "restore" })}>Restore</Button>
      : <form className="s-stack s-gap-14" onSubmit={(event) => {
        event.preventDefault();
        void run({ id: certificate.id, operation: "revoke", reason });
      }}>
        <label>Revocation reason
          <Input value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={200} />
        </label>
        <Button type="submit" variant="danger" disabled={busy}>Revoke</Button>
      </form>}
  </Card>;
}

export function CertificatesClient({ certificates }: { certificates: AdminCertificateRow[] }) {
  return <div className="s-stack s-gap-16 s-margin-top-20">
    {certificates.length === 0 && <EmptyState icon="courses" title="No certificates issued yet" />}
    {certificates.map((certificate) => <CertificateRow key={certificate.id} certificate={certificate} />)}
  </div>;
}
