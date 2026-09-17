"use client";

import { useTransition } from "react";
import Link from "next/link";
import { approveAction, rejectDraftAction, publishDraftAction } from "@/features/editorial-ai/drafts/actions";
import type { EditorialDraftWithSources } from "@/features/editorial-ai/drafts/types";

interface EditorialListClientProps {
  initialDrafts: EditorialDraftWithSources[];
}

export function EditorialListClient({ initialDrafts }: EditorialListClientProps) {
  const [isPending, startTransition] = useTransition();

  const statusColors: Record<string, string> = {
    DRAFT: "#6b7280",
    IN_REVIEW: "#3b82f6",
    APPROVED: "#10b981",
    REJECTED: "#ef4444",
    PUBLISHED: "#8b5cf6",
  };

  function handleApprove(id: string) {
    startTransition(async () => {
      try { await approveAction(id); window.location.reload(); } catch (e) { alert((e as Error).message); }
    });
  }

  function handlePublish(id: string) {
    startTransition(async () => {
      try { await publishDraftAction(id); window.location.reload(); } catch (e) { alert((e as Error).message); }
    });
  }

  function handleReject(id: string) {
    const reason = prompt("Rejection reason (optional):");
    startTransition(async () => {
      try { await rejectDraftAction(id, { note: reason ?? undefined }); window.location.reload(); } catch (e) { alert((e as Error).message); }
    });
  }

  const pendingCount = initialDrafts.filter((d) => d.status === "IN_REVIEW").length;
  const approvedCount = initialDrafts.filter((d) => d.status === "APPROVED").length;

  return (
    <div style={{ padding: "24px", maxWidth: "1200px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h1 style={{ fontSize: "28px" }}>Editorial Drafts</h1>
        <Link href="/admin/editorial/new" style={{ padding: "8px 16px", background: "#3b82f6", color: "white", textDecoration: "none", borderRadius: "4px", fontSize: "13px" }}>
          + New Generation
        </Link>
      </div>

      <div style={{ display: "flex", gap: "16px", marginBottom: "16px", fontSize: "13px" }}>
        <span style={{ color: "#6b7280" }}>Total: {initialDrafts.length}</span>
        <span style={{ color: "#3b82f6" }}>In Review: {pendingCount}</span>
        <span style={{ color: "#10b981" }}>Approved: {approvedCount}</span>
      </div>

      {initialDrafts.length === 0 ? (
        <p style={{ color: "#6b7280" }}>No drafts yet. Create one to get started.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb" }}>Title</th>
              <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb" }}>Type</th>
              <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb" }}>Status</th>
              <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb" }}>Skill</th>
              <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb" }}>Created</th>
              <th style={{ textAlign: "right", padding: "8px", borderBottom: "2px solid #e5e7eb" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {initialDrafts.map((draft) => (
              <tr key={draft.id}>
                <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb" }}>
                  <Link href={`/admin/editorial/${draft.id}`} style={{ fontWeight: 500, textDecoration: "none" }}>{draft.title}</Link>
                </td>
                <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb" }}>{draft.contentType}</td>
                <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb" }}>
                  <span style={{ color: statusColors[draft.status] || "#6b7280", fontWeight: 600, fontSize: "12px" }}>{draft.status}</span>
                </td>
                <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb", fontSize: "12px" }}>{draft.skillId}</td>
                <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb", fontSize: "12px" }}>{new Date(draft.createdAt).toLocaleDateString()}</td>
                <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb", textAlign: "right" }}>
                  {draft.status === "IN_REVIEW" && (
                    <>
                      <button onClick={() => handleApprove(draft.id)} disabled={isPending} style={{ marginRight: "4px", padding: "4px 8px", fontSize: "11px", background: "#10b981", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Approve</button>
                      <button onClick={() => handleReject(draft.id)} disabled={isPending} style={{ marginRight: "4px", padding: "4px 8px", fontSize: "11px", background: "#ef4444", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Reject</button>
                    </>
                  )}
                  {draft.status === "APPROVED" && (
                    <button onClick={() => handlePublish(draft.id)} disabled={isPending} style={{ padding: "4px 8px", fontSize: "11px", background: "#8b5cf6", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Publish</button>
                  )}
                  {draft.status === "PUBLISHED" && draft.publishedEntityId && (
                    <a href={`/admin/content`} style={{ fontSize: "11px", color: "#6b7280", textDecoration: "underline" }}>Published</a>
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
