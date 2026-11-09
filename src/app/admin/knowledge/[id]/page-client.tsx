"use client";
import { PageHeader, DataTable, StatusPill, Button } from "../../_ui";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ingestKnowledgeAction, archiveKnowledgeAction, reingestKnowledgeAction, deleteKnowledgeAction } from "@/features/editorial-ai/knowledge/actions";
import type { KnowledgeSource } from "@/lib/db";
import type { ChunkView } from "@/features/editorial-ai/knowledge/retrieval";
import { unwrapActionResult, type ActionResult } from "@/lib/action-result";

interface KnowledgeDetailClientProps {
  source: KnowledgeSource;
  chunks: ChunkView[];
}

export function KnowledgeDetailClient({ source, chunks }: KnowledgeDetailClientProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function runAction(fn: (id: string) => Promise<ActionResult<unknown>>, label: string) {
    startTransition(() => {
      setActionError(null);
      setActionSuccess(null);
    });
    try {
      unwrapActionResult(await fn(source.id));
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
    <div >
      <Link className="s-muted s-text-sm" href="/admin/knowledge" >&larr; Back to Library</Link>
      <PageHeader eyebrow="Editorial AI" title={<>{source.title}</>} />

      <div className="s-stack s-columns-2 s-gap-24px" >
        {/* Metadata */}
        <div>
          <h2 className="s-margin-bottom-12px" >Metadata</h2>
          <DataTable className="s-full s-text-sm" >
            <tbody>
              <tr><td className="s-padding-4px-0 s-muted" >Status</td><td className="s-padding-4px-0 s-bold" ><StatusPill >{source.status}</StatusPill></td></tr>
              <tr><td className="s-padding-4px-0 s-muted" >Type</td><td className="s-padding-4px-0" >{source.sourceType}</td></tr>
              <tr><td className="s-padding-4px-0 s-muted" >MIME</td><td className="s-padding-4px-0" >{source.mimeType}</td></tr>
              <tr><td className="s-padding-4px-0 s-muted" >Original Filename</td><td className="s-padding-4px-0" >{source.originalFilename}</td></tr>
              <tr><td className="s-padding-4px-0 s-muted" >Author</td><td className="s-padding-4px-0" >{source.author || "-"}</td></tr>
              <tr><td className="s-padding-4px-0 s-muted" >Source Label</td><td className="s-padding-4px-0" >{source.sourceLabel || "-"}</td></tr>
              <tr><td className="s-padding-4px-0 s-muted" >Size</td><td className="s-padding-4px-0" >{(source.byteSize / 1024).toFixed(1)} KB</td></tr>
              <tr><td className="s-padding-4px-0 s-muted" >Checksum</td><td className="s-padding-4px-0 s-text-xs" >{source.checksum}</td></tr>
              <tr><td className="s-padding-4px-0 s-muted" >Chunk Count</td><td className="s-padding-4px-0" >{source.chunkCount}</td></tr>
              <tr><td className="s-padding-4px-0 s-muted" >Uploaded</td><td className="s-padding-4px-0" >{new Date(source.createdAt).toLocaleString()}</td></tr>
              {source.ingestedAt && (<tr><td className="s-padding-4px-0 s-muted" >Ingested</td><td className="s-padding-4px-0" >{new Date(source.ingestedAt).toLocaleString()}</td></tr>)}
              {source.notes && (<tr><td className="s-padding-4px-0 s-muted" >Notes</td><td className="s-padding-4px-0" >{source.notes}</td></tr>)}
            </tbody>
          </DataTable>

          {/* Actions */}
          <div className="s-margin-top-20px s-row s-gap-8px s-flex-wrap-wrap" >
            {source.status === "UPLOADED" && (
              <Button className="s-padding-6px-12px s-text-sm s-muted btn primary" onClick={() => runAction(ingestKnowledgeAction, "Ingested")} disabled={isPending} >Ingest</Button>
            )}
            {(source.status === "READY" || source.status === "FAILED") && (
              <Button className="s-padding-6px-12px s-text-sm s-muted btn primary" onClick={() => runAction(reingestKnowledgeAction, "Re-ingested")} disabled={isPending} >Re-ingest</Button>
            )}
            {source.status !== "ARCHIVED" && (
              <Button className="s-padding-6px-12px s-text-sm s-muted btn primary" onClick={() => runAction(archiveKnowledgeAction, "Archived")} disabled={isPending || source.status === "INGESTING"} >Archive</Button>
            )}
            {source.status === "ARCHIVED" && source.chunkCount === 0 && (
              <Button className="s-padding-6px-12px s-text-sm s-muted btn danger" onClick={() => runAction(deleteKnowledgeAction, "Deleted")} disabled={isPending} >Delete</Button>
            )}
          </div>
          {actionError && <p className="s-danger s-margin-top-8px s-text-sm" >{actionError}</p>}
          {actionSuccess && <p className="s-success s-margin-top-8px s-text-sm" >{actionSuccess}</p>}
        </div>

        {/* Chunks preview */}
        <div>
          <h2 className="s-margin-bottom-12px" >Chunks ({chunks.length})</h2>
          {chunks.length === 0 ? (
            <p className="s-muted s-text-sm" >
              {source.status === "READY"
                ? "No chunks found. Re-ingest to regenerate."
                : source.status === "UPLOADED"
                  ? "Not yet ingested. Click 'Ingest' above."
                  : source.status === "INGESTING"
                    ? "Ingestion in progress..."
                    : "No chunks available."}
            </p>
          ) : (
            <div className="s-max-height-400px s-overflow-auto" >
              {chunks.map((chunk) => (
                <div className="s-padding-8px-12px s-text-sm" key={chunk.id} >
                  <div className="s-row s-justify-content-space-between s-margin-bottom-4px" >
                    <strong>Chunk {chunk.ordinal}</strong>
                    {chunk.heading && <span className="s-muted" >{chunk.heading}</span>}
                    <span className="s-muted s-text-xs" >{chunk.characterCount} chars</span>
                  </div>
                  <div className="s-muted s-white-space-pre-wrap s-text-xs s-max-height-80px s-overflow-hidden" >{chunk.content.slice(0, 200)}...</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
