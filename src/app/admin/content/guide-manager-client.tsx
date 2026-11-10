"use client";

import { EmptyState, Toast, useToast, Card, FileDrop, StatusFilters, humanLabel, Button, Input, DataTable, Textarea, Select } from "../_ui";
import React, { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Guide } from "@/lib/db";
import { GuideBlock } from "@/features/guides/types";
import {
  StructuredBlockEditor,
  type StructuredBlockType,
} from "@/components/publishing/StructuredBlockEditor";
import {
  createGuideAction,
  updateGuideAction,
  publishGuideAction,
  unpublishGuideAction,
  archiveGuideAction,
} from "@/features/guides/actions";

interface GuideManagerClientProps {
  startNew?: boolean;
  initialGuides: Guide[];
  currentUser: { id: string; email: string; name?: string | null };
}

export function GuideManagerClient({ startNew = false, initialGuides }: GuideManagerClientProps) {
  const router = useRouter();
  const [isPending] = useTransition();

  // View state: "list" | "editor"
  const [view, setView] = useState<"list" | "editor">(startNew ? "editor" : "list");
  const guides = initialGuides;

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Editor Form State
  const [editingGuideId, setEditingGuideId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState("Strategy");
  const [excerpt, setExcerpt] = useState("");
  const [coverImage, setCoverImage] = useState("");
  const [blocks, setBlocks] = useState<GuideBlock[]>(startNew ? [{ id: "b-initial-1", type: "paragraph", text: "Start writing the guide content here..." }] : []);
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [currentStatus, setCurrentStatus] = useState<"draft" | "published" | "archived">("draft");

  // UI state
  const [toast, showToast] = useToast();
  const [confirmModal, setConfirmModal] = useState<{
    action: "publish" | "unpublish" | "archive";
    guideId: string;
    guideTitle: string;
  } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  // Start creating new guide
  const handleNewGuide = () => {
    setEditingGuideId(null);
    setTitle("");
    setSlug("");
    setCategory("Strategy");
    setExcerpt("");
    setCoverImage("");
    setBlocks([
      {
        id: `b-${Date.now()}-1`,
        type: "paragraph",
        text: "Start writing the guide content here...",
      },
    ]);
    setMetaTitle("");
    setMetaDescription("");
    setCurrentStatus("draft");
    setView("editor");
  };

  // Open existing guide in editor
  const handleEditGuide = (guide: Guide) => {
    setEditingGuideId(guide.id);
    setTitle(guide.title);
    setSlug(guide.slug);
    setCategory(guide.category || "Strategy");
    setExcerpt(guide.excerpt || "");
    setCoverImage(guide.coverImage || "");
    setMetaTitle(guide.metaTitle || "");
    setMetaDescription(guide.metaDescription || "");
    setCurrentStatus(guide.status);

    try {
      setBlocks(JSON.parse(guide.body) as GuideBlock[]);
    } catch {
      setBlocks([]);
    }

    setView("editor");
  };

  // Auto-slugify
  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
    if (!editingGuideId) {
      const generatedSlug = newTitle
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      setSlug(generatedSlug);
    }
  };

  // Block factory (Guide defaults: evidence callouts, resource CTA support)
  const createGuideBlock = (type: StructuredBlockType): GuideBlock => {
    const id = `b-${Date.now()}`;
    let newBlock: GuideBlock;

    switch (type) {
      case "heading":
        newBlock = { id, type: "heading", level: 2, text: "New Section Heading" };
        break;
      case "paragraph":
        newBlock = { id, type: "paragraph", text: "New paragraph text..." };
        break;
      case "blockquote":
        newBlock = { id, type: "blockquote", text: "Quote text..." };
        break;
      case "callout":
        newBlock = { id, type: "callout", tone: "evidence", label: "EVIDENCE", text: "Evidence note..." };
        break;
      case "list":
        newBlock = { id, type: "list", style: "bullet", items: ["First point", "Second point"] };
        break;
    }

    return newBlock;
  };

  // Media upload handler
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingImage(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/media/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Upload failed");
      }

      setCoverImage(data.url);
      showToast("Image Uploaded", `Saved as ${data.filename}`);
    } catch (err: unknown) {
      showToast("Upload Error", (err as Error).message, "error");
    } finally {
      setUploadingImage(false);
    }
  };

  // Save / Publish handlers
  const handleSave = async (publishImmediately: boolean = false) => {
    if (!title.trim() || !slug.trim()) {
      showToast("Validation Error", "Title and Slug are required.", "error");
      return;
    }

    if (editingGuideId) {
      // Update existing guide
      const res = await updateGuideAction({
        id: editingGuideId,
        title,
        slug,
        excerpt,
        category,
        coverImage: coverImage || null,
        metaTitle: metaTitle || title,
        metaDescription: metaDescription || excerpt,
        body: blocks,
      });

      if (!res.ok) {
        showToast("Update Failed", res.error || "Could not save guide", "error");
        return;
      }

      if (publishImmediately) {
        const pubRes = await publishGuideAction(editingGuideId);
        if (pubRes.ok) {
          setCurrentStatus("published");
          showToast("Published!", "Guide is now live on the public site.");
        } else {
          showToast("Publish Failed", pubRes.error || "Failed to publish", "error");
        }
      } else {
        showToast("Saved", "Guide draft saved successfully.");
      }
    } else {
      // Create new guide
      const res = await createGuideAction({
        title,
        slug,
        excerpt,
        category,
        author: "Decoded Editorial",
        coverImage: coverImage || null,
        metaTitle: metaTitle || title,
        metaDescription: metaDescription || excerpt,
        body: blocks,
      });

      if (!res.ok) {
        showToast("Creation Failed", res.error || "Could not create guide", "error");
        return;
      }

      if (res.data?.id) {
        setEditingGuideId(res.data.id);
        if (publishImmediately) {
          const pubRes = await publishGuideAction(res.data.id);
          if (pubRes.ok) {
            setCurrentStatus("published");
            showToast("Published!", "Guide is now live on the public site.");
          }
        } else {
          showToast("Created", "New guide draft created.");
        }
      }
    }

    router.refresh();
  };

  const handleConfirmAction = async () => {
    if (!confirmModal) return;
    const { action, guideId } = confirmModal;
    setConfirmModal(null);

    if (action === "publish") {
      const res = await publishGuideAction(guideId);
      if (res.ok) {
        setCurrentStatus("published");
        showToast("Published", "Guide published to live site.");
      } else {
        showToast("Action Failed", res.error || "Publish failed", "error");
      }
    } else if (action === "unpublish") {
      const res = await unpublishGuideAction(guideId);
      if (res.ok) {
        setCurrentStatus("draft");
        showToast("Unpublished", "Guide returned to draft status.");
      } else {
        showToast("Action Failed", res.error || "Unpublish failed", "error");
      }
    } else if (action === "archive") {
      const res = await archiveGuideAction(guideId);
      if (res.ok) {
        setCurrentStatus("archived");
        showToast("Archived", "Guide has been archived.");
      } else {
        showToast("Action Failed", res.error || "Archive failed", "error");
      }
    }

    router.refresh();
  };

  // Filtered guides for list view
  const filteredGuides = guides.filter((g) => {
    const matchesSearch =
      g.title.toLowerCase().includes(search.toLowerCase()) ||
      g.slug.toLowerCase().includes(search.toLowerCase()) ||
      (g.category && g.category.toLowerCase().includes(search.toLowerCase()));

    const matchesStatus = statusFilter === "all" ? true : g.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const renderActions = (g: Guide) => (<div className="row-actions" >
    <Button
      className="btn secondary small"
      type="button"
      onClick={() => handleEditGuide(g)}
    >
      Edit
    </Button>
    <Link
      href={`/guides/${g.slug}?preview=true`}
      target="_blank"
      // New-tab staff preview: never prefetch. The segment tree prefetch drops
      // ?preview=true, so it renders (and caches) the PUBLIC slug, racing publish.
      prefetch={false}
      className="btn ghost small"

    >
      Preview
    </Link>
    {g.status === "published" ? (
      <Button
        className="btn ghost small"
        type="button"
        onClick={() =>
          setConfirmModal({
            action: "unpublish",
            guideId: g.id,
            guideTitle: g.title,
          })
        }
      >
        Unpublish
      </Button>
    ) : g.status === "draft" ? (
      <Button
        className="btn ghost small"
        type="button"
        onClick={() =>
          setConfirmModal({
            action: "publish",
            guideId: g.id,
            guideTitle: g.title,
          })
        }
      >
        Publish
      </Button>
    ) : null}
    {g.status !== "archived" && (
      <Button
        className="btn ghost small"
        type="button"
        onClick={() =>
          setConfirmModal({
            action: "archive",
            guideId: g.id,
            guideTitle: g.title,
          })
        }
      >
        Archive
      </Button>
    )}
  </div>);

  return (
    <>
      {/* Toast Stack */}
      {toast && (
        <div className="toast-stack">
          <Toast title={toast.title} error={toast.type === "error"}>{toast.message}</Toast>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmModal && (
        <div className="dialog s-stack s-place-items-center" >
          <div className="dg-panel">
            <h3>Confirm {confirmModal.action.toUpperCase()}</h3>
            <div className="dg-body">
              <p>
                Are you sure you want to <strong>{confirmModal.action}</strong> &ldquo;
                {confirmModal.guideTitle}&rdquo;?
              </p>
              {confirmModal.action === "archive" && (
                <div className="dg-consequences">
                  <strong>Consequences:</strong>
                  <ul>
                    <li>The guide will no longer be visible on /guides or accessible by public visitors.</li>
                    <li>Existing links will return a 404 response.</li>
                  </ul>
                </div>
              )}
              {confirmModal.action === "unpublish" && (
                <div className="dg-consequences">
                  <strong>Consequences:</strong>
                  <ul>
                    <li>The guide will return to Draft state and be removed from public discovery.</li>
                  </ul>
                </div>
              )}
            </div>
            <div className="dg-actions">
              <Button
                type="button"
                className="btn ghost small"
                onClick={() => setConfirmModal(null)}
              >
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

      {/* ========================================================================= */}
      {/* 1. LIST VIEW (STU-03)                                                     */}
      {/* ========================================================================= */}
      {view === "list" && (
        <div>

          {/* Filter Bar */}
          <div className="filter-bar s-margin-top-18px" >
            <div className="search">
              <Input
                type="search"
                placeholder="Search title, slug, tag…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search content"
              />
            </div>
            <StatusFilters value={statusFilter} onChange={setStatusFilter} items={[{ value: "all", label: "All", count: guides.length }, ...["published", "draft", "archived"].map(value => ({ value, label: humanLabel(value), count: guides.filter(item => item.status === value).length }))]} />
            <Button
              className="btn primary small s-bold"
              type="button"
              onClick={handleNewGuide}

            >
              ＋ New Guide
            </Button>
          </div>

          {/* Desktop Table */}
          <div className="table-wrap s-margin-top-12px" >
            <div className="table-scroll">
              <DataTable className="data">
                <thead>
                  <tr>
                    <th>Title & Slug</th>
                    <th>Kind</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGuides.length === 0 ? (
                    <tr>
                      <td className="s-text-align-center s-padding-32px s-muted" colSpan={5} >
                        <EmptyState icon="content" title="Make room for your next idea" action={<Button variant="primary" onClick={handleNewGuide}>＋ New Guide</Button>}>No guides match the selected filters.</EmptyState>
                      </td>
                    </tr>
                  ) : (
                    filteredGuides.map((g) => {
                      const updatedFormatted = new Date(g.updatedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      });

                      return (
                        <tr key={g.id}>
                          <td>
                            <span className="cell-main s-block" >
                              {g.title}
                            </span>
                            <span className="cell-sub s-block" >
                              /guides/{g.slug}
                            </span>
                          </td>
                          <td>Guide</td>
                          <td>
                            <span className={`lifecycle ${g.status}`}>
                              {g.status.toUpperCase()}
                            </span>
                          </td>
                          <td className="num">{updatedFormatted}</td>
                          <td>
                            {renderActions(g)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </DataTable>
            </div>

            {/* Mobile Cards */}
            <div className="data-card-list">
              {filteredGuides.length === 0 && <EmptyState icon="content" title="No guides here yet" action={<Button variant="primary" onClick={handleNewGuide}>{"＋ New Guide"}</Button>}>Try another filter, or start a fresh draft.</EmptyState>}
              {filteredGuides.map((g) => (
                <div className="data-card" key={`card-${g.id}`}>
                  <div className="dc-head">
                    <span className="dc-title">{g.title}</span>
                    <span className={`lifecycle ${g.status}`}>{g.status.toUpperCase()}</span>
                  </div>
                  <p className="dc-meta">
                    <span>/guides/{g.slug}</span>
                    <span>Updated {new Date(g.updatedAt).toLocaleDateString()}</span>
                  </p>
                  {renderActions(g)}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2. EDITOR VIEW (STU-04)                                                   */}
      {/* ========================================================================= */}
      {view === "editor" && (
        <div>
          {/* Editor Subhead */}
          <div className="editor-subhead" >
            <span className="es-title">{title || "Untitled Guide"}</span>
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
                href={`/guides/${slug}?preview=true`}
                target="_blank"
                // New-tab staff preview: never prefetch. The segment tree prefetch drops
                // ?preview=true, so it renders (and caches) the PUBLIC slug, racing publish.
                prefetch={false}
                className="btn secondary small"

              >
                Preview ↗
              </Link>
            )}

            <Button
              className="btn secondary small"
              type="button"
              disabled={isPending}
              onClick={() => handleSave(false)}
            >
              {isPending ? "Saving..." : "Save Draft"}
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
                  if (editingGuideId) {
                    setConfirmModal({ action: "unpublish", guideId: editingGuideId, guideTitle: title });
                  }
                }}
              >
                Unpublish
              </Button>
            ) : null}
          </div>

          {/* Form and Block Editor Grid */}
          <div className="publishing-editor"><div className="editor-main"><Card className="editor-copy"><div>
            <label htmlFor="content-field-21889" className="s-block s-text-sm s-bold s-margin-bottom-6px" >
              Title <span className="s-danger" >*</span>
            </label>
            <Input id="content-field-21889" className="s-full s-padding-8px-12px"
              type="text"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="e.g. Talent Acquisition Strategy Is Not a Hiring Plan"

            />
          </div><div>
              <label htmlFor="content-field-22511" className="s-block s-text-sm s-bold s-margin-bottom-6px" >
                Excerpt / Dek
              </label>
              <Textarea id="content-field-22511" className="s-full s-padding-8px-12px"
                rows={2}
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
                placeholder="A short, compelling summary of the guide..."

              />
            </div></Card><StructuredBlockEditor
              blocks={blocks}
              onChange={setBlocks}
              allowedBlockTypes={["heading", "paragraph", "blockquote", "callout", "list"]}
              createBlock={createGuideBlock}
              eyebrowHint="Build your story, one block at a time"
            /></div><aside className="editor-sidebar"><div className="settings-section s-padding-16px-18px" >
              <h3 className="s-text-sm s-margin-0-0-8px" >Publishing</h3>
              <p className="s-text-sm s-muted s-margin-0-0-12px s-line-height-1-5" >
                Status: <strong >{currentStatus}</strong>
              </p>
              <div className="s-stack s-gap-8px" >
                {currentStatus === "draft" ? (
                  <Button
                    type="button"
                    className="btn primary small s-full"
                    onClick={() => handleSave(true)}

                  >
                    Publish to Live Site
                  </Button>
                ) : currentStatus === "published" ? (
                  <Button
                    type="button"
                    className="btn secondary small s-full"
                    onClick={() => {
                      if (editingGuideId) {
                        setConfirmModal({ action: "unpublish", guideId: editingGuideId, guideTitle: title });
                      }
                    }}

                  >
                    Unpublish (Return to Draft)
                  </Button>
                ) : null}

                {editingGuideId && currentStatus !== "archived" && (
                  <Button
                    type="button"
                    className="btn ghost small s-danger s-full"
                    onClick={() =>
                      setConfirmModal({
                        action: "archive",
                        guideId: editingGuideId,
                        guideTitle: title,
                      })
                    }

                  >
                    Archive Guide
                  </Button>
                )}
              </div>
            </div><Card className="editor-address"><h3>Address &amp; discovery</h3><div>
              <label htmlFor="content-field-25712" className="s-block s-text-sm s-bold s-margin-bottom-6px" >
                Slug (URL identifier) <span className="s-danger" >*</span>
              </label>
              <Input id="content-field-25712"
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-"))}
                placeholder="talent-acquisition-strategy"
                className="mono s-full s-padding-8px-12px"

              />
            </div><div>
                  <label htmlFor="content-field-26405" className="s-block s-text-sm s-bold s-margin-bottom-6px" >
                    Category
                  </label>
                  <Select id="content-field-26405" className="s-full s-padding-8px-12px"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}

                  >
                    <option value="Strategy">Strategy</option>
                    <option value="Assessment">Assessment</option>
                    <option value="AI">AI</option>
                    <option value="Operations">Operations</option>
                  </Select>
                </div></Card><Card><h3>Cover image</h3><div>
                  <label className="s-block s-text-sm s-bold s-margin-bottom-6px" >
                    Choose a cover image
                  </label>
                  <div className="s-row s-gap-12px s-align-items-center" >
                    <FileDrop className="s-text-sm"
                      type="file"
                      accept="image/*"
                      onChange={handleImageUpload}
                      disabled={uploadingImage}

                      aria-label="Cover image" />
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
                  <div className="sp-url">decodedhiring.com › guides › {slug || "slug"}</div>
                  <div className="sp-title">{metaTitle || title || "Guide Title"}</div>
                  <div className="sp-desc">{metaDescription || excerpt || "Guide excerpt will appear here in search engine previews."}</div>
                </div>
                <div className="s-margin-top-12px s-stack s-gap-8px" >
                  <div>
                    <label htmlFor="content-field-28874" className="s-text-xs s-bold s-block" >Custom SEO Title</label>
                    <Input id="content-field-28874" className="s-full s-padding-6px-8px s-text-sm"
                      type="text"
                      value={metaTitle}
                      onChange={(e) => setMetaTitle(e.target.value)}
                      placeholder={title}

                    />
                  </div>
                  <div>
                    <label htmlFor="content-field-29421" className="s-text-xs s-bold s-block" >Custom Meta Description</label>
                    <Textarea id="content-field-29421" className="s-full s-padding-6px-8px s-text-sm"
                      rows={2}
                      value={metaDescription}
                      onChange={(e) => setMetaDescription(e.target.value)}
                      placeholder={excerpt}

                    />
                  </div>
                </div>
              </div></aside></div>
        </div>
      )}
    </>
  );
}
