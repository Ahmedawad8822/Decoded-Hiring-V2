"use client";
import { humanLabel, PageHeader, StatusPill, DataTable, Button, Input, Textarea } from "../../_ui";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  submitForReviewAction,
  sendBackAction,
  approveAction,
  rejectDraftAction,
  recoverRejectedAction,
  publishDraftAction,
  updateDraftAction,
} from "@/features/editorial-ai/drafts/actions";
import type { EditorialDraftWithSources, UpdateDraftInput } from "@/features/editorial-ai/drafts/types";
import type { LlmBlock } from "@/features/editorial-ai/skills/types";
import { unwrapActionResult, type ActionResult } from "@/lib/action-result";

interface DraftDetailClientProps {
  draft: EditorialDraftWithSources;
}

export function DraftDetailClient({ draft }: DraftDetailClientProps) {
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  async function runAction(fn: (id: string, input?: { note?: string }) => Promise<ActionResult<unknown>>, label: string, input?: { note?: string }) {
    startTransition(() => {
      setActionError(null);
      setActionSuccess(null);
    });
    try {
      unwrapActionResult(await fn(draft.id, input));
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

  async function handlePublish() {
    startTransition(() => {
      setActionError(null);
      setActionSuccess(null);
    });
    try {
      const result = unwrapActionResult(await publishDraftAction(draft.id));
      startTransition(() => {
        setActionSuccess(`Published as ${result.entityType} (${result.entityId})`);
      });
      window.location.reload();
    } catch (err) {
      startTransition(() => {
        setActionError((err as Error).message);
      });
    }
  }

  async function handleEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(() => {
      setActionError(null);
      setActionSuccess(null);
    });
    const formData = new FormData(e.currentTarget);
    const input: UpdateDraftInput = {
      title: (formData.get("title") as string) || undefined,
      excerpt: (formData.get("excerpt") as string) || undefined,
      metaTitle: (formData.get("metaTitle") as string) || undefined,
      metaDescription: (formData.get("metaDescription") as string) || undefined,
    };
    try {
      unwrapActionResult(await updateDraftAction(draft.id, input));
      startTransition(() => {
        setActionSuccess("Draft updated");
        setIsEditing(false);
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
      <Link className="s-muted s-text-sm" href="/admin/editorial" >Back to Drafts</Link>

      {/* Header */}
      <div className="s-row s-justify-content-space-between s-align-items-flex-start s-margin-top-12px s-margin-bottom-16px" >
        <div>
          <PageHeader eyebrow="Editorial AI" title={<>{draft.title}</>} />
          <p className="s-muted s-text-sm" >Slug: <code>{draft.slug}</code></p>
        </div>
        <StatusPill >
          {draft.status}
        </StatusPill>
      </div>

      {/* Meta */}
      <div className="s-stack s-columns-2 s-gap-16px s-margin-bottom-20px s-text-sm" >
        <div>
          <DataTable className="s-full" >
            <tbody>
              <tr><td className="s-padding-2px-0 s-muted" >Skill</td><td className="s-padding-2px-0" >{draft.skillId} v{draft.skillVersion}</td></tr>
              <tr><td className="s-padding-2px-0 s-muted" >Provider</td><td className="s-padding-2px-0" >{draft.provider} ({draft.model})</td></tr>
              <tr><td className="s-padding-2px-0 s-muted" >Type</td><td className="s-padding-2px-0" >{humanLabel(draft.contentType)}</td></tr>
              <tr><td className="s-padding-2px-0 s-muted" >Created</td><td className="s-padding-2px-0" >{new Date(draft.createdAt).toLocaleString()}</td></tr>
            </tbody>
          </DataTable>
        </div>
        {actionError && <p className="s-danger s-text-sm" >{actionError}</p>}
        {actionSuccess && <p className="s-success s-text-sm" >{actionSuccess}</p>}
      </div>

      {/* Meta fields */}
      {draft.excerpt && (
        <div className="s-margin-bottom-16px" >
          <strong className="s-text-sm s-muted" >Excerpt:</strong>
          <p className="s-text-sm s-margin-top-4px" >{draft.excerpt}</p>
        </div>
      )}

      {/* Only DRAFT content is editable. Review/approved/published states are immutable. */}
      {draft.status === "DRAFT" && (
        <div >
          <Button className="btn secondary"
            onClick={() => setIsEditing(!isEditing)}
            type="button"

          >
            {isEditing ? "Cancel edit" : "Edit draft"}
          </Button>
          {isEditing && (
            <form className="s-margin-top-12px s-stack s-gap-12px" id="edit-draft-form" onSubmit={handleEdit} >
              <div>
                <label htmlFor="[id]-field-6241" className="s-block s-text-sm s-margin-bottom-2px" >Title</label>
                <Input id="[id]-field-6241" className="s-full s-padding-6px-8px s-text-sm"
                  type="text" name="title" defaultValue={draft.title}

                />
              </div>
              <div>
                <label htmlFor="[id]-field-6650" className="s-block s-text-sm s-margin-bottom-2px" >Excerpt</label>
                <Textarea id="[id]-field-6650" className="s-full s-padding-6px-8px s-text-sm s-resize-vertical"
                  name="excerpt" rows={2} defaultValue={draft.excerpt ?? ""}

                />
              </div>
              <div>
                <label htmlFor="[id]-field-7092" className="s-block s-text-sm s-margin-bottom-2px" >Meta Title</label>
                <Input id="[id]-field-7092" className="s-full s-padding-6px-8px s-text-sm"
                  type="text" name="metaTitle" defaultValue={draft.metaTitle ?? ""}

                />
              </div>
              <div>
                <label htmlFor="[id]-field-7524" className="s-block s-text-sm s-margin-bottom-2px" >Meta Description</label>
                <Textarea id="[id]-field-7524" className="s-full s-padding-6px-8px s-text-sm s-resize-vertical"
                  name="metaDescription" rows={2} defaultValue={draft.metaDescription ?? ""}

                />
              </div>
              <div className="s-row s-gap-8px" >
                <Button className="s-padding-6px-12px s-text-sm s-muted btn primary"
                  type="submit"
                  disabled={isPending}

                >
                  {isPending ? "Saving..." : "Save changes"}
                </Button>
                <Button className="btn secondary"
                  type="button"
                  onClick={() => setIsEditing(false)}

                >
                  Cancel
                </Button>
              </div>
              {actionError && <p className="s-danger s-text-sm" >{actionError}</p>}
              {actionSuccess && <p className="s-success s-text-sm" >{actionSuccess}</p>}
            </form>
          )}
        </div>

      )}
      {/* Body */}
      <div className="s-margin-bottom-24px" >
        <h2 className="s-margin-bottom-12px" >Content</h2>
        <div className="s-padding-20px ui-card" >
          {renderContentBlocks(draft.body)}
        </div>
      </div>

      {/* Source provenance */}
      <div className="s-margin-bottom-24px" >
        <h2 className="s-margin-bottom-12px" >Source Provenance ({draft.sources.length})</h2>
        {draft.sources.length === 0 ? (
          <p className="s-muted s-text-sm" >No knowledge chunks were used for this draft.</p>
        ) : (
          <DataTable className="s-full s-text-sm" >
            <thead>
              <tr>
                <th className="s-text-align-left s-padding-6px" >Rank</th>
                <th className="s-text-align-left s-padding-6px" >Source</th>
                <th className="s-text-align-left s-padding-6px" >Chunk</th>
                <th className="s-text-align-left s-padding-6px" >Heading</th>
              </tr>
            </thead>
            <tbody>
              {draft.sources.map((s) => (
                <tr key={s.chunkId}>
                  <td className="s-padding-6px" >{s.rank}</td>
                  <td className="s-padding-6px" >{s.sourceTitle}</td>
                  <td className="s-padding-6px" >#{s.ordinal}</td>
                  <td className="s-padding-6px s-muted" >{s.heading || "-"}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>

      {/* Review metadata */}
      {(draft.submittedAt || draft.approvedAt || draft.rejectedAt || draft.publishedAt) && (
        <div className="s-margin-bottom-24px s-padding-12px s-text-sm" >
          {draft.submittedAt && <p><span className="s-muted" >Submitted:</span> {new Date(draft.submittedAt).toLocaleString()}</p>}
          {draft.approvedAt && <p><span className="s-muted" >Approved:</span> {new Date(draft.approvedAt).toLocaleString()}</p>}
          {draft.rejectedAt && <p><span className="s-muted" >Rejected:</span> {new Date(draft.rejectedAt).toLocaleString()}</p>}
          {draft.publishedAt && <p><span className="s-muted" >Published:</span> {new Date(draft.publishedAt).toLocaleString()} → <code>{draft.publishedEntityType}#{draft.publishedEntityId}</code></p>}
        </div>
      )}

      {/* Lifecycle actions */}
      <div className="s-row s-gap-8px s-flex-wrap-wrap s-padding-bottom-24px" >
        {draft.status === "DRAFT" && (
          <Button className="s-padding-8px-16px s-text-sm s-muted btn primary" onClick={() => runAction(submitForReviewAction, "Submitted")} disabled={isPending} >Submit for Review</Button>
        )}
        {draft.status === "IN_REVIEW" && (
          <>
            <Button className="s-padding-8px-16px s-text-sm s-muted btn primary" onClick={() => runAction(sendBackAction, "Sent back")} disabled={isPending} >Send Back</Button>
            <Button className="s-padding-8px-16px s-text-sm s-muted btn primary" onClick={() => runAction(approveAction, "Approved")} disabled={isPending} >Approve</Button>
            <Button className="s-padding-8px-16px s-text-sm s-muted btn danger" onClick={() => runAction(rejectDraftAction, "Rejected")} disabled={isPending} >Reject</Button>
          </>
        )}
        {draft.status === "REJECTED" && (
          <Button className="s-padding-8px-16px s-text-sm s-muted btn primary" onClick={() => runAction(recoverRejectedAction, "Recovered")} disabled={isPending} >Recover to DRAFT</Button>
        )}
        {draft.status === "APPROVED" && (
          <Button className="s-padding-8px-16px s-text-sm s-muted btn primary" onClick={handlePublish} disabled={isPending} >
            {isPending ? "Publishing..." : `Publish to ${draft.contentType === "GUIDE" ? "Guide" : "Field Note"}`}
          </Button>
        )}
        {draft.status === "PUBLISHED" && draft.publishedEntityId && (
          <Link className="s-padding-8px-16px s-text-sm s-muted btn primary" href={`/admin/content`} >View Published</Link>
        )}
      </div>
    </div>
  );
}

function renderContentBlocks(blocks: LlmBlock[]): React.ReactNode {
  if (!blocks || blocks.length === 0) {
    return <p className="s-muted s-text-sm" >(no content)</p>;
  }

  return blocks.map((block, i) => {
    const key = `${block.type}-${i}`;
    switch (block.type) {
      case "heading":
        return block.level === 2 ? <h2 className="s-margin-top-16px s-margin-bottom-8px" key={key} >{block.text}</h2> : <h3 className="s-margin-top-16px s-margin-bottom-8px" key={key} >{block.text}</h3>;
      case "paragraph":
        return <p className="s-margin-bottom-12px s-line-height-1-6" key={key} >{block.text}</p>;
      case "blockquote":
        return <blockquote className="s-border-left-3px-solid-3b82f6 s-margin-12px-0 s-padding-8px-16px s-font-style-italic s-muted" key={key} >{block.text}</blockquote>;
      case "callout":
        return (
          <div className="s-padding-10px-14px s-margin-12px-0 s-text-sm ui-card" key={key} >
            <strong >{block.label}</strong>
            <p className="s-margin-4px-0-0-0" >{block.text}</p>
          </div>
        );
      case "list":
        return block.style === "ordered" ? (
          <ol className="s-margin-bottom-12px s-padding-left-20px" key={key} >{block.items.map((item, j) => <li className="s-margin-bottom-4px" key={j} >{item}</li>)}</ol>
        ) : (
          <ul className="s-margin-bottom-12px s-padding-left-20px" key={key} >{block.items.map((item, j) => <li className="s-margin-bottom-4px" key={j} >{item}</li>)}</ul>
        );
      default:
        return null;
    }
  });
}
