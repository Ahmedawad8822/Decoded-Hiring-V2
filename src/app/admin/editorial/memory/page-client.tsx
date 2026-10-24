"use client";

import { useState, useTransition } from "react";
import { createMemoryAction, updateMemoryAction, archiveMemoryAction, unarchiveMemoryAction } from "@/features/editorial-ai/memory/actions";
import type { EditorialMemory } from "@/lib/db";
import { MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS, type MemoryCategory } from "@/features/editorial-ai/memory/types";
import { unwrapActionResult } from "@/lib/action-result";

interface MemoryPageClientProps {
  initialMemory: EditorialMemory[];
}

export function MemoryPageClient({ initialMemory }: MemoryPageClientProps) {
  const [memory] = useState(initialMemory);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState<MemoryCategory>("POSITIONING");

  const [showCreate, setShowCreate] = useState(false);
  const [createCategory, setCreateCategory] = useState<MemoryCategory>("POSITIONING");
  const [createContent, setCreateContent] = useState("");

  const handleCreate = async () => {
    startTransition(() => {
      setActionError(null);
      setActionSuccess(null);
    });
    try {
      unwrapActionResult(await createMemoryAction({ category: createCategory, content: createContent }));
      startTransition(() => {
        setActionSuccess("Memory item created");
        setShowCreate(false);
        setCreateContent("");
      });
      window.location.reload();
    } catch (err) {
      startTransition(() => {
        setActionError((err as Error).message);
      });
    }
  };

  const handleUpdate = async (id: string) => {
    startTransition(() => {
      setActionError(null);
      setActionSuccess(null);
    });
    try {
      unwrapActionResult(await updateMemoryAction(id, { category: editCategory, content: editContent }));
      startTransition(() => {
        setActionSuccess("Memory item updated");
        setEditingId(null);
      });
      window.location.reload();
    } catch (err) {
      startTransition(() => {
        setActionError((err as Error).message);
      });
    }
  };

  const handleArchive = async (id: string) => {
    if (!confirm("Archive this memory item? It will no longer be injected into generation prompts.")) return;
    try {
      unwrapActionResult(await archiveMemoryAction(id));
      window.location.reload();
    } catch (err) {
      startTransition(() => {
        setActionError((err as Error).message);
      });
    }
  };

  const handleUnarchive = async (id: string) => {
    try {
      unwrapActionResult(await unarchiveMemoryAction(id));
      window.location.reload();
    } catch (err) {
      startTransition(() => {
        setActionError((err as Error).message);
      });
    }
  };

  const activeCount = memory.filter((m) => m.active).length;
  const archivedCount = memory.filter((m) => m.archivedAt).length;

  return (
    <div style={{ padding: "24px", maxWidth: "1000px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div>
          <h1 style={{ fontSize: "24px", marginBottom: "4px" }}>Editorial Memory</h1>
          <p style={{ color: "#6b7280", fontSize: "13px" }}>{activeCount} active · {archivedCount} archived · {memory.length} total</p>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} style={{ padding: "8px 16px", background: "#10b981", color: "white", border: "none", borderRadius: "4px", fontSize: "13px", cursor: "pointer" }}>
          {showCreate ? "✕ Cancel" : "+ New Memory"}
        </button>
      </div>

      {actionError && <p style={{ color: "#ef4444", fontSize: "13px", marginBottom: "12px" }}>{actionError}</p>}
      {actionSuccess && <p style={{ color: "#10b981", fontSize: "13px", marginBottom: "12px" }}>{actionSuccess}</p>}

      {/* Create form */}
      {showCreate && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "16px", marginBottom: "16px" }}>
          <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>New Memory Item</h2>
          <div style={{ marginBottom: "8px" }}>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "4px" }}>Category</label>
            <select value={createCategory} onChange={(e) => setCreateCategory(e.target.value as MemoryCategory)} style={{ width: "100%", padding: "6px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "13px" }}>
              {MEMORY_CATEGORIES.map((c) => (
                <option key={c} value={c}>{MEMORY_CATEGORY_LABELS[c]}</option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "4px" }}>Content</label>
            <textarea value={createContent} onChange={(e) => setCreateContent(e.target.value)} placeholder="The editorial rule or guidance" rows={3} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "13px", resize: "vertical" }} />
          </div>
          <button onClick={handleCreate} disabled={!createContent.trim() || isPending} style={{ padding: "6px 12px", fontSize: "12px", background: "#3b82f6", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Create</button>
        </div>
      )}

      {/* Memory list */}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb" }}>Category</th>
            <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb" }}>Content</th>
            <th style={{ textAlign: "left", padding: "8px", borderBottom: "2px solid #e5e7eb" }}>Status</th>
            <th style={{ textAlign: "right", padding: "8px", borderBottom: "2px solid #e5e7eb" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {memory.map((item) => (
            <tr key={item.id}>
              <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb", fontSize: "12px" }}>
                {editingId === item.id ? (
                  <select value={editCategory} onChange={(e) => setEditCategory(e.target.value as MemoryCategory)} style={{ width: "100%", padding: "4px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "12px" }}>
                    {MEMORY_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{MEMORY_CATEGORY_LABELS[c]}</option>
                    ))}
                  </select>
                ) : (
                  MEMORY_CATEGORY_LABELS[item.category as MemoryCategory] || item.category
                )}
              </td>
              <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb" }}>
                {editingId === item.id ? (
                  <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={2} style={{ width: "100%", padding: "4px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "12px", resize: "vertical" }} />
                ) : (
                  <span style={{ maxWidth: "400px", display: "block", fontSize: "12px" }}>{item.content}</span>
                )}
              </td>
              <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb", fontSize: "12px" }}>
                {item.active ? <span style={{ color: "#10b981" }}>Active</span> : <span style={{ color: "#6b7280" }}>Inactive</span>}
                {item.archivedAt && <span style={{ color: "#9ca3af", marginLeft: "8px" }}>Archived</span>}
              </td>
              <td style={{ padding: "8px", borderBottom: "1px solid #e5e7eb", textAlign: "right" }}>
                {editingId === item.id ? (
                  <>
                    <button onClick={() => handleUpdate(item.id)} disabled={isPending} style={{ marginRight: "4px", padding: "4px 8px", fontSize: "11px", background: "#10b981", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Save</button>
                    <button onClick={() => setEditingId(null)} style={{ padding: "4px 8px", fontSize: "11px", background: "#6b7280", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { setEditingId(item.id); setEditContent(item.content); setEditCategory(item.category as MemoryCategory); }} style={{ marginRight: "4px", padding: "4px 8px", fontSize: "11px", background: "#3b82f6", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Edit</button>
                    {item.active && !item.archivedAt ? (
                      <button onClick={() => handleArchive(item.id)} disabled={isPending} style={{ padding: "4px 8px", fontSize: "11px", background: "#f59e0b", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Archive</button>
                    ) : (
                      <button onClick={() => handleUnarchive(item.id)} disabled={isPending} style={{ padding: "4px 8px", fontSize: "11px", background: "#10b981", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>Restore</button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
