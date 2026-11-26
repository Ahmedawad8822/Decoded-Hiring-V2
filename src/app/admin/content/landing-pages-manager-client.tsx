"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Select,
  StatusPill,
  Textarea,
  Toast,
  useToast,
} from "../_ui";
import type { LandingPage } from "@/lib/db";
import {
  LANDING_PAGE_BLOCK_TYPES,
  type LandingPageBlockType,
  type LandingPageSection,
  type LandingPageTargetKind,
} from "@/features/landing-pages/types";
import {
  archiveLandingPageAction,
  createLandingPageAction,
  moveLandingPageToTrashAction,
  publishLandingPageAction,
  restoreArchivedLandingPageAction,
  unpublishLandingPageAction,
  updateLandingPageAction,
} from "@/features/landing-pages/actions";

export type LandingTargetOptions = {
  offers: { id: string; title: string; active: boolean }[];
  courses: { id: string; title: string; status: string }[];
  guides: { id: string; title: string; status: string }[];
};

interface Props {
  startNew?: boolean;
  initialPages: LandingPage[];
  targetOptions: LandingTargetOptions;
}

const BLOCK_LABELS: Record<LandingPageBlockType, string> = {
  hero: "Hero",
  problem: "Problem",
  benefits: "Benefits",
  quote: "Proof quote",
  target_summary: "Target summary",
  faq: "FAQ",
  cta_band: "CTA band",
  lead_form: "Lead form",
};

