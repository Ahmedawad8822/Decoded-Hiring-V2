"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ingestKnowledgeAction, archiveKnowledgeAction, reingestKnowledgeAction, deleteKnowledgeAction } from "@/features/editorial-ai/knowledge/actions";
import type { KnowledgeSource } from "@/lib/db";
import type { ChunkView } from "@/features/editorial-ai/knowledge/retrieval";

interface KnowledgeDetailClientProps {
  source: KnowledgeSource;
  chunks: ChunkView[];
}

export function KnowledgeDetailClient({ source, chunks }: KnowledgeDetailClientProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const statusColors: Record<string, string> = {
    UPLOADED: "#6b7280",
    INGESTING: "#f59e0b",
    READY: "#10b981",
    FAILED: "#ef4444",
    ARCHIVED: "#6b7280",
  };

  async function runAction(fn: (id: string) => Promise<unknown>, label: string) {
    startTransition(() => {
      setActionError(null);
      setActionSuccess(null);
    });
    try {
      await fn(source.id);
      startTransition(() => {
        setActionSuccess(`${label} completed`);
      });
      window.location.reload();
    } catch (err) {
      startTransition(() => {
        setActionError((err as Error).message);
      });
    }
  }

  return (
    <div style={{ padding: "24px", maxWidth: "1200px" }}>
      <Link href="/admin/knowledge" style={{ color: "#6b7280", fontSize: "13px", textDecoration: "none" }}>&larr; Back to Library</Link>
      <h1 style={{ fontSize: "24px", marginTop: "8px", marginBottom: "16px" }}>{source.title}</h1>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
        {/* Metadata */}
        <div>
          <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>Metadata</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <tbody>
              <tr><td style={{ padding: "4px 0", color: "#6b7280" }}>Status</td><td style={{ padding: "4px 0", fontWeight: 600 }}><span style={{ color: statusColors[source.status] || "#6b7280" }}>{source.status}</span></td></tr>
              <tr><td style={{ padding: "4px 0", color: "#6b7280" }}>Type</td><td style={{ padding: "4px 0" }}>{source.sourceType}</td></tr>
              <tr><td style={{ padding: "4px 0", color: "#6b7280" }}>MIME</td><td style={{ padding: "4px 0" }}>{source.mimeType}</td></tr>
              <tr><td style={{ padding: "4px 0", color: "#6b7280" }}>Original Filename</td><td style={{ padding: "4px 0" }}>{source.originalFilename}</td></tr>
              <tr><td style={{ padding: "4px 0", color: "#6b7280" }}>Author</td><td style={{ padding: "4px 0" }}>{source.author || "-"}</td></tr>
              <tr><td style={{ padding: "4px 0", color: "#6b7280" }}>Source Label</td><td style={{ padding: "4px 0" }}>{source.sourceLabel || "-"}</td></tr>
              <tr><td style={{ padding: "4px 0", color: "#6b7280" }}>Size</td><td style={{ padding: "4px 0" }}>{(source.byteSize / 1024).toFixed(1)} KB</td></tr>
              <tr><td style={{ padding: "4px 0", color: "#6b7280" }}>Checksum</td><td style={{ padding: "4px 0", fontFamily: "monospace", fontSize: "11px" }}>{source.checksum}</td></tr>
              <tr><td style={{ padding: "4px 0", color: "#6b7280" }}>Chunk Count</td><td style={{ padding: "4px 0" }}>{source.chunkCount}</td></tr>
              <tr><td style={{ padding: "4px 0", color: "#6b7280" }}>Uploaded</td><td style={{ padding: "4px 0" }}>{new Date(source.createdAt).toLocaleString()}</td></tr>
              {source.ingestedAt && (<tr><td style={{ padding: "4px 0", color: "#6b7280" }}>Ingested</td><td style={{ padding: "4px 0" }}>{new Date(source.ingestedAt).toLocaleString()}</td></tr>)}
              {source.notes && (<tr><td style={{ padding: "4px 0", color: "#6b7280" }}>Notes</td><td style={{ padding: "4px 0" }}>{source.notes}</td></tr>)}
            </tbody>
          </table>

          {/* Actions */}
          <div style={{ marginTop: "20px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {source.status === "UPLOADED" && (
              <button onClick={() => runAction(ingestKnowledgeAction, "Ingested")} disabled={isPending} style={{ padding: "6px 12px", fontSize: "13px", background: "#10b981", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Ingest</button>
            )}
            {(source.status === "READY" || source.status === "FAILED") && (
              <button onClick={() => runAction(reingestKnowledgeAction, "Re-ingested")} disabled={isPending} style={{ padding: "6px 12px", fontSize: "13px", background: "#3b82f6", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Re-ingest</button>
            )}
            {source.status !== "ARCHIVED" && (
              <button onClick={() => runAction(archiveKnowledgeAction, "Archived")} disabled={isPending || source.status === "INGESTING"} style={{ padding: "6px 12px", fontSize: "13px", background: "#f59e0b", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Archive</button>
            )}
            {source.status === "ARCHIVED" && source.chunkCount === 0 && (
              <button onClick={() => runAction(deleteKnowledgeAction, "Deleted")} disabled={isPending} style={{ padding: "6px 12px", fontSize: "13px", background: "#ef4444", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Delete</button>
            )}
          </div>
          {actionError && <p style={{ color: "#ef4444", marginTop: "8px", fontSize: "13px" }}>{actionError}</p>}
          {actionSuccess && <p style={{ color: "#10b981", marginTop: "8px", fontSize: "13px" }}>{actionSuccess}</p>}
        </div>

        {/* Chunks preview */}
        <div>
          <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>Chunks ({chunks.length})</h2>
          {chunks.length === 0 ? (
            <p style={{ color: "#6b7280", fontSize: "13px" }}>
              {source.status === "READY"
                ? "No chunks found. Re-ingest to regenerate."
                : source.status === "UPLOADED"
                ? "Not yet ingested. Click 'Ingest' above."
                : source.status === "INGESTING"
                ? "Ingestion in progress..."
                : "No chunks available."}
            </p>
          ) : (
            <div style={{ maxHeight: "400px", overflow: "auto", border: "1px solid #e5e7eb", borderRadius: "4px" }}>
              {chunks.map((chunk) => (
                <div key={chunk.id} style={{ padding: "8px 12px", borderBottom: "1px solid #e5e7eb", fontSize: "12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <strong>Chunk {chunk.ordinal}</strong>
                    {chunk.heading && <span style={{ color: "#6b7280" }}>{chunk.heading}</span>}
                    <span style={{ color: "#6b7280", fontFamily: "monospace", fontSize: "10px" }}>{chunk.characterCount} chars</span>
                  </div>
                  <div style={{ color: "#374151", whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "10px", maxHeight: "80px", overflow: "hidden" }}>{chunk.content.slice(0, 200)}...</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
