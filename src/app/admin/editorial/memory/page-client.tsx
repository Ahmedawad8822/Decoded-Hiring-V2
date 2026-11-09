"use client";
import { EmptyState, IconButton, StatusPill, PageHeader, Button, Select, Textarea, DataTable } from "../../_ui";

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
    <div >
      <div className="s-row s-justify-content-space-between s-align-items-center s-margin-bottom-16px" >
        <div>
          <PageHeader eyebrow="Editorial AI" title={<>Editorial Memory</>} />
          <p className="s-muted s-text-sm" >{activeCount} active · {archivedCount} archived · {memory.length} total</p>
        </div>
        <Button className="s-padding-8px-16px s-muted s-text-sm btn primary" onClick={() => setShowCreate(!showCreate)} >
          {showCreate ? "✕ Cancel" : "+ New Memory"}
        </Button>
      </div>

      {actionError && <p className="s-danger s-text-sm s-margin-bottom-12px" >{actionError}</p>}
      {actionSuccess && <p className="s-success s-text-sm s-margin-bottom-12px" >{actionSuccess}</p>}

      {/* Create form */}
      {showCreate && (
        <div className="s-padding-16px s-margin-bottom-16px ui-card" >
          <h2 className="s-margin-bottom-12px" >New Memory Item</h2>
          <div className="s-margin-bottom-8px" >
            <label htmlFor="memory-field-4473" className="s-block s-text-sm s-margin-bottom-4px" >Category</label>
            <Select id="memory-field-4473" className="s-full s-padding-6px s-text-sm" value={createCategory} onChange={(e) => setCreateCategory(e.target.value as MemoryCategory)} >
              {MEMORY_CATEGORIES.map((c) => (
                <option key={c} value={c}>{MEMORY_CATEGORY_LABELS[c]}</option>
              ))}
            </Select>
          </div>
          <div className="s-margin-bottom-12px" >
            <label htmlFor="memory-field-5048" className="s-block s-text-sm s-margin-bottom-4px" >Content</label>
            <Textarea id="memory-field-5048" className="s-full s-padding-8px s-text-sm s-resize-vertical" value={createContent} onChange={(e) => setCreateContent(e.target.value)} placeholder="The editorial rule or guidance" rows={3} />
          </div>
          <Button className="s-padding-6px-12px s-text-sm s-muted btn primary" onClick={handleCreate} disabled={!createContent.trim() || isPending} >Create</Button>
        </div>
      )}

      {/* Memory list */}
      <DataTable className="s-full s-text-sm" >
        <thead>
          <tr>
            <th className="s-text-align-left s-padding-8px" >Category</th>
            <th className="s-text-align-left s-padding-8px" >Content</th>
            <th className="s-text-align-left s-padding-8px" >Status</th>
            <th className="s-text-align-right s-padding-8px" >Actions</th>
          </tr>
        </thead>
        <tbody>
          {memory.length === 0 && <tr><td colSpan={4}><EmptyState icon="memory" title="Set the tone for every draft" action={<Button variant="primary" onClick={() => setShowCreate(true)}>+ New Memory</Button>}>Save a rule or preference for your editorial work.</EmptyState></td></tr>}
          {memory.map((item) => (
            <tr key={item.id}>
              <td className="s-padding-8px s-text-sm" >
                {editingId === item.id ? (
                  <Select className="s-full s-padding-4px s-text-sm" value={editCategory} onChange={(e) => setEditCategory(e.target.value as MemoryCategory)} >
                    {MEMORY_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{MEMORY_CATEGORY_LABELS[c]}</option>
                    ))}
                  </Select>
                ) : (
                  <StatusPill status="scheduled">{MEMORY_CATEGORY_LABELS[item.category as MemoryCategory] || item.category}</StatusPill>
                )}
              </td>
              <td className="s-padding-8px" >
                {editingId === item.id ? (
                  <Textarea className="s-full s-padding-4px s-text-sm s-resize-vertical" value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={2} />
                ) : (
                  <span className="s-max-width-400px s-block s-text-sm" >{item.content}</span>
                )}
              </td>
              <td className="s-padding-8px s-text-sm" >
                {item.active ? <StatusPill>Active</StatusPill> : <StatusPill>Inactive</StatusPill>}
                {item.archivedAt && <StatusPill>Archived</StatusPill>}
              </td>
              <td className="s-padding-8px s-text-align-right" >
                {editingId === item.id ? (
                  <>
                    <Button className="s-margin-right-4px s-padding-4px-8px s-text-xs s-muted btn primary" onClick={() => handleUpdate(item.id)} disabled={isPending} >Save</Button>
                    <Button className="s-padding-4px-8px s-text-xs s-muted" onClick={() => setEditingId(null)} >Cancel</Button>
                  </>
                ) : (
                  <>
                    <IconButton icon="edit" label="Edit" onClick={() => { setEditingId(item.id); setEditContent(item.content); setEditCategory(item.category as MemoryCategory); }} />
                    {item.active && !item.archivedAt ? (
                      <IconButton icon="archive" label="Archive" onClick={() => handleArchive(item.id)} disabled={isPending} />
                    ) : (
                      <Button className="s-padding-4px-8px s-text-xs s-muted btn primary" onClick={() => handleUnarchive(item.id)} disabled={isPending} >Restore</Button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </div>
  );
}