function newBlock(type: LandingPageBlockType): LandingPageSection {
  const id = `s-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  switch (type) {
    case "hero":
      return { id, type, heading: "New headline", subheading: "" };
    case "problem":
      return { id, type, heading: "The problem", points: ["First sticking point"] };
    case "benefits":
      return { id, type, heading: "What changes", items: [{ title: "First win", text: "What it gives you." }] };
    case "quote":
      return { id, type, text: "What they said.", attribution: "" };
    case "target_summary":
      return { id, type };
    case "faq":
      return { id, type, items: [{ q: "Who is this for?", a: "Who it helps." }] };
    case "cta_band":
      return { id, type, heading: "Ready when you are" };
    case "lead_form":
      return { id, type, heading: "Tell us where it hurts" };
  }
}

function toInputValue(value: Date | string | null): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toDateOrNull(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function LandingPagesManagerClient({ startNew = false, initialPages, targetOptions }: Props) {
  const router = useRouter();
  const [toast, showToast] = useToast();
  const [view, setView] = useState<"list" | "editor">(startNew ? "editor" : "list");
  const [search, setSearch] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [targetKind, setTargetKind] = useState<LandingPageTargetKind>("course");
  const [targetOfferId, setTargetOfferId] = useState("");
  const [targetCourseId, setTargetCourseId] = useState("");
  const [targetGuideId, setTargetGuideId] = useState("");
  const [ctaLabel, setCtaLabel] = useState("Start now");
  const [sections, setSections] = useState<LandingPageSection[]>([]);
  const [addType, setAddType] = useState<LandingPageBlockType>("hero");
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [noindex, setNoindex] = useState(true);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [currentStatus, setCurrentStatus] = useState<string>("draft");
  const [saving, setSaving] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);

  const pages = initialPages.filter(
    (p) =>
      !search.trim() ||
      p.title.toLowerCase().includes(search.toLowerCase()) ||
      p.slug.includes(search.toLowerCase()) ||
      p.campaignName.toLowerCase().includes(search.toLowerCase()),
  );

  function resetForm() {
    setEditingId(null);
    setTitle("");
    setSlug("");
    setCampaignName("");
    setTargetKind("course");
    setTargetOfferId("");
    setTargetCourseId("");
    setTargetGuideId("");
    setCtaLabel("Start now");
    setSections([]);
    setSeoTitle("");
    setSeoDescription("");
    setNoindex(true);
    setStartsAt("");
    setEndsAt("");
    setCurrentStatus("draft");
    setConfirmTrash(false);
  }

  function handleNew() {
    resetForm();
    setView("editor");
  }

  function handleEdit(page: LandingPage) {
    setEditingId(page.id);
    setTitle(page.title);
    setSlug(page.slug);
    setCampaignName(page.campaignName);
    setTargetKind(page.targetKind);
    setTargetOfferId(page.targetOfferId ?? "");
    setTargetCourseId(page.targetCourseId ?? "");
    setTargetGuideId(page.targetGuideId ?? "");
    setCtaLabel(page.ctaLabel);
    try {
      setSections(JSON.parse(page.sections) as LandingPageSection[]);
    } catch {
      setSections([]);
    }
    setSeoTitle(page.seoTitle ?? "");
    setSeoDescription(page.seoDescription ?? "");
    setNoindex(page.noindex);
    setStartsAt(toInputValue(page.startsAt));
    setEndsAt(toInputValue(page.endsAt));
    setCurrentStatus(page.status);
    setConfirmTrash(false);
    setView("editor");
  }

  function handleTitleChange(next: string) {
    setTitle(next);
    if (!editingId) {
      setSlug(
        next.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      );
    }
  }

  function updateSection(id: string, patch: Partial<LandingPageSection>) {
    setSections((prev) => prev.map((s) => (s.id === id ? ({ ...s, ...patch } as LandingPageSection) : s)));
  }

  function moveSection(index: number, direction: -1 | 1) {
    setSections((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    const payload = {
      title: title.trim(),
      slug: slug.trim(),
      campaignName: campaignName.trim(),
      targetKind,
      targetOfferId: targetKind === "offer" && targetOfferId ? targetOfferId : null,
      targetCourseId: targetKind === "course" && targetCourseId ? targetCourseId : null,
      targetGuideId: targetKind === "guide" && targetGuideId ? targetGuideId : null,
      ctaLabel: ctaLabel.trim(),
      sections,
      seoTitle: seoTitle.trim() || null,
      seoDescription: seoDescription.trim() || null,
      noindex,
      startsAt: toDateOrNull(startsAt),
      endsAt: toDateOrNull(endsAt),
    };
    const result = editingId
      ? await updateLandingPageAction({ ...payload, id: editingId })
      : await createLandingPageAction(payload);
    setSaving(false);
    if (!result.ok) {
      showToast("Could not save", result.error, "error");
      return;
    }
    showToast(editingId ? "Landing page saved" : "Landing page created", `Slug: ${result.data.slug}`);
    router.refresh();
    setView("list");
  }

  async function runLifecycle(action: (id: string) => Promise<{ ok: boolean; error?: string }>, id: string, verb: string) {
    const result = await action(id);
    if (!result.ok) {
      showToast(`Could not ${verb}`, result.error ?? "Unknown error", "error");
      return;
    }
    showToast("Done", `Page ${verb}.`);
    router.refresh();
    setView("list");
  }

  if (view === "editor") {
    return (
      <div>
        {toast && <Toast title={toast.title} error={toast.type === "error"}>{toast.message}</Toast>}
        <Card>
          <h2>{editingId ? "Edit landing page" : "New landing page"}</h2>
          <p>Slug /go/{slug || "…"}</p>
          <Field label="Title" htmlFor="lp-title">
            <Input id="lp-title" value={title} onChange={(e) => handleTitleChange(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Slug" help="Lowercase letters, numbers and hyphens. Reserved while trashed.">
            <Input id="lp-slug" value={slug} onChange={(e) => setSlug(e.target.value)} maxLength={100} />
          </Field>
          <Field label="Campaign name" htmlFor="lp-campaign">
            <Input id="lp-campaign" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Target kind" htmlFor="lp-kind">
            <Select id="lp-kind" value={targetKind} onChange={(e) => setTargetKind(e.target.value as LandingPageTargetKind)}>
              <option value="course">Course</option>
              <option value="guide">Guide</option>
              <option value="offer">Offer</option>
            </Select>
          </Field>
          {targetKind === "offer" && (
            <Field label="Target offer" htmlFor="lp-offer">
              <Select id="lp-offer" value={targetOfferId} onChange={(e) => setTargetOfferId(e.target.value)}>
                <option value="">Select an offer…</option>
                {targetOptions.offers.map((o) => (
                  <option key={o.id} value={o.id}>{o.title}{o.active ? "" : " (inactive)"}</option>
                ))}
              </Select>
            </Field>
          )}
          {targetKind === "course" && (
            <Field label="Target course" htmlFor="lp-course">
              <Select id="lp-course" value={targetCourseId} onChange={(e) => setTargetCourseId(e.target.value)}>
                <option value="">Select a course…</option>
                {targetOptions.courses.map((c) => (
                  <option key={c.id} value={c.id}>{c.title} ({c.status})</option>
                ))}
              </Select>
            </Field>
          )}
          {targetKind === "guide" && (
            <Field label="Target guide" htmlFor="lp-guide">
              <Select id="lp-guide" value={targetGuideId} onChange={(e) => setTargetGuideId(e.target.value)}>
                <option value="">Select a guide…</option>
                {targetOptions.guides.map((g) => (
                  <option key={g.id} value={g.id}>{g.title} ({g.status})</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="CTA label" htmlFor="lp-cta">
            <Input id="lp-cta" value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Starts at (optional)" htmlFor="lp-starts">
            <Input id="lp-starts" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </Field>
          <Field label="Ends at (optional)" htmlFor="lp-ends">
            <Input id="lp-ends" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </Field>
          <Field label="SEO title (optional)" htmlFor="lp-seo-title">
            <Input id="lp-seo-title" value={seoTitle} onChange={(e) => setSeoTitle(e.target.value)} maxLength={100} />
          </Field>
          <Field label="SEO description (optional)" htmlFor="lp-seo-desc">
            <Textarea id="lp-seo-desc" value={seoDescription} onChange={(e) => setSeoDescription(e.target.value)} maxLength={300} />
          </Field>
          <Field label="Search indexing">
            <label>
              <input type="checkbox" checked={!noindex} onChange={(e) => setNoindex(!e.target.checked)} /> Allow search engines to index this page
            </label>
            <p className="help">Campaign pages default to noindex. Only opt in for evergreen campaigns.</p>
          </Field>
        </Card>

        <Card>
          <h2>Sections ({sections.length})</h2>
          <p>Only approved blocks. The target summary renders live data from the linked target.</p>
          {sections.map((section, index) => (
            <SectionEditor
              key={section.id}
              section={section}
              position={index}
              total={sections.length}
              onChange={(patch) => updateSection(section.id, patch)}
              onMove={(direction) => moveSection(index, direction)}
              onRemove={() => setSections((prev) => prev.filter((s) => s.id !== section.id))}
            />
          ))}
          <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
            <Select value={addType} onChange={(e) => setAddType(e.target.value as LandingPageBlockType)} aria-label="Block type">
              {LANDING_PAGE_BLOCK_TYPES.map((type) => (
                <option key={type} value={type}>{BLOCK_LABELS[type]}</option>
              ))}
            </Select>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                if (addType === "lead_form" && sections.some((s) => s.type === "lead_form")) {
                  showToast("Only one lead form", "A landing page can contain at most one lead form block.", "error");
                  return;
                }
                setSections((prev) => [...prev, newBlock(addType)]);
              }}
            >
              Add block
            </Button>
          </div>
        </Card>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "12px" }}>
          <Button type="button" variant="primary" disabled={saving} onClick={handleSave}>
            {saving ? "Saving…" : editingId ? "Save changes" : "Create page"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => { resetForm(); setView("list"); }}>
            Back to list
          </Button>
          {editingId && (
            <a className="btn secondary" href={`/go/${slug}?preview=true`} target="_blank" rel="noreferrer">
              Preview
            </a>
          )}
        </div>

        {editingId && (
          <Card>
            <h2>Lifecycle</h2>
            <p>Status: <StatusPill status={currentStatus}>{currentStatus}</StatusPill></p>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {currentStatus === "draft" && (
                <Button type="button" variant="secondary" onClick={() => runLifecycle(publishLandingPageAction, editingId, "published")}>Publish</Button>
              )}
              {currentStatus === "published" && (
                <>
                  <Button type="button" variant="secondary" onClick={() => runLifecycle(unpublishLandingPageAction, editingId, "unpublished")}>Unpublish</Button>
                  <Button type="button" variant="secondary" onClick={() => runLifecycle(archiveLandingPageAction, editingId, "archived")}>Archive</Button>
                </>
              )}
              {currentStatus === "archived" && (
                <Button type="button" variant="secondary" onClick={() => runLifecycle(restoreArchivedLandingPageAction, editingId, "restored to draft")}>Restore to draft</Button>
              )}
              {(currentStatus === "draft" || currentStatus === "archived") && !confirmTrash && (
                <Button type="button" variant="danger" onClick={() => setConfirmTrash(true)}>Move to Trash</Button>
              )}
              {confirmTrash && (
                <>
                  <span>Published items must go through unpublish/archive first. Move this page to Trash?</span>
                  <Button type="button" variant="danger" onClick={() => { setConfirmTrash(false); runLifecycle(moveLandingPageToTrashAction, editingId, "moved to Trash"); }}>Confirm Trash</Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirmTrash(false)}>Cancel</Button>
                </>
              )}
            </div>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div>
      {toast && <Toast title={toast.title} error={toast.type === "error"}>{toast.message}</Toast>}
      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <Input placeholder="Search pages…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search landing pages" />
        <Button type="button" variant="primary" onClick={handleNew}>New landing page</Button>
      </div>
      {pages.length === 0 ? (
        <EmptyState
          title="No landing pages yet"
          action={<Button type="button" variant="primary" onClick={handleNew}>New landing page</Button>}
        >
          Campaign pages live at /go/[slug]. Trashed pages are hidden here and listed on the Trash page.
        </EmptyState>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th>Title</th>
              <th>Campaign</th>
              <th>Target</th>
              <th>Status</th>
              <th>Schedule</th>
              <th>Index</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((page) => (
              <tr key={page.id}>
                <td>{page.title}<br /><small>/go/{page.slug}</small></td>
                <td>{page.campaignName}</td>
                <td>{page.targetKind}</td>
                <td><StatusPill status={page.status}>{page.status}</StatusPill></td>
                <td>
                  <small>
                    {page.startsAt ? new Date(page.startsAt).toLocaleDateString("en-GB") : "—"}
                    {" → "}
                    {page.endsAt ? new Date(page.endsAt).toLocaleDateString("en-GB") : "open"}
                  </small>
                </td>
                <td><small>{page.noindex ? "noindex" : "index"}</small></td>
                <td>
                  <div style={{ display: "flex", gap: "4px" }}>
                    <Button type="button" variant="secondary" size="sm" onClick={() => handleEdit(page)}>Edit</Button>
                    <Link className="btn secondary small" href={`/go/${page.slug}?preview=true`} target="_blank" rel="noreferrer">Preview</Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}

function SectionEditor({
  section,
  position,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  section: LandingPageSection;
  position: number;
  total: number;
  onChange: (patch: Partial<LandingPageSection>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div style={{ border: "1px solid #e5e5e5", borderRadius: "8px", padding: "12px", marginBottom: "8px" }}>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" }}>
        <b>{BLOCK_LABELS[section.type]}</b>
        <span style={{ marginLeft: "auto", display: "flex", gap: "4px" }}>
          <Button type="button" variant="ghost" size="sm" disabled={position === 0} onClick={() => onMove(-1)} aria-label="Move block up">↑</Button>
          <Button type="button" variant="ghost" size="sm" disabled={position === total - 1} onClick={() => onMove(1)} aria-label="Move block down">↓</Button>
          <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label="Remove block">Remove</Button>
        </span>
      </div>
      <SectionFields section={section} onChange={onChange} />
    </div>
  );
}

function TextInput({ label, value, maxLength, onChange, multiline }: {
  label: string;
  value: string;
  maxLength?: number;
  onChange: (next: string) => void;
  multiline?: boolean;
}) {
  const id = `${useId()}-${label}`;
  return (
    <Field label={label} htmlFor={id}>
      {multiline ? (
        <Textarea id={id} value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

function SectionFields({
  section,
  onChange,
}: {
  section: LandingPageSection;
  onChange: (patch: Partial<LandingPageSection>) => void;
}) {
  switch (section.type) {
    case "hero":
      return (
        <>
          <TextInput label="Kicker (optional)" value={section.kicker ?? ""} maxLength={120} onChange={(v) => onChange({ kicker: v })} />
          <TextInput label="Heading" value={section.heading} maxLength={160} onChange={(v) => onChange({ heading: v })} />
          <TextInput label="Subheading (optional)" value={section.subheading ?? ""} maxLength={500} multiline onChange={(v) => onChange({ subheading: v })} />
        </>
      );
    case "problem":
      return (
        <>
          <TextInput label="Heading" value={section.heading} maxLength={160} onChange={(v) => onChange({ heading: v })} />
          <TextInput
            label="Points (one per line)"
            value={section.points.join("\n")}
            multiline
            onChange={(v) => onChange({ points: v.split("\n").map((p) => p.trim()).filter(Boolean) })}
          />
        </>
      );
    case "benefits":
      return (
        <>
          <TextInput label="Heading" value={section.heading} maxLength={160} onChange={(v) => onChange({ heading: v })} />
          {section.items.map((item, index) => (
            <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: "8px", alignItems: "end" }}>
              <TextInput label={`Benefit ${index + 1} title`} value={item.title} maxLength={120} onChange={(v) => onChange({ items: section.items.map((it, i) => (i === index ? { ...it, title: v } : it)) })} />
              <TextInput label={`Benefit ${index + 1} text`} value={item.text} maxLength={500} onChange={(v) => onChange({ items: section.items.map((it, i) => (i === index ? { ...it, text: v } : it)) })} />
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ items: section.items.filter((_, i) => i !== index) })} aria-label={`Remove benefit ${index + 1}`}>✕</Button>
            </div>
          ))}
          {section.items.length < 8 && (
            <Button type="button" variant="secondary" size="sm" onClick={() => onChange({ items: [...section.items, { title: "Next win", text: "What it gives you." }] })}>Add benefit</Button>
          )}
        </>
      );
    case "quote":
      return (
        <>
          <TextInput label="Quote" value={section.text} maxLength={800} multiline onChange={(v) => onChange({ text: v })} />
          <TextInput label="Attribution (optional)" value={section.attribution ?? ""} maxLength={160} onChange={(v) => onChange({ attribution: v })} />
        </>
      );
    case "target_summary":
      return (
        <>
          <TextInput label="Heading (optional)" value={section.heading ?? ""} maxLength={160} onChange={(v) => onChange({ heading: v })} />
          <p className="help">Renders live data from the linked target. No author content stored.</p>
        </>
      );
    case "faq":
      return (
        <>
          <TextInput label="Heading (optional)" value={section.heading ?? ""} maxLength={160} onChange={(v) => onChange({ heading: v })} />
          {section.items.map((item, index) => (
            <div key={index} style={{ display: "grid", gap: "4px", marginBottom: "8px" }}>
              <TextInput label={`Question ${index + 1}`} value={item.q} maxLength={200} onChange={(v) => onChange({ items: section.items.map((it, i) => (i === index ? { ...it, q: v } : it)) })} />
              <TextInput label={`Answer ${index + 1}`} value={item.a} maxLength={1200} multiline onChange={(v) => onChange({ items: section.items.map((it, i) => (i === index ? { ...it, a: v } : it)) })} />
              <div>
                <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ items: section.items.filter((_, i) => i !== index) })}>Remove question</Button>
              </div>
            </div>
          ))}
          {section.items.length < 12 && (
            <Button type="button" variant="secondary" size="sm" onClick={() => onChange({ items: [...section.items, { q: "Another question?", a: "Another answer." }] })}>Add question</Button>
          )}
        </>
      );
    case "cta_band":
      return (
        <>
          <TextInput label="Heading" value={section.heading} maxLength={160} onChange={(v) => onChange({ heading: v })} />
          <TextInput label="Text (optional)" value={section.text ?? ""} maxLength={500} multiline onChange={(v) => onChange({ text: v })} />
          <TextInput label="Button label (optional, defaults to page CTA)" value={section.ctaLabel ?? ""} maxLength={80} onChange={(v) => onChange({ ctaLabel: v })} />
        </>
      );
    case "lead_form":
      return (
        <>
          <TextInput label="Heading" value={section.heading} maxLength={160} onChange={(v) => onChange({ heading: v })} />
          <TextInput label="Text (optional)" value={section.text ?? ""} maxLength={500} multiline onChange={(v) => onChange({ text: v })} />
        </>
      );
  }
}
