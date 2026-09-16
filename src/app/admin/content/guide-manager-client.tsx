"use client";

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
  initialGuides: Guide[];
  currentUser: { id: string; email: string; name?: string | null };
}

export function GuideManagerClient({ initialGuides }: GuideManagerClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // View state: "list" | "editor"
  const [view, setView] = useState<"list" | "editor">("list");
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
  const [blocks, setBlocks] = useState<GuideBlock[]>([]);
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [currentStatus, setCurrentStatus] = useState<"draft" | "published" | "archived">("draft");

  // UI state
  const [toast, setToast] = useState<{ title: string; message: string; type?: "info" | "error" } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    action: "publish" | "unpublish" | "archive";
    guideId: string;
    guideTitle: string;
  } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const showToast = (title: string, message: string, type: "info" | "error" = "info") => {
    setToast({ title, message, type });
    setTimeout(() => setToast(null), 4000);
  };

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

    startTransition(async () => {
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
          author: "Ahmed Awad",
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
    });
  };

  const handleConfirmAction = async () => {
    if (!confirmModal) return;
    const { action, guideId } = confirmModal;
    setConfirmModal(null);

    startTransition(async () => {
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
    });
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

  return (
    <>
      {/* Toast Stack */}
      {toast && (
        <div className="toast-stack">
          <div className={`toast ${toast.type === "error" ? "error" : ""}`}>
            <b>{toast.title}</b>
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmModal && (
        <div className="dialog" style={{ display: "grid", placeItems: "center" }}>
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
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setConfirmModal(null)}
              >
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

      {/* ========================================================================= */}
      {/* 1. LIST VIEW (STU-03)                                                     */}
      {/* ========================================================================= */}
      {view === "list" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px", flexWrap: "wrap" }}>
            <h1 className="a-h1" style={{ fontSize: "24px", fontWeight: 700, margin: 0 }}>
              Content
            </h1>
            <span style={{ fontSize: "12.5px", color: "var(--muted)" }}>
              Guides publishing slice — Admin creates, drafts, publishes & archives.
            </span>
          </div>

          {/* Filter Bar */}
          <div className="filter-bar" style={{ marginTop: "18px" }}>
            <div className="search">
              <input
                type="search"
                placeholder="Search title, slug, tag…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search content"
              />
            </div>
            <select aria-label="Filter kind" defaultValue="Guides">
              <option value="Guides">Guides</option>
            </select>
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
            <button
              className="btn primary small"
              type="button"
              onClick={handleNewGuide}
              style={{ fontWeight: 600 }}
            >
              ＋ New Guide
            </button>
          </div>

          {/* Desktop Table */}
          <div className="table-wrap" style={{ marginTop: "12px" }}>
            <div className="table-scroll">
              <table className="data">
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
                      <td colSpan={5} style={{ textAlign: "center", padding: "32px", color: "var(--muted)" }}>
                        No guides match the selected filters.
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
                            <span className="cell-main" style={{ display: "block" }}>
                              {g.title}
                            </span>
                            <span className="cell-sub" style={{ display: "block" }}>
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
                            <div style={{ display: "flex", gap: "6px" }}>
                              <button
                                className="btn secondary small"
                                type="button"
                                onClick={() => handleEditGuide(g)}
                              >
                                Edit
                              </button>
                              <Link
                                href={`/guides/${g.slug}?preview=true`}
                                target="_blank"
                                className="btn ghost small"
                                style={{ textDecoration: "none" }}
                              >
                                Preview
                              </Link>
                              {g.status === "published" ? (
                                <button
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
                                </button>
                              ) : g.status === "draft" ? (
                                <button
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
                                </button>
                              ) : null}
                              {g.status !== "archived" && (
                                <button
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
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="data-card-list">
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
                  <div className="dc-actions">
                    <button className="btn secondary small" type="button" onClick={() => handleEditGuide(g)}>
                      Edit
                    </button>
                    <Link
                      href={`/guides/${g.slug}?preview=true`}
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

      {/* ========================================================================= */}
      {/* 2. EDITOR VIEW (STU-04)                                                   */}
      {/* ========================================================================= */}
      {view === "editor" && (
        <div>
          {/* Editor Subhead */}
          <div className="editor-subhead" style={{ top: "56px", borderRadius: "8px 8px 0 0", margin: "-8px -8px 20px" }}>
            <span className="es-title">{title || "Untitled Guide"}</span>
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
                href={`/guides/${slug}?preview=true`}
                target="_blank"
                className="btn secondary small"
                style={{ textDecoration: "none" }}
              >
                Preview ↗
              </Link>
            )}

            <button
              className="btn primary small"
              type="button"
              disabled={isPending}
              onClick={() => handleSave(false)}
            >
              {isPending ? "Saving..." : "Save Draft"}
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
                  if (editingGuideId) {
                    setConfirmModal({ action: "unpublish", guideId: editingGuideId, guideTitle: title });
                  }
                }}
              >
                Unpublish
              </button>
            ) : null}
          </div>

          {/* Form and Block Editor Grid */}
          <div style={{ display: "grid", gap: "24px" }} className="settings-layout">
            <div style={{ minWidth: 0 }}>
              <div className="settings-section" style={{ padding: "20px" }}>
                <h3 style={{ margin: "0 0 16px" }}>Guide Metadata</h3>
                <div style={{ display: "grid", gap: "16px" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                      Title <span style={{ color: "var(--coral)" }}>*</span>
                    </label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => handleTitleChange(e.target.value)}
                      placeholder="e.g. Talent Acquisition Strategy Is Not a Hiring Plan"
                      style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--line-strong)" }}
                    />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                    <div>
                      <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                        Slug (URL identifier) <span style={{ color: "var(--coral)" }}>*</span>
                      </label>
                      <input
                        type="text"
                        value={slug}
                        onChange={(e) => setSlug(e.target.value.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-"))}
                        placeholder="talent-acquisition-strategy"
                        className="mono"
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--line-strong)" }}
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                        Category
                      </label>
                      <select
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--line-strong)" }}
                      >
                        <option value="Strategy">Strategy</option>
                        <option value="Assessment">Assessment</option>
                        <option value="AI">AI</option>
                        <option value="Operations">Operations</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                      Excerpt / Dek
                    </label>
                    <textarea
                      rows={2}
                      value={excerpt}
                      onChange={(e) => setExcerpt(e.target.value)}
                      placeholder="A short, compelling summary of the guide..."
                      style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--line-strong)" }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>
                      Cover Image (Cloudflare R2)
                    </label>
                    <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleImageUpload}
                        disabled={uploadingImage}
                        style={{ fontSize: "13px" }}
                      />
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

              {/* Block Editor (shared structured mechanics; Guide block types retained) */}
              <div style={{ marginTop: "24px" }}>
                <StructuredBlockEditor
                  blocks={blocks}
                  onChange={setBlocks}
                  allowedBlockTypes={["heading", "paragraph", "blockquote", "callout", "list"]}
                  createBlock={createGuideBlock}
                  eyebrowHint="TYPED, NO EXEC ARBITRARY HTML"
                />
              </div>
            </div>

            {/* Right-hand Rail (Publish state & SEO preview) */}
            <aside style={{ display: "grid", gap: "16px", alignContent: "start" }}>
              <div className="settings-section" style={{ padding: "16px 18px" }}>
                <h3 style={{ fontSize: "14px", margin: "0 0 8px" }}>Publishing State</h3>
                <p style={{ fontSize: "12.5px", color: "var(--muted)", margin: "0 0 12px", lineHeight: 1.5 }}>
                  Status: <strong style={{ textTransform: "capitalize" }}>{currentStatus}</strong>
                </p>
                <div style={{ display: "grid", gap: "8px" }}>
                  {currentStatus === "draft" ? (
                    <button
                      type="button"
                      className="btn primary small"
                      onClick={() => handleSave(true)}
                      style={{ width: "100%" }}
                    >
                      Publish to Live Site
                    </button>
                  ) : currentStatus === "published" ? (
                    <button
                      type="button"
                      className="btn secondary small"
                      onClick={() => {
                        if (editingGuideId) {
                          setConfirmModal({ action: "unpublish", guideId: editingGuideId, guideTitle: title });
                        }
                      }}
                      style={{ width: "100%" }}
                    >
                      Unpublish (Return to Draft)
                    </button>
                  ) : null}

                  {editingGuideId && currentStatus !== "archived" && (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() =>
                        setConfirmModal({
                          action: "archive",
                          guideId: editingGuideId,
                          guideTitle: title,
                        })
                      }
                      style={{ color: "var(--coral)", width: "100%" }}
                    >
                      Archive Guide
                    </button>
                  )}
                </div>
              </div>

              {/* SEO Quick View */}
              <div className="settings-section" style={{ padding: "16px 18px" }}>
                <h3 style={{ fontSize: "14px", margin: "0 0 8px" }}>SEO Quick View</h3>
                <div className="seo-preview" style={{ marginTop: "10px" }}>
                  <div className="sp-url">decodedhiring.com › guides › {slug || "slug"}</div>
                  <div className="sp-title">{metaTitle || title || "Guide Title"}</div>
                  <div className="sp-desc">{metaDescription || excerpt || "Guide excerpt will appear here in search engine previews."}</div>
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
            </aside>
          </div>
        </div>
      )}
    </>
  );
}