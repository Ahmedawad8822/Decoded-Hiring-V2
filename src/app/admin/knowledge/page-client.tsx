"use client";

import { useState, useRef, useTransition } from "react";
import { ingestKnowledgeAction, archiveKnowledgeAction, reingestKnowledgeAction, deleteKnowledgeAction } from "@/features/editorial-ai/knowledge/actions";
import type { KnowledgeSource } from "@/lib/db";

interface KnowledgePageClientProps {
  initialSources: KnowledgeSource[];
  user: { id: string; name?: string | null; email?: string | null; role?: string | null };
}

export function KnowledgePageClient({ initialSources }: KnowledgePageClientProps) {
  const [sources] = useState(initialSources);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setUploading(true);
    setUploadError(null);
    setUploadSuccess(null);

    const formData = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/editorial-ai/knowledge/upload", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Upload failed");
      }
      const data = await res.json();
      setUploadSuccess(`Uploaded "${data.title}" (ID: ${data.id})`);
      e.currentTarget.reset();
      if (fileInputRef.current) fileInputRef.current.value = "";
      // Refresh the list
      const updated = await fetch("/admin/knowledge", { method: "GET" }).catch(() => null);
      if (updated) {
        window.location.reload();
      } else {
        window.location.reload();
      }
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleIngest(id: string) {
    setActionError(null);
    startTransition(async () => {
      try {
        await ingestKnowledgeAction(id);
        window.location.reload();
      } catch (err) {
        setActionError((err as Error).message);
      }
    });
  }

  async function handleArchive(id: string) {
    if (!confirm("Archive this knowledge source? It will be removed from retrieval.")) return;
    setActionError(null);
    startTransition(async () => {
      try {
        await archiveKnowledgeAction(id);
        window.location.reload();
      } catch (err) {
        setActionError((err as Error).message);
      }
    });
  }

  async function handleReingest(id: string) {
    setActionError(null);
    startTransition(async () => {
      try {
        await reingestKnowledgeAction(id);
        window.location.reload();
      } catch (err) {
        setActionError((err as Error).message);
      }
    });
  }

  async function handleDelete(id: string) {
    if (!confirm("Permanently delete this source? This cannot be undone.")) return;
    setActionError(null);
    startTransition(async () => {
      try {
        await deleteKnowledgeAction(id);
        window.location.reload();
      } catch (err) {
        setActionError((err as Error).message);
      }
    });
  }

  const statusColors: Record<string, string> = {
    UPLOADED: "#6b7280",
    INGESTING: "#f59e0b",
    READY: "#10b981",
    FAILED: "#ef4444",
    ARCHIVED: "#6b7280",
  };

  return (
    <div style={{ padding: "24px", maxWidth: "1200px" }}>
      <h1 style={{ fontSize: "28px", marginBottom: "8px" }}>Knowledge Library</h1>
      <p style={{ color: "#6b7280", marginBottom: "24px" }}>Upload, ingest, and manage editorial knowledge sources.</p>

      {/* Upload form */}
      <div style={{ border: "1px solid var(--ink-border, #e5e7eb)", borderRadius: "8px", padding: "20px", marginBottom: "24px" }}>
        <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>Upload New Source</h2>
        <form onSubmit={handleUpload}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>File *</label>
              <input ref={fileInputRef} type="file" name="file" accept=".txt,.md,text/plain,text/markdown" required disabled={uploading} style={{ width: "100%" }} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>Title *</label>
              <input type="text" name="title" placeholder="e.g. Build system optimization guide" required disabled={uploading} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px" }} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>Author</label>
              <input type="text" name="author" placeholder="Optional" disabled={uploading} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px" }} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>Source Label</label>
              <input type="text" name="sourceLabel" placeholder="e.g. Internal docs, Meeting notes" disabled={uploading} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px" }} />
            </div>
          </div>
          <div style={{ marginTop: "12px" }}>
            <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>Notes</label>
            <textarea name="notes" placeholder="Any context for this source" rows={3} disabled={uploading} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px", resize: "vertical" }} />
          </div>
          {uploadError && <p style={{ color: "#ef4444", marginTop: "8px" }}>{uploadError}</p>}
          {uploadSuccess && <p style={{ color: "#10b981", marginTop: "8px" }}>{uploadSuccess}</p>}
          <button type="submit" disabled={uploading} style={{ marginTop: "12px", padding: "8px 16px", background: "#3b82f6", color: "white", border: "none", borderRadius: "4px", cursor: uploading ? "not-allowed" : "pointer" }}>
            {uploading ? "Uploading..." : "Upload Source"}
          </button>
        </form>
      </div>

      {actionError && <p style={{ color: "#ef4444", marginBottom: "12px" }}>{actionError}</p>}

      {/* Source list */}
      <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>Sources</h2>
      {sources.length === 0 ? (
        <p style={{ color: "#6b7280" }}>No knowledge sources yet. Upload one above.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb", fontSize: "13px" }}>Title</th>
              <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb", fontSize: "13px" }}>Status</th>
              <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb", fontSize: "13px" }}>Chunks</th>
              <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb", fontSize: "13px" }}>Created</th>
              <th style={{ textAlign: "right", padding: "8px", borderBottom: "2px solid #e5e7eb", fontSize: "13px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb" }}>
                  <a href={`/admin/knowledge/${s.id}`} style={{ fontWeight: 500, textDecoration: "none" }}>{s.title}</a>
                </td>
                <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb" }}>
                  <span style={{ color: statusColors[s.status] || "#6b7280", fontWeight: 600, fontSize: "12px" }}>{s.status}</span>
                </td>
                <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>{s.chunkCount}</td>
                <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb", fontSize: "13px" }}>{new Date(s.createdAt).toLocaleDateString()}</td>
                <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb", textAlign: "right" }}>
                  {s.status === "UPLOADED" && (
                    <button onClick={() => handleIngest(s.id)} disabled={isPending} style={{ marginRight: "4px", padding: "4px 8px", fontSize: "12px", background: "#10b981", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Ingest</button>
                  )}
                  {(s.status === "READY" || s.status === "FAILED") && (
                    <button onClick={() => handleReingest(s.id)} disabled={isPending} style={{ marginRight: "4px", padding: "4px 8px", fontSize: "12px", background: "#3b82f6", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Reingest</button>
                  )}
                  {s.status !== "ARCHIVED" && s.status !== "UPLOADED" && (
                    <button onClick={() => handleArchive(s.id)} disabled={isPending} style={{ marginRight: "4px", padding: "4px 8px", fontSize: "12px", background: "#f59e0b", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Archive</button>
                  )}
                  {s.status !== "READY" && s.status !== "ARCHIVED" && s.status !== "INGESTING" && (
                    <button onClick={() => handleDelete(s.id)} disabled={isPending} style={{ padding: "4px 8px", fontSize: "12px", background: "#ef4444", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
