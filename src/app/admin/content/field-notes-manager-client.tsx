"use client";

import { EmptyState, Toast, useToast, Card, FileDrop, StatusFilters, humanLabel, Button, Input, DataTable, Textarea } from "../_ui";
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
  startNew?: boolean;
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

export function FieldNotesManagerClient({ startNew = false, initialNotes }: FieldNotesManagerClientProps) {
  const router = useRouter();
  const [isPending] = useTransition();

  const [view, setView] = useState<"list" | "editor">(startNew ? "editor" : "list");
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
  const [blocks, setBlocks] = useState<FieldNoteBlock[]>(startNew ? [{ id: "b-initial-1", type: "paragraph", text: "What did you notice..." }] : []);
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [currentStatus, setCurrentStatus] = useState<FieldNoteStatus>("draft");
  const [revisions, setRevisions] = useState<FieldNoteRevision[]>([]);

  const [toast, showToast] = useToast();
  const [confirmModal, setConfirmModal] = useState<{
    action: "publish" | "unpublish" | "archive";
    noteId: string;
    noteTitle: string;
  } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);


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

  const renderActions = (n: FieldNote) => (<div className="row-actions" >
    <Button className="btn secondary small" type="button" onClick={() => handleEditNote(n)}>
      Edit
    </Button>
    <Link
      href={`/field-notes/${n.slug}?preview=true`}
      target="_blank"
      // New-tab staff preview: never prefetch. The segment tree prefetch drops
      // ?preview=true, so it renders (and caches) the PUBLIC slug, racing publish.
      prefetch={false}
      className="btn ghost small"

    >
      Preview
    </Link>
    {n.status === "published" ? (
      <Button
        className="btn ghost small"
        type="button"
        onClick={() => setConfirmModal({ action: "unpublish", noteId: n.id, noteTitle: n.title })}
      >
        Unpublish
      </Button>
    ) : n.status === "draft" ? (
      <Button
        className="btn ghost small"
        type="button"
        onClick={() => setConfirmModal({ action: "publish", noteId: n.id, noteTitle: n.title })}
      >
        Publish
      </Button>
    ) : null}
    {n.status !== "archived" && (
      <Button
        className="btn ghost small"
        type="button"
        onClick={() => setConfirmModal({ action: "archive", noteId: n.id, noteTitle: n.title })}
      >
        Archive
      </Button>
    )}
  </div>);

  return (
    <>
      {toast && (
        <div className="toast-stack">
          <Toast title={toast.title} error={toast.type === "error"}>{toast.message}</Toast>
        </div>
      )}

      {confirmModal && (
        <div className="dialog s-stack s-place-items-center" >
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
              <Button type="button" className="btn ghost small" onClick={() => setConfirmModal(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                className={`btn ${confirmModal.action === "archive" ? "danger" : "primary"} small`}
                onClick={handleConfirmAction}
              >
                Confirm {confirmModal.action}
              </Button>
            </div>
          </div>
        </div>
      )}

      {view === "list" && (
        <div>

          <div className="filter-bar s-margin-top-18px" >
            <div className="search">
              <Input
                type="search"
                placeholder="Search title, slug…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search field notes"
              />
            </div>
            <StatusFilters value={statusFilter} onChange={setStatusFilter} items={[{ value: "all", label: "All", count: notes.length }, ...["published", "draft", "archived"].map(value => ({ value, label: humanLabel(value), count: notes.filter(item => item.status === value).length }))]} />
            <Button className="btn primary small s-bold" type="button" onClick={handleNewNote} >
              ＋ New Field Note
            </Button>
          </div>

          <div className="table-wrap s-margin-top-12px" >
            <div className="table-scroll">
              <DataTable className="data">
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
                      <td className="s-text-align-center s-padding-32px s-muted" colSpan={5} >
                        <EmptyState icon="edit" title="An observation worth sharing?" action={<Button variant="primary" onClick={handleNewNote}>＋ New Field Note</Button>}>No field notes match the selected filters.</EmptyState>
                      </td>
                    </tr>
                  ) : (
                    filteredNotes.map((n) => (
                      <tr key={n.id}>
                        <td>
                          <span className="cell-main s-block" >
                            {n.title}
                          </span>
                          <span className="cell-sub s-block" >
                            /field-notes/{n.slug}
                          </span>
                        </td>
                        <td>
                          <span className={`lifecycle ${n.status}`}>{n.status.toUpperCase()}</span>
                        </td>
                        <td className="num">{n.publishedAt ? formatDate(n.publishedAt) : "—"}</td>
                        <td className="num">{formatDate(n.updatedAt)}</td>
                        <td>
                          {renderActions(n)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </DataTable>
            </div>

            <div className="data-card-list">
              {filteredNotes.length === 0 && <EmptyState icon="content" title="No field notes here yet" action={<Button variant="primary" onClick={handleNewNote}>{"＋ New Field Note"}</Button>}>Try another filter, or start a fresh draft.</EmptyState>}
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
                  {renderActions(n)}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {view === "editor" && (
        <div>
          <div className="editor-subhead" >
            <span className="es-title">{title || "Untitled Field Note"}</span>
            <span className={`lifecycle ${currentStatus}`}>{currentStatus.toUpperCase()}</span>
            <span className="es-saved">✓ {isPending ? "Saving..." : "Ready"}</span>
            <span className="es-spacer"></span>
            <Button
              className="btn ghost small"
              type="button"
              onClick={() => {
                setView("list");
                router.refresh();
              }}
            >
              ← Back to list
            </Button>
            {slug && (
              <Link
                href={`/field-notes/${slug}?preview=true`}
                target="_blank"
                // New-tab staff preview: never prefetch. The segment tree prefetch drops
                // ?preview=true, so it renders (and caches) the PUBLIC slug, racing publish.
                prefetch={false}
                className="btn secondary small"

              >
                Preview ↗
              </Link>
            )}
            <Button className="btn secondary small" type="button" disabled={isPending} onClick={() => handleSave(false)}>
              {isPending ? "Saving..." : currentStatus === "draft" ? "Save Draft" : "Save Changes"}
            </Button>
            {currentStatus === "draft" ? (
              <Button
                className="btn primary small"
                type="button"
                disabled={isPending}
                onClick={() => handleSave(true)}

              >
                Publish Now
              </Button>
            ) : currentStatus === "published" ? (
              <Button
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
              </Button>
            ) : null}
          </div>

          <div className="publishing-editor"><div className="editor-main"><Card className="editor-copy"><div>
            <label htmlFor="content-field-19797" className="s-block s-text-sm s-bold s-margin-bottom-6px" >
              Title <span className="s-danger" >*</span>
            </label>
            <Input id="content-field-19797" className="s-full s-padding-8px-12px"
              type="text"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="e.g. What great hiring managers do differently in week one"

            />
          </div><div>
              <label htmlFor="content-field-20418" className="s-block s-text-sm s-bold s-margin-bottom-6px" >
                Excerpt
              </label>
              <Textarea id="content-field-20418" className="s-full s-padding-8px-12px"
                rows={2}
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
                placeholder="One or two sentences on what the reader will take away..."

              />
            </div></Card><StructuredBlockEditor
              blocks={blocks}
              onChange={setBlocks}
              allowedBlockTypes={["paragraph", "heading", "blockquote", "callout", "list"]}
              createBlock={createFieldNoteBlock}
              eyebrowHint="Build your story, one block at a time"
            /></div><aside className="editor-sidebar"><div className="settings-section s-padding-16px-18px" >
              <h3 className="s-text-sm s-margin-0-0-8px" >Publishing</h3>
              <p className="s-text-sm s-muted s-margin-0-0-12px s-line-height-1-5" >
                Status: <strong >{currentStatus}</strong>
              </p>
              <div className="s-stack s-gap-8px" >
                {currentStatus === "draft" ? (
                  <Button type="button" className="btn primary small s-full" onClick={() => handleSave(true)} >
                    Publish to Live Site
                  </Button>
                ) : currentStatus === "published" ? (
                  <Button
                    type="button"
                    className="btn secondary small s-full"
                    onClick={() => {
                      if (editingNoteId) setConfirmModal({ action: "unpublish", noteId: editingNoteId, noteTitle: title });
                    }}

                  >
                    Unpublish (Return to Draft)
                  </Button>
                ) : null}
                {editingNoteId && currentStatus !== "archived" && (
                  <Button
                    type="button"
                    className="btn ghost small s-danger s-full"
                    onClick={() => setConfirmModal({ action: "archive", noteId: editingNoteId, noteTitle: title })}

                  >
                    Archive Note
                  </Button>
                )}
              </div>
            </div><Card className="editor-address"><h3>Address &amp; discovery</h3><div>
              <label htmlFor="content-field-23306" className="s-block s-text-sm s-bold s-margin-bottom-6px" >
                Slug (URL identifier) <span className="s-danger" >*</span>
              </label>
              <Input id="content-field-23306"
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-"))}
                placeholder="great-hiring-managers-week-one"
                className="mono s-full s-padding-8px-12px"

              />
            </div></Card><Card><h3>Cover image</h3><div>
              <label className="s-block s-text-sm s-bold s-margin-bottom-6px" >
                Choose a cover image
              </label>
              <div className="s-row s-gap-12px s-align-items-center" >
                <FileDrop className="s-text-sm" type="file" accept="image/*" onChange={handleImageUpload} disabled={uploadingImage} aria-label="Cover image" />
                {uploadingImage && <span className="s-text-sm s-accent" >Uploading...</span>}
              </div>
              {coverImage && (
                <p className="s-text-xs s-muted s-margin-top-4px" >
                  Referenced: <code>{coverImage}</code>
                </p>
              )}
            </div></Card><div className="settings-section s-padding-16px-18px" >
                <h3 className="s-text-sm s-margin-0-0-8px" >Search preview</h3>
                <div className="seo-preview s-margin-top-10px" >
                  <div className="sp-url">decodedhiring.com › field-notes › {slug || "slug"}</div>
                  <div className="sp-title">{metaTitle || title || "Field Note Title"}</div>
                  <div className="sp-desc">{metaDescription || excerpt || "Excerpt will appear here in search previews."}</div>
                </div>
                <div className="s-margin-top-12px s-stack s-gap-8px" >
                  <div>
                    <label htmlFor="content-field-25506" className="s-text-xs s-bold s-block" >Custom SEO Title</label>
                    <Input id="content-field-25506" className="s-full s-padding-6px-8px s-text-sm"
                      type="text"
                      value={metaTitle}
                      onChange={(e) => setMetaTitle(e.target.value)}
                      placeholder={title}

                    />
                  </div>
                  <div>
                    <label htmlFor="content-field-26053" className="s-text-xs s-bold s-block" >Custom Meta Description</label>
                    <Textarea id="content-field-26053" className="s-full s-padding-6px-8px s-text-sm"
                      rows={2}
                      value={metaDescription}
                      onChange={(e) => setMetaDescription(e.target.value)}
                      placeholder={excerpt}

                    />
                  </div>
                </div>
              </div>
              {editingNoteId && (
                <div className="settings-section s-padding-16px-18px" >
                  <h3 className="s-text-sm s-margin-0-0-8px" >Revision History</h3>
                  {revisions.length === 0 ? (
                    <p className="s-text-sm s-muted s-margin-0" >
                      No revisions yet. Publishing or editing a published note records a snapshot here.
                    </p>
                  ) : (
                    <ol className="s-margin-0 s-padding-left-18px s-stack s-gap-8px s-text-sm" >
                      {revisions.map((r) => (
                        <li key={r.id}>
                          <strong >{r.trigger}</strong>
                          {" · "}
                          {new Date(r.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          <br />
                          <span className="s-muted" >{r.title}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}</aside></div>
        </div>
      )}
    </>
  );
}
