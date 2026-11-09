"use client";
import { EmptyState, StatCard, humanLabel, PageHeader, DataTable, StatusPill, Button } from "../_ui";

import { useTransition } from "react";
import Link from "next/link";
import { approveAction, rejectDraftAction, publishDraftAction } from "@/features/editorial-ai/drafts/actions";
import type { DraftSummary } from "@/features/editorial-ai/drafts/types";
import { unwrapActionResult } from "@/lib/action-result";

interface EditorialListClientProps {
  initialDrafts: DraftSummary[];
}

export function EditorialListClient({ initialDrafts }: EditorialListClientProps) {
  const [isPending] = useTransition();

  async function handleApprove(id: string) {
    try {
      unwrapActionResult(await approveAction(id));
      window.location.reload();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function handlePublish(id: string) {
    try {
      unwrapActionResult(await publishDraftAction(id));
      window.location.reload();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function handleReject(id: string) {
    const reason = prompt("Rejection reason (optional):");
    if (reason === null) return;
    try {
      unwrapActionResult(await rejectDraftAction(id, { note: reason || undefined }));
      window.location.reload();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  const pendingCount = initialDrafts.filter((d) => d.status === "IN_REVIEW").length;
  const approvedCount = initialDrafts.filter((d) => d.status === "APPROVED").length;

  return (
    <div >

      <PageHeader eyebrow="Editorial AI" title="Editorial Drafts" description="Turn your knowledge into a draft worth refining. Every piece stays in your hands." action={<Link href="/admin/editorial/new" className="btn primary">+ New Generation</Link>} />
      <div className="stat-grid">
        <StatCard icon="content" label="All drafts" value={initialDrafts.length} />
        <StatCard icon="clock" label="In review" value={pendingCount} attention />
        <StatCard icon="check" label="Approved" value={approvedCount} />
      </div>

      {initialDrafts.length === 0 ? (
        <EmptyState icon="sparkles" title="Your next draft starts with a spark" action={<Link href="/admin/editorial/new" className="btn primary">New AI draft</Link>}>Create with the knowledge you’ve collected.</EmptyState>
      ) : (
        <DataTable className="s-full s-text-sm" >
          <thead>
            <tr>
              <th className="s-text-align-left s-padding-8px" >Title</th>
              <th className="s-text-align-left s-padding-8px" >Type</th>
              <th className="s-text-align-left s-padding-8px" >Status</th>
              <th className="s-text-align-left s-padding-8px" >Skill</th>
              <th className="s-text-align-left s-padding-8px" >Created</th>
              <th className="s-text-align-right s-padding-8px" >Actions</th>
            </tr>
          </thead>
          <tbody>
            {initialDrafts.map((draft) => (
              <tr key={draft.id}>
                <td className="s-padding-8px" >
                  <Link href={`/admin/editorial/${draft.id}`} >{draft.title}</Link>
                </td>
                <td className="s-padding-8px" >{humanLabel(draft.contentType)}</td>
                <td className="s-padding-8px" >
                  <StatusPill >{draft.status}</StatusPill>
                </td>
                <td className="s-padding-8px s-text-sm" >{draft.skillId}</td>
                <td className="s-padding-8px s-text-sm" >{new Date(draft.createdAt).toLocaleDateString()}</td>
                <td className="s-padding-8px s-text-align-right" >
                  {draft.status === "IN_REVIEW" && (
                    <>
                      <Button className="s-margin-right-4px s-padding-4px-8px s-text-xs s-muted btn primary" onClick={() => handleApprove(draft.id)} disabled={isPending} >Approve</Button>
                      <Button className="s-margin-right-4px s-padding-4px-8px s-text-xs s-muted btn danger" onClick={() => handleReject(draft.id)} disabled={isPending} >Reject</Button>
                    </>
                  )}
                  {draft.status === "APPROVED" && (
                    <Button className="s-padding-4px-8px s-text-xs s-muted btn primary" onClick={() => handlePublish(draft.id)} disabled={isPending} >Publish</Button>
                  )}
                  {draft.status === "PUBLISHED" && draft.publishedEntityId && (
                    <a className="s-text-xs s-muted" href={`/admin/content`} >Published</a>
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
