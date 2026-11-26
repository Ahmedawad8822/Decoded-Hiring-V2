"use client";

import { EmptyState, Toast, useToast, Card, FileDrop, StatusFilters, humanLabel, Button, Input, DataTable, Textarea } from "../_ui";
import React, { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Page, PageRevision } from "@/lib/db";
import { PageBlock, PageStatus } from "@/features/pages/types";
import { slugifyTitle } from "@/features/publishing/types";
import {
  StructuredBlockEditor,
  type StructuredBlockType,
} from "@/components/publishing/StructuredBlockEditor";
import {
  archivePageAction,
  createPageAction,
  getPageRevisionsAction,
  publishPageAction,
  restorePageAction,
  trashPageAction,
  unpublishPageAction,
  updatePageAction,
} from "@/features/pages/actions";

interface PagesManagerClientProps {
  startNew?: boolean;
  initialPages: Page[];
}

function createPageBlock(type: StructuredBlockType): PageBlock {
  const id = `b-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  switch (type) {
    case "heading":
      return { id, type: "heading", level: 2, text: "New section heading" };
    case "blockquote":
      return { id, type: "blockquote", text: "A point worth quoting..." };
    case "callout":
      return { id, type: "callout", tone: "note", label: "NOTE", text: "What this means in practice..." };
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

type ConfirmKind = "publish" | "unpublish" | "archive" | "restore" | "trash";

export function PagesManagerClient({ startNew = false, initialPages }: PagesManagerClientProps) {
  const router = useRouter();
  const [isPending] = useTransition();

  const [view, setView] = useState<"list" | "editor">(startNew ? "editor" : "list");
  const pages = initialPages;

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Editor form state (mirrors the Field Notes editor plus the page-only
  // fields: summary, SEO, noindex flag).
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState("");
  const [coverImage, setCoverImage] = useState("");
  const [blocks, setBlocks] = useState<PageBlock[]>(startNew ? [{ id: "b-initial-1", type: "paragraph", text: "What should this page say..." }] : []);
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [noindex, setNoindex] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<PageStatus>("draft");
  const [revisions, setRevisions] = useState<PageRevision[]>([]);

  const [toast, showToast] = useToast();
  const [confirmModal, setConfirmModal] = useState<{
    action: ConfirmKind;
    pageId: string;
    pageTitle: string;
  } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const loadRevisions = async (pageId: string) => {
    const res = await getPageRevisionsAction(pageId);
    if (res.ok && res.data) setRevisions(res.data);
  };

  const handleNewPage = () => {
    setEditingPageId(null);
    setTitle("");
    setSlug("");
    setSummary("");
    setCoverImage("");
    setBlocks([{ id: `b-${Date.now()}-1`, type: "paragraph", text: "What should this page say..." }]);
    setMetaTitle("");
    setMetaDescription("");
    setNoindex(false);
    setCurrentStatus("draft");
    setRevisions([]);
    setView("editor");
  };

  const handleEditPage = (page: Page) => {
    setEditingPageId(page.id);
    setTitle(page.title);
    setSlug(page.slug);
    setSummary(page.summary || "");
    setCoverImage(page.coverImage || "");
    setMetaTitle(page.metaTitle || "");
    setMetaDescription(page.metaDescription || "");
    setNoindex(page.noindex ?? false);
    setCurrentStatus(page.status);
    try {
      setBlocks(JSON.parse(page.body) as PageBlock[]);
    } catch {
      setBlocks([]);
    }
    setRevisions([]);
    setView("editor");
    loadRevisions(page.id);
  };

  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
    if (!editingPageId) setSlug(slugifyTitle(newTitle));
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImage(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("namespace", "pages");
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
    if (editingPageId) {
      const res = await updatePageAction({
        id: editingPageId,
        title,
        slug,
        summary,
        coverImage: coverImage || null,
        metaTitle: metaTitle || title,
        metaDescription: metaDescription || summary,
        noindex,
        body: blocks,
      });
      if (!res.ok) {
        showToast("Update Failed", res.error || "Could not save page", "error");
        return;
      }
      if (publishImmediately) {
        const pubRes = await publishPageAction(editingPageId);
        if (pubRes.ok) {
          setCurrentStatus("published");
          showToast("Published!", "Page is now live.");
        } else {
          showToast("Publish Failed", pubRes.error || "Failed to publish", "error");
        }
      } else {
        showToast("Saved", "Page draft saved.");
      }
      loadRevisions(editingPageId);
    } else {
      const res = await createPageAction({
        title,
        slug,
        summary,
        coverImage: coverImage || null,
        metaTitle: metaTitle || title,
        metaDescription: metaDescription || summary,
        noindex,
        body: blocks,
      });
      if (!res.ok) {
        showToast("Creation Failed", res.error || "Could not create page", "error");
        return;
      }
      if (res.data?.id) {
        setEditingPageId(res.data.id);
        if (publishImmediately) {
          const pubRes = await publishPageAction(res.data.id);
          if (pubRes.ok) {
            setCurrentStatus("published");
            showToast("Published!", "Page is now live.");
          }
        } else {
          showToast("Created", "New page draft created.");
        }
        loadRevisions(res.data.id);
      }
    }
    router.refresh();
  };

  const handleConfirmAction = async () => {
    if (!confirmModal) return;
    const { action, pageId } = confirmModal;
    setConfirmModal(null);

    if (action === "publish") {
      const res = await publishPageAction(pageId);
      if (res.ok) {
        setCurrentStatus("published");
        showToast("Published", "Page published to live site.");
      } else {
        showToast("Action Failed", res.error || "Publish failed", "error");
      }
    } else if (action === "unpublish") {
      const res = await unpublishPageAction(pageId);
      if (res.ok) {
        setCurrentStatus("draft");
        showToast("Unpublished", "Page returned to draft.");
      } else {
        showToast("Action Failed", res.error || "Unpublish failed", "error");
      }
    } else if (action === "archive") {
      const res = await archivePageAction(pageId);
      if (res.ok) {
        setCurrentStatus("archived");
        showToast("Archived", "Page has been archived.");
      } else {
        showToast("Action Failed", res.error || "Archive failed", "error");
      }
    } else if (action === "restore") {
      const res = await restorePageAction(pageId);
      if (res.ok) {
        setCurrentStatus("draft");
        showToast("Restored", "Page restored to draft.");
      } else {
        showToast("Action Failed", res.error || "Restore failed", "error");
      }
    } else if (action === "trash") {
      const res = await trashPageAction(pageId);
      if (res.ok) {
        showToast("Moved to Trash", "Page moved to Trash. It is hidden everywhere until restored.");
        setView("list");
      } else {
        showToast("Action Failed", res.error || "Move to Trash failed", "error");
      }
    }
    if (editingPageId && action !== "trash") loadRevisions(editingPageId);
    router.refresh();
  };

  const filteredPages = pages.filter((p) => {
    const matchesSearch =
      p.title.toLowerCase().includes(search.toLowerCase()) ||
      p.slug.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" ? true : p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const renderActions = (p: Page) => (<div className="row-actions" >
    <Button className="btn secondary small" type="button" onClick={() => handleEditPage(p)}>
      Edit
    </Button>
    <Link
      href={`/${p.slug}?preview=true`}
      target="_blank"
      // New-tab staff preview: never prefetch. The segment tree prefetch drops
      // ?preview=true, so it renders (and caches) the PUBLIC slug, racing publish.
      prefetch={false}
      className="btn ghost small"

    >
      Preview
    </Link>
    {p.status === "published" ? (
      <Button
        className="btn ghost small"
        type="button"
        onClick={() => setConfirmModal({ action: "unpublish", pageId: p.id, pageTitle: p.title })}
      >
        Unpublish
      </Button>
    ) : p.status === "draft" ? (
      <Button
        className="btn ghost small"
        type="button"
        onClick={() => setConfirmModal({ action: "publish", pageId: p.id, pageTitle: p.title })}
      >
        Publish
      </Button>
    ) : (
      <Button
        className="btn ghost small"
        type="button"
        onClick={() => setConfirmModal({ action: "restore", pageId: p.id, pageTitle: p.title })}
      >
        Restore to draft
      </Button>
    )}
    {p.status !== "archived" && (
      <Button
        className="btn ghost small"
        type="button"
        onClick={() => setConfirmModal({ action: "archive", pageId: p.id, pageTitle: p.title })}
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
                {confirmModal.pageTitle}&rdquo;?
              </p>
              {confirmModal.action === "archive" && (
                <div className="dg-consequences">
                  <strong>Consequences:</strong>
                  <ul>
                    <li>The page will be hidden from the public site.</li>
                    <li>Existing links will return a 404 response.</li>
                  </ul>
                </div>
              )}
              {confirmModal.action === "trash" && (
                <div className="dg-consequences">
                  <strong>Consequences:</strong>
                  <ul>
                    <li>The page will be hidden from every Studio list and the public site.</li>
                    <li>It stays recoverable from Trash for 30 days, then is permanently deleted.</li>
                  </ul>
                </div>
              )}
              {confirmModal.action === "restore" && (
                <div className="dg-consequences">
                  <strong>Consequences:</strong>
                  <ul>
                    <li>The page returns to Draft — it will not go live until published.</li>
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
                className={`btn ${confirmModal.action === "trash" ? "danger" : "primary"} small`}
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
                aria-label="Search pages"
              />
            </div>
            <StatusFilters value={statusFilter} onChange={setStatusFilter} items={[{ value: "all", label: "All", count: pages.length }, ...["published", "draft", "archived"].map(value => ({ value, label: humanLabel(value), count: pages.filter(item => item.status === value).length }))]} />
            <Button className="btn primary small s-bold" type="button" onClick={handleNewPage} >
              ＋ New Page
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
                  {filteredPages.length === 0 ? (
                    <tr>
                      <td className="s-text-align-center s-padding-32px s-muted" colSpan={5} >
                        <EmptyState icon="edit" title="A page worth publishing?" action={<Button variant="primary" onClick={handleNewPage}>＋ New Page</Button>}>No pages match the selected filters.</EmptyState>
                      </td>
                    </tr>
                  ) : (
                    filteredPages.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <span className="cell-main s-block" >
                            {p.title}
                          </span>
                          <span className="cell-sub s-block" >
                            /{p.slug}
                            {p.noindex ? " · noindex" : ""}
                          </span>
                        </td>
                        <td>
                          <span className={`lifecycle ${p.status}`}>{p.status.toUpperCase()}</span>
                        </td>
                        <td className="num">{p.publishedAt ? formatDate(p.publishedAt) : "—"}</td>
                        <td className="num">{formatDate(p.updatedAt)}</td>
                        <td>
                          {renderActions(p)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </DataTable>
            </div>

            <div className="data-card-list">
              {filteredPages.length === 0 && <EmptyState icon="content" title="No pages here yet" action={<Button variant="primary" onClick={handleNewPage}>{"＋ New Page"}</Button>}>Try another filter, or start a fresh draft.</EmptyState>}
              {filteredPages.map((p) => (
                <div className="data-card" key={`card-${p.id}`}>
                  <div className="dc-head">
                    <span className="dc-title">{p.title}</span>
                    <span className={`lifecycle ${p.status}`}>{p.status.toUpperCase()}</span>
                  </div>
                  <p className="dc-meta">
                    <span>/{p.slug}</span>
                    <span>Updated {formatDate(p.updatedAt)}</span>
                  </p>
                  {renderActions(p)}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {view === "editor" && (
        <div>
          <div className="editor-subhead" >
            <span className="es-title">{title || "Untitled Page"}</span>
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
                href={`/${slug}?preview=true`}
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
                  if (editingPageId) {
                    setConfirmModal({ action: "unpublish", pageId: editingPageId, pageTitle: title });
                  }
                }}
              >
                Unpublish
              </Button>
            ) : null}
          </div>

          <div className="publishing-editor"><div className="editor-main"><Card className="editor-copy"><div>
            <label htmlFor="page-title" className="s-block s-text-sm s-bold s-margin-bottom-6px" >
              Title <span className="s-danger" >*</span>
            </label>
            <Input id="page-title" className="s-full s-padding-8px-12px"
              type="text"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="e.g. Frequently asked questions"

            />
          </div><div>
              <label htmlFor="page-summary" className="s-block s-text-sm s-bold s-margin-bottom-6px" >
                Summary
              </label>
              <Textarea id="page-summary" className="s-full s-padding-8px-12px"
                rows={2}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="One or two sentences shown under the title and in search results..."

              />
            </div></Card><StructuredBlockEditor
              blocks={blocks}
              onChange={setBlocks}
              allowedBlockTypes={["paragraph", "heading", "blockquote", "callout", "list"]}
              createBlock={createPageBlock}
              eyebrowHint="Build your page, one block at a time"
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
                      if (editingPageId) setConfirmModal({ action: "unpublish", pageId: editingPageId, pageTitle: title });
                    }}

                  >
                    Unpublish (Return to Draft)
                  </Button>
                ) : (
                  <Button
                    type="button"
                    className="btn primary small s-full"
                    onClick={() => {
                      if (editingPageId) setConfirmModal({ action: "restore", pageId: editingPageId, pageTitle: title });
                    }}

                  >
                    Restore to Draft
                  </Button>
                )}
                {editingPageId && currentStatus !== "archived" && (
                  <Button
                    type="button"
                    className="btn ghost small s-danger s-full"
                    onClick={() => setConfirmModal({ action: "archive", pageId: editingPageId, pageTitle: title })}

                  >
                    Archive Page
                  </Button>
                )}
                {editingPageId && currentStatus !== "published" && (
                  <Button
                    type="button"
                    className="btn ghost small s-danger s-full"
                    onClick={() => setConfirmModal({ action: "trash", pageId: editingPageId, pageTitle: title })}

                  >
                    Move to Trash
                  </Button>
                )}
              </div>
            </div><Card className="editor-address"><h3>Address &amp; discovery</h3><div>
              <label htmlFor="page-slug" className="s-block s-text-sm s-bold s-margin-bottom-6px" >
                Slug (URL identifier) <span className="s-danger" >*</span>
              </label>
              <Input id="page-slug"
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-"))}
                placeholder="frequently-asked-questions"
                className="mono s-full s-padding-8px-12px"

              />
              <p className="s-text-xs s-muted s-margin-top-4px" >
                The page will live at /{slug || "slug"}. Existing site sections are reserved.
              </p>
            </div>
              <div className="s-margin-top-12px s-stack s-gap-8px" >
                <label className="s-text-sm s-row s-gap-8px s-align-items-center" >
                  <input type="checkbox" checked={noindex} onChange={(e) => setNoindex(e.target.checked)} />
                  Hide from search (noindex)
                </label>
              </div>
            </Card><Card><h3>Hero image</h3><div>
              <label className="s-block s-text-sm s-bold s-margin-bottom-6px" >
                Choose a hero image
              </label>
              <div className="s-row s-gap-12px s-align-items-center" >
                <FileDrop className="s-text-sm" type="file" accept="image/*" onChange={handleImageUpload} disabled={uploadingImage} aria-label="Hero image" />
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
                  <div className="sp-url">decodedhiring.com › {slug || "slug"}</div>
                  <div className="sp-title">{metaTitle || title || "Page Title"}</div>
                  <div className="sp-desc">{metaDescription || summary || "Summary will appear here in search previews."}</div>
                </div>
                <div className="s-margin-top-12px s-stack s-gap-8px" >
                  <div>
                    <label htmlFor="page-meta-title" className="s-text-xs s-bold s-block" >Custom SEO Title</label>
                    <Input id="page-meta-title" className="s-full s-padding-6px-8px s-text-sm"
                      type="text"
                      value={metaTitle}
                      onChange={(e) => setMetaTitle(e.target.value)}
                      placeholder={title}

                    />
                  </div>
                  <div>
                    <label htmlFor="page-meta-desc" className="s-text-xs s-bold s-block" >Custom Meta Description</label>
                    <Textarea id="page-meta-desc" className="s-full s-padding-6px-8px s-text-sm"
                      rows={2}
                      value={metaDescription}
                      onChange={(e) => setMetaDescription(e.target.value)}
                      placeholder={summary}

                    />
                  </div>
                </div>
              </div>
              {editingPageId && currentStatus === "draft" && (
                <div className="settings-section s-padding-16px-18px" >
                  <h3 className="s-text-sm s-margin-0-0-8px" >Trash &amp; deletion</h3>
                  <p className="s-text-xs s-muted" >
                    Move the page to Trash first (Publishing panel). Trashed pages can be restored within 30 days,
                    or permanently deleted from the Trash page by typing the exact page title.
                  </p>
                </div>
              )}
              {editingPageId && (
                <div className="settings-section s-padding-16px-18px" >
                  <h3 className="s-text-sm s-margin-0-0-8px" >Revision History</h3>
                  {revisions.length === 0 ? (
                    <p className="s-text-sm s-muted s-margin-0" >
                      No revisions yet. Publishing or editing a published page records a snapshot here.
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
