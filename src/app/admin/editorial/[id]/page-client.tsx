"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  submitForReviewAction,
  sendBackAction,
  approveAction,
  rejectDraftAction,
  publishDraftAction,
  updateDraftAction,
} from "@/features/editorial-ai/drafts/actions";
import type { EditorialDraftWithSources, UpdateDraftInput } from "@/features/editorial-ai/drafts/types";
import type { LlmBlock } from "@/features/editorial-ai/skills/types";

interface DraftDetailClientProps {
  draft: EditorialDraftWithSources;
}

export function DraftDetailClient({ draft }: DraftDetailClientProps) {
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  const statusColors: Record<string, string> = {
    DRAFT: "#6b7280",
    IN_REVIEW: "#3b82f6",
    APPROVED: "#10b981",
    REJECTED: "#ef4444",
    PUBLISHED: "#8b5cf6",
  };

  async function runAction(fn: (id: string, input?: { note?: string }) => Promise<unknown>, label: string, input?: { note?: string }) {
    setActionError(null);
    setActionSuccess(null);
    startTransition(async () => {
      try {
        await fn(draft.id, input);
        setActionSuccess(`${label} completed`);
        window.location.reload();
      } catch (err) {
        setActionError((err as Error).message);
      }
    });
  }

  async function handlePublish() {
    setActionError(null);
    setActionSuccess(null);
    startTransition(async () => {
      try {
        const result = await publishDraftAction(draft.id);
        setActionSuccess(`Published as ${result.entityType} (${result.entityId})`);
        window.location.reload();
      } catch (err) {
        setActionError((err as Error).message);
      }
    });
  }

  async function handleEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setActionError(null);
    setActionSuccess(null);
    const formData = new FormData(e.currentTarget);
    const input: UpdateDraftInput = {
      title: (formData.get("title") as string) || undefined,
      excerpt: (formData.get("excerpt") as string) || undefined,
      metaTitle: (formData.get("metaTitle") as string) || undefined,
      metaDescription: (formData.get("metaDescription") as string) || undefined,
    };
    startTransition(async () => {
      try {
        await updateDraftAction(draft.id, input);
        setActionSuccess("Draft updated");
        setIsEditing(false);
        window.location.reload();
      } catch (err) {
        setActionError((err as Error).message);
      }
    });
  }

  return (
    <div style={{ padding: "24px", maxWidth: "1000px" }}>
      <Link href="/admin/editorial" style={{ color: "#6b7280", fontSize: "13px", textDecoration: "none" }}>Back to Drafts</Link>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: "12px", marginBottom: "16px" }}>
        <div>
          <h1 style={{ fontSize: "24px", marginBottom: "4px" }}>{draft.title}</h1>
          <p style={{ color: "#6b7280", fontSize: "13px" }}>Slug: <code>{draft.slug}</code></p>
        </div>
        <span style={{ color: statusColors[draft.status] || "#6b7280", fontWeight: 600, fontSize: "12px", padding: "4px 8px", border: `1px solid ${statusColors[draft.status] || "#d1d5db"}`, borderRadius: "4px" }}>
          {draft.status}
        </span>
      </div>

      {/* Meta */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "20px", fontSize: "13px" }}>
        <div>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <tbody>
              <tr><td style={{ padding: "2px 0", color: "#6b7280" }}>Skill</td><td style={{ padding: "2px 0" }}>{draft.skillId} v{draft.skillVersion}</td></tr>
              <tr><td style={{ padding: "2px 0", color: "#6b7280" }}>Provider</td><td style={{ padding: "2px 0" }}>{draft.provider} ({draft.model})</td></tr>
              <tr><td style={{ padding: "2px 0", color: "#6b7280" }}>Type</td><td style={{ padding: "2px 0" }}>{draft.contentType}</td></tr>
              <tr><td style={{ padding: "2px 0", color: "#6b7280" }}>Created</td><td style={{ padding: "2px 0" }}>{new Date(draft.createdAt).toLocaleString()}</td></tr>
            </tbody>
          </table>
        </div>
        {actionError && <p style={{ color: "#ef4444", fontSize: "13px" }}>{actionError}</p>}
        {actionSuccess && <p style={{ color: "#10b981", fontSize: "13px" }}>{actionSuccess}</p>}
      </div>

      {/* Meta fields */}
      {draft.excerpt && (
        <div style={{ marginBottom: "16px" }}>
          <strong style={{ fontSize: "13px", color: "#6b7280" }}>Excerpt:</strong>
          <p style={{ fontSize: "14px", marginTop: "4px" }}>{draft.excerpt}</p>
        </div>
      )}

      {/* Edit form (toggleable) */}
      <div style={{ marginBottom: isEditing ? "8px" : "24px" }}>
        <button
          onClick={() => setIsEditing(!isEditing)}
          type="button"
          style={{
            padding: "6px 12px", fontSize: "12px", background: isEditing ? "#ef4444" : "#6b7280",
            color: "white", border: "none", borderRadius: "4px", cursor: "pointer",
          }}
        >
          {isEditing ? "Cancel edit" : "Edit draft"}
        </button>
        {isEditing && (
          <form id="edit-draft-form" onSubmit={handleEdit} style={{ marginTop: "12px", display: "grid", gap: "12px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "2px" }}>Title</label>
              <input
                type="text" name="title" defaultValue={draft.title}
                style={{ width: "100%", padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "13px" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "2px" }}>Excerpt</label>
              <textarea
                name="excerpt" rows={2} defaultValue={draft.excerpt ?? ""}
                style={{ width: "100%", padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "13px", resize: "vertical" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "2px" }}>Meta Title</label>
              <input
                type="text" name="metaTitle" defaultValue={draft.metaTitle ?? ""}
                style={{ width: "100%", padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "13px" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "2px" }}>Meta Description</label>
              <textarea
                name="metaDescription" rows={2} defaultValue={draft.metaDescription ?? ""}
                style={{ width: "100%", padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "13px", resize: "vertical" }}
              />
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="submit"
                disabled={isPending}
                style={{ padding: "6px 12px", fontSize: "12px", background: "#10b981", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
              >
                {isPending ? "Saving..." : "Save changes"}
              </button>
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                style={{ padding: "6px 12px", fontSize: "12px", background: "#ef4444", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
              >
                Cancel
              </button>
            </div>
            {actionError && <p style={{ color: "#ef4444", fontSize: "12px" }}>{actionError}</p>}
            {actionSuccess && <p style={{ color: "#10b981", fontSize: "12px" }}>{actionSuccess}</p>}
          </form>
        )}
      </div>

      {/* Body */}
      <div style={{ marginBottom: "24px" }}>
        <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>Content</h2>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "20px", background: "var(--paper, #fff)" }}>
          {renderContentBlocks(draft.body)}
        </div>
      </div>

      {/* Source provenance */}
      <div style={{ marginBottom: "24px" }}>
        <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>Source Provenance ({draft.sources.length})</h2>
        {draft.sources.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: "13px" }}>No knowledge chunks were used for this draft.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "6px", borderBottom: "1px solid #e5e7eb" }}>Rank</th>
                <th style={{ textAlign: "left", padding: "6px", borderBottom: "1px solid #e5e7eb" }}>Source</th>
                <th style={{ textAlign: "left", padding: "6px", borderBottom: "1px solid #e5e7eb" }}>Chunk</th>
                <th style={{ textAlign: "left", padding: "6px", borderBottom: "1px solid #e5e7eb" }}>Heading</th>
              </tr>
            </thead>
            <tbody>
              {draft.sources.map((s) => (
                <tr key={s.chunkId}>
                  <td style={{ padding: "6px" }}>{s.rank}</td>
                  <td style={{ padding: "6px" }}>{s.sourceTitle}</td>
                  <td style={{ padding: "6px" }}>#{s.ordinal}</td>
                  <td style={{ padding: "6px", color: "#6b7280" }}>{s.heading || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Review metadata */}
      {(draft.submittedAt || draft.approvedAt || draft.rejectedAt || draft.publishedAt) && (
        <div style={{ marginBottom: "24px", padding: "12px", background: "#f9fafb", borderRadius: "8px", fontSize: "12px" }}>
          {draft.submittedAt && <p><span style={{ color: "#6b7280" }}>Submitted:</span> {new Date(draft.submittedAt).toLocaleString()}</p>}
          {draft.approvedAt && <p><span style={{ color: "#6b7280" }}>Approved:</span> {new Date(draft.approvedAt).toLocaleString()}</p>}
          {draft.rejectedAt && <p><span style={{ color: "#6b7280" }}>Rejected:</span> {new Date(draft.rejectedAt).toLocaleString()}</p>}
          {draft.publishedAt && <p><span style={{ color: "#6b7280" }}>Published:</span> {new Date(draft.publishedAt).toLocaleString()} → <code>{draft.publishedEntityType}#{draft.publishedEntityId}</code></p>}
        </div>
      )}

      {/* Lifecycle actions */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", paddingBottom: "24px" }}>
        {draft.status === "DRAFT" && (
          <button onClick={() => runAction(submitForReviewAction, "Submitted")} disabled={isPending} style={{ padding: "8px 16px", fontSize: "13px", background: "#3b82f6", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Submit for Review</button>
        )}
        {draft.status === "IN_REVIEW" && (
          <>
            <button onClick={() => runAction(sendBackAction, "Sent back")} disabled={isPending} style={{ padding: "8px 16px", fontSize: "13px", background: "#f59e0b", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Send Back</button>
            <button onClick={() => runAction(approveAction, "Approved")} disabled={isPending} style={{ padding: "8px 16px", fontSize: "13px", background: "#10b981", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Approve</button>
            <button onClick={() => runAction(rejectDraftAction, "Rejected")} disabled={isPending} style={{ padding: "8px 16px", fontSize: "13px", background: "#ef4444", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Reject</button>
          </>
        )}
        {draft.status === "APPROVED" && (
          <button onClick={handlePublish} disabled={isPending} style={{ padding: "8px 16px", fontSize: "13px", background: "#8b5cf6", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>{isPending ? "Publishing..." : "Publish to Guide"}/Field Note</button>
        )}
        {draft.status === "PUBLISHED" && draft.publishedEntityId && (
          <Link href={`/admin/content`} style={{ padding: "8px 16px", fontSize: "13px", background: "#8b5cf6", color: "white", textDecoration: "none", borderRadius: "4px" }}>View Published</Link>
        )}
      </div>
    </div>
  );
}

function renderContentBlocks(blocks: LlmBlock[]): React.ReactNode {
  if (!blocks || blocks.length === 0) {
    return <p style={{ color: "#6b7280", fontSize: "13px" }}>(no content)</p>;
  }

  return blocks.map((block, i) => {
    const key = `${block.type}-${i}`;
    switch (block.type) {
      case "heading":
        return block.level === 2 ? <h2 key={key} style={{ fontSize: "20px", marginTop: "16px", marginBottom: "8px" }}>{block.text}</h2> : <h3 key={key} style={{ fontSize: "18px", marginTop: "16px", marginBottom: "8px" }}>{block.text}</h3>;
      case "paragraph":
        return <p key={key} style={{ marginBottom: "12px", lineHeight: "1.6" }}>{block.text}</p>;
      case "blockquote":
        return <blockquote key={key} style={{ borderLeft: "3px solid #3b82f6", margin: "12px 0", padding: "8px 16px", fontStyle: "italic", color: "#374151" }}>{block.text}</blockquote>;
      case "callout":
        return (
          <div key={key} style={{ border: "1px solid #e5e7eb", borderRadius: "6px", padding: "10px 14px", margin: "12px 0", fontSize: "13px" }}>
            <strong style={{ color: block.tone === "evidence" ? "#10b981" : "#3b82f6" }}>{block.label}</strong>
            <p style={{ margin: "4px 0 0 0" }}>{block.text}</p>
          </div>
        );
      case "list":
        return block.style === "ordered" ? (
          <ol key={key} style={{ marginBottom: "12px", paddingLeft: "20px" }}>{block.items.map((item, j) => <li key={j} style={{ marginBottom: "4px" }}>{item}</li>)}</ol>
        ) : (
          <ul key={key} style={{ marginBottom: "12px", paddingLeft: "20px" }}>{block.items.map((item, j) => <li key={j} style={{ marginBottom: "4px" }}>{item}</li>)}</ul>
        );
      default:
        return null;
    }
  });
}
