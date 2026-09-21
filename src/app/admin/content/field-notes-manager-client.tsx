"use client";

import React, { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FieldNote, FieldNoteRevision } from "@/lib/db";
import { FieldNoteBlock, FieldNoteStatus } from "@/features/field-notes/types";
import { slugifyTitle } from "@/features/publishing/types";
import {
  StructuredBlockEditor,
  type StructuredBlockType,
} from "@/components/publishing/StructuredBlockEditor";
import {
  createFieldNoteAction,
  updateFieldNoteAction,
  publishFieldNoteAction,
  unpublishFieldNoteAction,
  archiveFieldNoteAction,
  getFieldNoteRevisionsAction,
} from "@/features/field-notes/actions";

interface FieldNotesManagerClientProps {
  initialNotes: FieldNote[];
}

function createFieldNoteBlock(type: StructuredBlockType): FieldNoteBlock {
  const id = `b-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  switch (type) {
    case "heading":
      return { id, type: "heading", level: 2, text: "New section heading" };
    case "blockquote":
      return { id, type: "blockquote", text: "Observation worth quoting..." };
    case "callout":
      return { id, type: "callout", tone: "note", label: "IMPLICATION", text: "What this means in practice..." };
    case "list":
      return { id, type: "list", style: "bullet", items: ["First point", "Second point"] };
    case "paragraph":
    default:
      return { id, type: "paragraph", text: "New paragraph text..." };
  }
}

function formatDate(value: Date | string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function FieldNotesManagerClient({ initialNotes }: FieldNotesManagerClientProps) {
  const router = useRouter();
  const [isPending] = useTransition();

  const [view, setView] = useState<"list" | "editor">("list");
  const notes = initialNotes;

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Editor form state (deliberately lighter than the Guide editor: no
  // category/tags taxonomy, no TOC configuration, no manual reading time)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [coverImage, setCoverImage] = useState("");
  const [blocks, setBlocks] = useState<FieldNoteBlock[]>([]);
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [currentStatus, setCurrentStatus] = useState<FieldNoteStatus>("draft");
  const [revisions, setRevisions] = useState<FieldNoteRevision[]>([]);

  const [toast, setToast] = useState<{ title: string; message: string; type?: "info" | "error" } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    action: "publish" | "unpublish" | "archive";
    noteId: string;
    noteTitle: string;
  } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const showToast = (title: string, message: string, type: "info" | "error" = "info") => {
    setToast({ title, message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const loadRevisions = async (noteId: string) => {
    const res = await getFieldNoteRevisionsAction(noteId);
    if (res.ok && res.data) setRevisions(res.data);
  };

  const handleNewNote = () => {
    setEditingNoteId(null);
    setTitle("");
    setSlug("");
    setExcerpt("");
    setCoverImage("");
    setBlocks([{ id: `b-${Date.now()}-1`, type: "paragraph", text: "What did you notice..." }]);
    setMetaTitle("");
    setMetaDescription("");
    setCurrentStatus("draft");
    setRevisions([]);
    setView("editor");
  };

  const handleEditNote = (note: FieldNote) => {
    setEditingNoteId(note.id);
    setTitle(note.title);
    setSlug(note.slug);
    setExcerpt(note.excerpt || "");
    setCoverImage(note.coverImage || "");
    setMetaTitle(note.metaTitle || "");
    setMetaDescription(note.metaDescription || "");
    setCurrentStatus(note.status);
    try {
      setBlocks(JSON.parse(note.body) as FieldNoteBlock[]);
    } catch {
      setBlocks([]);
    }
    setRevisions([]);
    setView("editor");
    loadRevisions(note.id);
  };

  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
    if (!editingNoteId) setSlug(slugifyTitle(newTitle));
  };

  // Block mechanics live in the shared StructuredBlockEditor; Field Notes
  // expose only the lightweight subset (no resource blocks).

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImage(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("namespace", "field-notes");
    try {
      const res = await fetch("/api/media/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setCoverImage(data.url);
      showToast("Image Uploaded", `Saved as ${data.filename}`);
    } catch (err: unknown) {
      showToast("Upload Error", (err as Error).message, "error");
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSave = async (publishImmediately: boolean = false) => {
    if (!title.trim() || !slug.trim()) {
      showToast("Validation Error", "Title and Slug are required.", "error");
      return;
    }
    if (editingNoteId) {
        const res = await updateFieldNoteAction({
          id: editingNoteId,
          title,
          slug,
          excerpt,
          coverImage: coverImage || null,
          metaTitle: metaTitle || title,
          metaDescription: metaDescription || excerpt,
          body: blocks,
        });
        if (!res.ok) {
          showToast("Update Failed", res.error || "Could not save note", "error");
          return;
        }
        if (publishImmediately) {
          const pubRes = await publishFieldNoteAction(editingNoteId);
          if (pubRes.ok) {
            setCurrentStatus("published");
            showToast("Published!", "Field note is now live.");
          } else {
            showToast("Publish Failed", pubRes.error || "Failed to publish", "error");
          }
        } else {
          showToast("Saved", "Field note draft saved.");
        }
        loadRevisions(editingNoteId);
      } else {
        const res = await createFieldNoteAction({
          title,
          slug,
          excerpt,
          author: "Decoded Editorial",
          coverImage: coverImage || null,
          metaTitle: metaTitle || title,
          metaDescription: metaDescription || excerpt,
          body: blocks,
        });
        if (!res.ok) {
          showToast("Creation Failed", res.error || "Could not create note", "error");
          return;
        }
        if (res.data?.id) {
          setEditingNoteId(res.data.id);
          if (publishImmediately) {
            const pubRes = await publishFieldNoteAction(res.data.id);
            if (pubRes.ok) {
              setCurrentStatus("published");
              showToast("Published!", "Field note is now live.");
            }
          } else {
            showToast("Created", "New field note draft created.");
          }
          loadRevisions(res.data.id);
        }
      }
      router.refresh();
  };

  const handleConfirmAction = async () => {
    if (!confirmModal) return;
    const { action, noteId } = confirmModal;
    setConfirmModal(null);

    if (action === "publish") {
        const res = await publishFieldNoteAction(noteId);
        if (res.ok) {
          setCurrentStatus("published");
          showToast("Published", "Field note published to live site.");
        } else {
          showToast("Action Failed", res.error || "Publish failed", "error");
        }
      } else if (action === "unpublish") {
        const res = await unpublishFieldNoteAction(noteId);
        if (res.ok) {
          setCurrentStatus("draft");
          showToast("Unpublished", "Field note returned to draft.");
        } else {
          showToast("Action Failed", res.error || "Unpublish failed", "error");
        }
      } else if (action === "archive") {
        const res = await archiveFieldNoteAction(noteId);
        if (res.ok) {
          setCurrentStatus("archived");
          showToast("Archived", "Field note has been archived.");
        } else {
          showToast("Action Failed", res.error || "Archive failed", "error");
        }
      }
      if (editingNoteId) loadRevisions(editingNoteId);
      router.refresh();
  };

  const filteredNotes = notes.filter((n) => {
    const matchesSearch =
      n.title.toLowerCase().includes(search.toLowerCase()) ||
      n.slug.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" ? true : n.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <>
      {toast && (
        <div className="toast-stack">
          <div className={`toast ${toast.type === "error" ? "error" : ""}`}>
            <b>{toast.title}</b>
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      {confirmModal && (
        <div className="dialog" style={{ display: "grid", placeItems: "center" }}>
          <div className="dg-panel">
            <h3>Confirm {confirmModal.action.toUpperCase()}</h3>
            <div className="dg-body">
              <p>
                Are you sure you want to <strong>{confirmModal.action}</strong> &ldquo;
                {confirmModal.noteTitle}&rdquo;?
              </p>
              {confirmModal.action === "archive" && (
                <div className="dg-consequences">
                  <strong>Consequences:</strong>
                  <ul>
                    <li>The note will no longer be visible on /field-notes or accessible publicly.</li>
                    <li>Existing links will return a 404 response.</li>
                  </ul>
                </div>
              )}
              {confirmModal.action === "unpublish" && (
                <div className="dg-consequences">
                  <strong>Consequences:</strong>
                  <ul>
                    <li>The note will return to Draft state and be removed from public discovery.</li>
                  </ul>
                </div>
              )}
            </div>
            <div className="dg-actions">
              <button type="button" className="btn ghost small" onClick={() => setConfirmModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={`btn ${confirmModal.action === "archive" ? "danger" : "primary"} small`}
                onClick={handleConfirmAction}
              >
                Confirm {confirmModal.action}
              </button>
            </div>
          </div>
        </div>
      )}

      {view === "list" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px", flexWrap: "wrap" }}>
            <h1 className="a-h1" style={{ fontSize: "24px", fontWeight: 700, margin: 0 }}>
              Content
            </h1>
            <span style={{ fontSize: "12.5px", color: "var(--muted)" }}>
              Field Notes — short, timely hiring observations. Draft, publish &amp; archive.
            </span>
          </div>

          <div className="filter-bar" style={{ marginTop: "18px" }}>
            <div className="search">
              <input
                type="search"
                placeholder="Search title, slug…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search field notes"
              />
            </div>
            <select
              aria-label="Filter status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
            <button className="btn primary small" type="button" onClick={handleNewNote} style={{ fontWeight: 600 }}>
              ＋ New Field Note
            </button>
          </div>

          <div className="table-wrap" style={{ marginTop: "12px" }}>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Title &amp; Slug</th>
                    <th>Status</th>
                    <th>Published</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNotes.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: "center", padding: "32px", color: "var(--muted)" }}>
                        No field notes match the selected filters.
                      </td>
                    </tr>
                  ) : (
                    filteredNotes.map((n) => (
                      <tr key={n.id}>
                        <td>
                          <span className="cell-main" style={{ display: "block" }}>
                            {n.title}
                          </span>
                          <span className="cell-sub" style={{ display: "block" }}>
                            /field-notes/{n.slug}
                          </span>
                        </td>
                        <td>
                          <span className={`lifecycle ${n.status}`}>{n.status.toUpperCase()}</span>
                        </td>
                        <td className="num">{n.publishedAt ? formatDate(n.publishedAt) : "—"}</td>
                        <td className="num">{formatDate(n.updatedAt)}</td>
                        <td>
                          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                            <button className="btn secondary small" type="button" onClick={() => handleEditNote(n)}>
                              Edit
                            </button>
                            <Link
                              href={`/field-notes/${n.slug}?preview=true`}
                              target="_blank"
                              className="btn ghost small"
                              style={{ textDecoration: "none" }}
                            >
                              Preview
                            </Link>
                            {n.status === "published" ? (
                              <button
                                className="btn ghost small"
                                type="button"
                                onClick={() => setConfirmModal({ action: "unpublish", noteId: n.id, noteTitle: n.title })}
                              >
                                Unpublish
                              </button>
                            ) : n.status === "draft" ? (
                              <button
                                className="btn ghost small"
                                type="button"
                                onClick={() => setConfirmModal({ action: "publish", noteId: n.id, noteTitle: n.title })}
                              >
                                Publish
                              </button>
                            ) : null}
                            {n.status !== "archived" && (
                              <button
                                className="btn ghost small"
                                type="button"
                                onClick={() => setConfirmModal({ action: "archive", noteId: n.id, noteTitle: n.title })}
                              >
                                Archive
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="data-card-list">
              {filteredNotes.map((n) => (
                <div className="data-card" key={`card-${n.id}`}>
                  <div className="dc-head">
                    <span className="dc-title">{n.title}</span>
                    <span className={`lifecycle ${n.status}`}>{n.status.toUpperCase()}</span>
                  </div>
                  <p className="dc-meta">
                    <span>/field-notes/{n.slug}</span>
                    <span>Updated {formatDate(n.updatedAt)}</span>
                  </p>
                  <div className="dc-actions">
                    <button className="btn secondary small" type="button" onClick={() => handleEditNote(n)}>
                      Edit
                    </button>
                    <Link
                      href={`/field-notes/${n.slug}?preview=true`}
                      target="_blank"
                      className="btn ghost small"
                      style={{ textDecoration: "none" }}
                    >
                      Preview
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {view === "editor" && (
        <div>
          <div className="editor-subhead" style={{ top: "56px", borderRadius: "8px 8px 0 0", margin: "-8px -8px 20px" }}>
            <span className="es-title">{title || "Untitled Field Note"}</span>
            <span className={`lifecycle ${currentStatus}`}>{currentStatus.toUpperCase()}</span>
            <span className="es-saved">✓ {isPending ? "Saving..." : "Ready"}</span>
            <span className="es-spacer"></span>
            <button
              className="btn ghost small"
              type="button"
              onClick={() => {
                setView("list");
                router.refresh();
              }}
            >
              ← Back to list
            </button>
            {slug && (
              <Link
                href={`/field-notes/${slug}?preview=true`}
                target="_blank"
                className="btn secondary small"
                style={{ textDecoration: "none" }}
              >
                Preview ↗
              </Link>
            )}
            <button className="btn primary small" type="button" disabled={isPending} onClick={() => handleSave(false)}>
              {isPending ? "Saving..." : currentStatus === "draft" ? "Save Draft" : "Save Changes"}
            </button>
            {currentStatus === "draft" ? (
              <button
                className="btn secondary small"
                type="button"
                disabled={isPending}
                onClick={() => handleSave(true)}
                style={{ background: "var(--mint-soft)", borderColor: "var(--mint-strong)", color: "#14532d", fontWeight: 600 }}
              >
                Publish Now
              </button>
            ) : currentStatus === "published" ? (
              <button
                className="btn ghost small"
                type="button"
                disabled={isPending}
                onClick={() => {
                  if (editingNoteId) {
                    setConfirmModal({ action: "unpublish", noteId: editingNoteId, noteTitle: title });
                  }
                }}
              >
                Unpublish
              </button>
            ) : null}
          </div>

          <div style={{ display: "grid", gap: "24px" }} className="settings-layout">
            <div style={{ minWidth: 0 }}>
              <div className="settings-section" style={{ padding: "20px" }}>
                <h3 style={{ margin: "0 0 16px" }}>Note Details</h3>
                <div style={{ display: "grid", gap: "16px" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                      Title <span style={{ color: "var(--coral)" }}>*</span>
                    </label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => handleTitleChange(e.target.value)}
                      placeholder="e.g. What great hiring managers do differently in week one"
                      style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--line-strong)" }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                      Slug (URL identifier) <span style={{ color: "var(--coral)" }}>*</span>
                    </label>
                    <input
                      type="text"
                      value={slug}
                      onChange={(e) => setSlug(e.target.value.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-"))}
                      placeholder="great-hiring-managers-week-one"
                      className="mono"
                      style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--line-strong)" }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                      Excerpt
                    </label>
                    <textarea
                      rows={2}
                      value={excerpt}
                      onChange={(e) => setExcerpt(e.target.value)}
                      placeholder="One or two sentences on what the reader will take away..."
                      style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--line-strong)" }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                      Cover Image (optional · Cloudflare R2)
                    </label>
                    <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                      <input type="file" accept="image/*" onChange={handleImageUpload} disabled={uploadingImage} style={{ fontSize: "13px" }} />
                      {uploadingImage && <span style={{ fontSize: "12px", color: "var(--blue)" }}>Uploading to R2...</span>}
                    </div>
                    {coverImage && (
                      <p style={{ fontSize: "11.5px", color: "var(--muted)", marginTop: "4px" }}>
                        Referenced: <code>{coverImage}</code>
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: "24px" }}>
                <StructuredBlockEditor
                  blocks={blocks}
                  onChange={setBlocks}
                  allowedBlockTypes={["paragraph", "heading", "blockquote", "callout", "list"]}
                  createBlock={createFieldNoteBlock}
                  eyebrowHint="KEEP IT SHORT"
                />
              </div>
            </div>

            <aside style={{ display: "grid", gap: "16px", alignContent: "start" }}>
              <div className="settings-section" style={{ padding: "16px 18px" }}>
                <h3 style={{ fontSize: "14px", margin: "0 0 8px" }}>Publishing State</h3>
                <p style={{ fontSize: "12.5px", color: "var(--muted)", margin: "0 0 12px", lineHeight: 1.5 }}>
                  Status: <strong style={{ textTransform: "capitalize" }}>{currentStatus}</strong>
                </p>
                <div style={{ display: "grid", gap: "8px" }}>
                  {currentStatus === "draft" ? (
                    <button type="button" className="btn primary small" onClick={() => handleSave(true)} style={{ width: "100%" }}>
                      Publish to Live Site
                    </button>
                  ) : currentStatus === "published" ? (
                    <button
                      type="button"
                      className="btn secondary small"
                      onClick={() => {
                        if (editingNoteId) setConfirmModal({ action: "unpublish", noteId: editingNoteId, noteTitle: title });
                      }}
                      style={{ width: "100%" }}
                    >
                      Unpublish (Return to Draft)
                    </button>
                  ) : null}
                  {editingNoteId && currentStatus !== "archived" && (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => setConfirmModal({ action: "archive", noteId: editingNoteId, noteTitle: title })}
                      style={{ color: "var(--coral)", width: "100%" }}
                    >
                      Archive Note
                    </button>
                  )}
                </div>
              </div>

              <div className="settings-section" style={{ padding: "16px 18px" }}>
                <h3 style={{ fontSize: "14px", margin: "0 0 8px" }}>SEO Quick View</h3>
                <div className="seo-preview" style={{ marginTop: "10px" }}>
                  <div className="sp-url">decodedhiring.com › field-notes › {slug || "slug"}</div>
                  <div className="sp-title">{metaTitle || title || "Field Note Title"}</div>
                  <div className="sp-desc">{metaDescription || excerpt || "Excerpt will appear here in search previews."}</div>
                </div>
                <div style={{ marginTop: "12px", display: "grid", gap: "8px" }}>
                  <div>
                    <label style={{ fontSize: "11px", fontWeight: 600, display: "block" }}>Custom SEO Title</label>
                    <input
                      type="text"
                      value={metaTitle}
                      onChange={(e) => setMetaTitle(e.target.value)}
                      placeholder={title}
                      style={{ width: "100%", padding: "6px 8px", fontSize: "12px", borderRadius: "4px", border: "1px solid var(--line)" }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: "11px", fontWeight: 600, display: "block" }}>Custom Meta Description</label>
                    <textarea
                      rows={2}
                      value={metaDescription}
                      onChange={(e) => setMetaDescription(e.target.value)}
                      placeholder={excerpt}
                      style={{ width: "100%", padding: "6px 8px", fontSize: "12px", borderRadius: "4px", border: "1px solid var(--line)" }}
                    />
                  </div>
                </div>
              </div>

              {editingNoteId && (
                <div className="settings-section" style={{ padding: "16px 18px" }}>
                  <h3 style={{ fontSize: "14px", margin: "0 0 8px" }}>Revision History</h3>
                  {revisions.length === 0 ? (
                    <p style={{ fontSize: "12px", color: "var(--muted)", margin: 0 }}>
                      No revisions yet. Publishing or editing a published note records a snapshot here.
                    </p>
                  ) : (
                    <ol style={{ margin: 0, paddingLeft: "18px", display: "grid", gap: "8px", fontSize: "12.5px" }}>
                      {revisions.map((r) => (
                        <li key={r.id}>
                          <strong style={{ textTransform: "capitalize" }}>{r.trigger}</strong>
                          {" · "}
                          {new Date(r.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          <br />
                          <span style={{ color: "var(--muted)" }}>{r.title}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </aside>
          </div>
        </div>
      )}
    </>
  );
}
