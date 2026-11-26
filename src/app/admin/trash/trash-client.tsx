"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, DataTable, EmptyState, Field, Input, PageHeader, StatusPill, Toast } from "../_ui";
import { useToast } from "../_ui";
import {
  deletePermanentlyAction,
  restoreTrashedItemAction,
} from "@/features/trash/actions";
import type { TrashItem } from "@/features/trash/service";

function formatTrashed(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function daysLabel(daysLeft: number): string {
  if (daysLeft <= 0) return "due for purge";
  if (daysLeft === 1) return "1 day left";
  return `${daysLeft} days left`;
}

export function TrashClient({ initialItems }: { initialItems: TrashItem[] }) {
  const router = useRouter();
  const [toast, showToast] = useToast();
  const [items, setItems] = useState(initialItems);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id));

  const handleRestore = async (item: TrashItem) => {
    setBusyId(item.id);
    const res = await restoreTrashedItemAction({ type: item.type, id: item.id });
    setBusyId(null);
    if (!res.ok) {
      showToast("Restore failed", res.error, "error");
      return;
    }
    removeItem(item.id);
    showToast("Restored", `"${item.title}" is back as ${item.status}.`);
    router.refresh();
  };

  const handleDelete = async (item: TrashItem) => {
    if (confirmTitle.trim() !== item.title) {
      showToast("Title does not match", "Type the exact title to confirm permanent deletion.", "error");
      return;
    }
    setBusyId(item.id);
    const res = await deletePermanentlyAction({ type: item.type, id: item.id, confirmTitle: confirmTitle.trim() });
    setBusyId(null);
    if (!res.ok) {
      showToast("Delete failed", res.error, "error");
      return;
    }
    setConfirmingId(null);
    setConfirmTitle("");
    removeItem(item.id);
    showToast("Deleted permanently", `"${item.title}" is gone for good.`);
    router.refresh();
  };

  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Trash"
        description="Trashed guides, field notes, courses and lessons. Items are purged automatically 30 days after trashing. Protected items have learners attached and can only be archived, never deleted."
      />
      {toast && (
        <Toast title={toast.title} error={toast.type === "error"}>{toast.message}</Toast>
      )}
      {items.length === 0 ? (
        <EmptyState icon="trash" title="Trash is empty">
          <p>Trashed content lands here for 30 days before automatic purge.</p>
        </EmptyState>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Title</th>
              <th scope="col">Was</th>
              <th scope="col">Trashed</th>
              <th scope="col">Purge in</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.type}:${item.id}`}>
                <td>{item.typeLabel}</td>
                <td>
                  <strong>{item.title}</strong>
                  <br />
                  <small>
                    <code>{item.slug}</code>
                  </small>
                  {item.protected && item.protectionReason && (
                    <>
                      <br />
                      <small>{item.protectionReason}</small>
                    </>
                  )}
                </td>
                <td>
                  <StatusPill status={item.status}>{item.status}</StatusPill>
                </td>
                <td>{formatTrashed(item.trashedAt)}</td>
                <td>{item.expired ? "due for purge" : daysLabel(item.daysLeft)}</td>
                <td>
                  <div className="s-row s-gap-12">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busyId === item.id}
                      onClick={() => handleRestore(item)}
                    >
                      Restore
                    </Button>
                    {!item.protected && (
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={busyId === item.id}
                        onClick={() => {
                          setConfirmingId(item.id);
                          setConfirmTitle("");
                        }}
                      >
                        Delete permanently
                      </Button>
                    )}
                  </div>
                  {confirmingId === item.id && (
                    <div className="s-margin-top-20">
                      <Field
                        label={`Type "${item.title}" to confirm`}
                        help="This cannot be undone."
                      >
                        <Input
                          value={confirmTitle}
                          onChange={(e) => setConfirmTitle(e.target.value)}
                          placeholder={item.title}
                          aria-label={`Type ${item.title} to confirm permanent deletion`}
                        />
                      </Field>
                      <div className="s-row s-gap-12 s-margin-top-20">
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          disabled={busyId === item.id}
                          onClick={() => handleDelete(item)}
                        >
                          Confirm delete
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setConfirmingId(null);
                            setConfirmTitle("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
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
