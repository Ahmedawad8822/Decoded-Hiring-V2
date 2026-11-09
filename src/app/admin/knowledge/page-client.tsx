"use client";
import { EmptyState, PageHeader, FileDrop, Input, Textarea, Button, DataTable, StatusPill } from "../_ui";

import { useState, useRef, useTransition } from "react";
import { ingestKnowledgeAction, archiveKnowledgeAction, reingestKnowledgeAction, deleteKnowledgeAction } from "@/features/editorial-ai/knowledge/actions";
import type { KnowledgeSource } from "@/lib/db";
import { unwrapActionResult } from "@/lib/action-result";

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
      setUploadSuccess(`Uploaded source (ID: ${data.id})`);
      // Reset form fields — wrapped so a reset() edge-case can never block
      // the page reload that refreshes the source list.
      try {
        if (fileInputRef.current) fileInputRef.current.value = "";
        e.currentTarget.reset();
      } catch {
        /* reset is best-effort; reload below refreshes the list */
      }
      // Reload to show the updated source list
      window.location.reload();
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleIngest(id: string) {
    startTransition(() => {
      setActionError(null);
    });
    try {
      unwrapActionResult(await ingestKnowledgeAction(id));
      window.location.reload();
    } catch (err) {
      startTransition(() => {
        setActionError((err as Error).message);
      });
    }
  }

  async function handleArchive(id: string) {
    if (!confirm("Archive this knowledge source? It will be removed from retrieval.")) return;
    startTransition(() => {
      setActionError(null);
    });
    try {
      unwrapActionResult(await archiveKnowledgeAction(id));
      window.location.reload();
    } catch (err) {
      startTransition(() => {
        setActionError((err as Error).message);
      });
    }
  }

  async function handleReingest(id: string) {
    startTransition(() => {
      setActionError(null);
    });
    try {
      unwrapActionResult(await reingestKnowledgeAction(id));
      window.location.reload();
    } catch (err) {
      startTransition(() => {
        setActionError((err as Error).message);
      });
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Permanently delete this source? This cannot be undone.")) return;
    startTransition(() => {
      setActionError(null);
    });
    try {
      unwrapActionResult(await deleteKnowledgeAction(id));
      window.location.reload();
    } catch (err) {
      startTransition(() => {
        setActionError((err as Error).message);
      });
    }
  }

  return (
    <div >
      <PageHeader eyebrow="Editorial AI" title={<>Knowledge Library</>} />
      <p className="s-muted s-margin-bottom-24px" >Build the source library behind your editorial drafts.</p>

      {/* Upload form */}
      <div className="s-padding-20px s-margin-bottom-24px ui-card" >
        <h2 className="s-margin-bottom-12px" >Upload New Source</h2>
        <form id="knowledge-upload" onSubmit={handleUpload}>
          <div className="s-stack s-columns-2 s-gap-12px" >
            <div>
              <label htmlFor="knowledge-field-4605" className="s-block s-text-sm s-margin-bottom-4px" >File *</label>
              <FileDrop id="knowledge-field-4605" className="s-full" aria-label="File" ref={fileInputRef} type="file" name="file" accept=".txt,.md,text/plain,text/markdown" required disabled={uploading} />
            </div>
            <div>
              <label htmlFor="knowledge-field-4930" className="s-block s-text-sm s-margin-bottom-4px" >Title *</label>
              <Input id="knowledge-field-4930" className="s-full s-padding-8px" type="text" name="title" placeholder="e.g. Structured hiring interview evidence guide" required disabled={uploading} />
            </div>
            <div>
              <label htmlFor="knowledge-field-5321" className="s-block s-text-sm s-margin-bottom-4px" >Author</label>
              <Input id="knowledge-field-5321" className="s-full s-padding-8px" type="text" name="author" placeholder="Optional" disabled={uploading} />
            </div>
            <div>
              <label htmlFor="knowledge-field-5671" className="s-block s-text-sm s-margin-bottom-4px" >Source Label</label>
              <Input id="knowledge-field-5671" className="s-full s-padding-8px" type="text" name="sourceLabel" placeholder="e.g. Internal docs, Meeting notes" disabled={uploading} />
            </div>
          </div>
          <div className="s-margin-top-12px" >
            <label htmlFor="knowledge-field-6085" className="s-block s-text-sm s-margin-bottom-4px" >Notes</label>
            <Textarea id="knowledge-field-6085" className="s-full s-padding-8px s-resize-vertical" name="notes" placeholder="Any context for this source" rows={3} disabled={uploading} />
          </div>
          {uploadError && <p className="s-danger s-margin-top-8px" >{uploadError}</p>}
          {uploadSuccess && <p className="s-success s-margin-top-8px" >{uploadSuccess}</p>}
          <Button className="s-margin-top-12px s-padding-8px-16px s-muted btn primary" type="submit" disabled={uploading} >
            {uploading ? "Uploading..." : "Upload Source"}
          </Button>
        </form>
      </div>

      {actionError && <p className="s-danger s-margin-bottom-12px" >{actionError}</p>}

      {/* Source list */}
      <h2 className="s-margin-bottom-12px" >Sources</h2>
      {sources.length === 0 ? (
        <EmptyState icon="knowledge" title="Give your ideas a foundation" action={<a href="#knowledge-upload" className="btn primary">Upload a source</a>}>Add your first source above to start your library.</EmptyState>
      ) : (
        <DataTable className="s-full" >
          <thead>
            <tr>
              <th className="s-text-align-left s-padding-8px s-text-sm" >Title</th>
              <th className="s-text-align-left s-padding-8px s-text-sm" >Status</th>
              <th className="s-text-align-left s-padding-8px s-text-sm" >Chunks</th>
              <th className="s-text-align-left s-padding-8px s-text-sm" >Created</th>
              <th className="s-text-align-right s-padding-8px s-text-sm" >Actions</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td className="s-padding-8px" >
                  <a href={`/admin/knowledge/${s.id}`} >{s.title}</a>
                </td>
                <td className="s-padding-8px" >
                  <StatusPill >{s.status}</StatusPill>
                </td>
                <td className="s-padding-8px s-text-sm" >{s.chunkCount}</td>
                <td className="s-padding-8px s-text-sm" >{new Date(s.createdAt).toLocaleDateString()}</td>
                <td className="s-padding-8px s-text-align-right" >
                  {s.status === "UPLOADED" && (
                    <Button className="s-margin-right-4px s-padding-4px-8px s-text-sm s-muted btn primary" onClick={() => handleIngest(s.id)} disabled={isPending} >Ingest</Button>
                  )}
                  {(s.status === "READY" || s.status === "FAILED") && (
                    <Button className="s-margin-right-4px s-padding-4px-8px s-text-sm s-muted btn primary" onClick={() => handleReingest(s.id)} disabled={isPending} >Reingest</Button>
                  )}
                  {s.status !== "ARCHIVED" && s.status !== "UPLOADED" && (
                    <Button className="s-margin-right-4px s-padding-4px-8px s-text-sm s-muted btn primary" onClick={() => handleArchive(s.id)} disabled={isPending} >Archive</Button>
                  )}
                  {s.status !== "READY" && s.status !== "ARCHIVED" && s.status !== "INGESTING" && (
                    <Button className="s-padding-4px-8px s-text-sm s-muted btn danger" onClick={() => handleDelete(s.id)} disabled={isPending} >Delete</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
