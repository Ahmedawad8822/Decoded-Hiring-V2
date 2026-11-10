import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { getPublicCertificate } from "@/features/certificates/service";
import { PrintButton } from "./print-button";
import "./certificate.css";

// Same per-request rendering policy as the classroom; no ISR or data cache.
export const dynamic = "force-dynamic";
const lookup = cache(getPublicCertificate);
type Props = { params: Promise<{ certificateId: string }> };
const date = (value: Date) => value.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const certificate = await lookup((await params).certificateId);
  return {
    title: "Course certificate | Decoded Hiring",
    description: "Verify a course certificate issued by Decoded Hiring.",
    robots: { index: false, follow: false },
    openGraph: {
      title: "Course certificate | Decoded Hiring",
      description: certificate ? `${certificate.recipientName} · ${certificate.courseTitle}` : "Certificate verification",
    },
  };
}

export default async function CertificatePage({ params }: Props) {
  const certificate = await lookup((await params).certificateId);
  if (!certificate) notFound();
  return <main id="main" className="certificate-page">
    <article className="certificate-sheet" aria-labelledby="certificate-title">
      <p className="certificate-brand">DECODED HIRING</p>
      <h1 id="certificate-title">Certificate of completion</h1>
      <p>This certifies that</p>
      <p className="certificate-recipient">{certificate.recipientName}</p>
      <p>has completed</p>
      <h2>{certificate.courseTitle}</h2>
      <p>Issued on <time dateTime={certificate.issuedAt.toISOString()}>{date(certificate.issuedAt)}</time></p>
      <p className="certificate-status">{certificate.revokedAt
        ? <>Revoked on <time dateTime={certificate.revokedAt.toISOString()}>{date(certificate.revokedAt)}</time></>
        : "Valid"}</p>
      {certificate.revokedAt && certificate.revokedReason && <p className="certificate-reason">{certificate.revokedReason}</p>}
      <footer><p>Issued by Decoded Hiring</p><p className="certificate-id">Certificate id: {certificate.id}</p></footer>
    </article>
    <PrintButton />
  </main>;
}
