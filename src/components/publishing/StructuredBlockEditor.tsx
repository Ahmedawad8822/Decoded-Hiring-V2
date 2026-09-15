"use client";

import React from "react";
import type { ContentBlock } from "@/features/publishing/types";

// ============================================================================
// SHARED STRUCTURED BLOCK EDITOR (Mission 05 review correction)
// ----------------------------------------------------------------------------
// The Guide manager and the Field Notes manager previously implemented the
// same block mechanics inline (create / edit / move / delete / list editing /
// add-block controls). This component owns those mechanics once, over the
// shared ContentBlock model. Visual markup and class names are unchanged
// (block-list, block-item, bi-bar, bi-kind, bi-tools, bi-body, block-add)
// so both editors render exactly as before.
//
// Deliberately narrow: no plugin architecture, no rich-text library, no new
// schema abstraction. Managers control their surface via:
//   allowedBlockTypes — which add-block buttons appear (in order)
//   createBlock       — per-vertical default templates / placeholders
//   eyebrowHint       — the small caption after "BODY · N BLOCKS"
// ============================================================================

export type StructuredBlockType = ContentBlock["type"];

export function createBlockId(): string {
  return `b-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

/** Neutral default factory; managers pass their own to preserve placeholders. */
export function createDefaultContentBlock(type: StructuredBlockType): ContentBlock {
  const id = createBlockId();
  switch (type) {
    case "heading":
      return { id, type: "heading", level: 2, text: "New section heading" };
    case "blockquote":
      return { id, type: "blockquote", text: "Quoted text..." };
    case "callout":
      return { id, type: "callout", tone: "note", label: "NOTE", text: "Callout text..." };
    case "list":
      return { id, type: "list", style: "bullet", items: ["First point", "Second point"] };
    case "resource":
      return {
        id,
        type: "resource",
        title: "Resource title",
        meta: "PDF · 1 PAGE",
        note: "Download description...",
        buttonLabel: "Download resource",
      };
    case "paragraph":
    default:
      return { id, type: "paragraph", text: "New paragraph text..." };
  }
}

const ADD_BUTTON_LABELS: Record<StructuredBlockType, string> = {
  heading: "Heading",
  paragraph: "Paragraph",
  blockquote: "Pull-quote",
  callout: "Callout",
  list: "List",
  resource: "Resource",
};

interface StructuredBlockEditorProps {
  blocks: ContentBlock[];
  onChange: (next: ContentBlock[]) => void;
  allowedBlockTypes: readonly StructuredBlockType[];
  createBlock?: (type: StructuredBlockType) => ContentBlock;
  /** Small caption after "BODY · N BLOCKS", e.g. "KEEP IT SHORT". */
  eyebrowHint?: string;
}

export function StructuredBlockEditor({
  blocks,
  onChange,
  allowedBlockTypes,
  createBlock = createDefaultContentBlock,
  eyebrowHint = "",
}: StructuredBlockEditorProps) {
  const handleAddBlock = (type: StructuredBlockType) => onChange([...blocks, createBlock(type)]);

  const handleUpdateBlockText = (id: string, text: string) => {
    onChange(blocks.map((b) => (b.id === id ? { ...b, text } : b)));
  };

  const handleMoveBlock = (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= blocks.length) return;
    const newBlocks = [...blocks];
    const [moved] = newBlocks.splice(index, 1);
    newBlocks.splice(targetIndex, 0, moved);
    onChange(newBlocks);
  };

  const handleDeleteBlock = (id: string) => onChange(blocks.filter((b) => b.id !== id));

  return (
    <div>
      <p className="a-micro" style={{ marginBottom: "12px", fontWeight: 600, fontSize: "11px", letterSpacing: "0.08em" }}>
        BODY · {blocks.length} BLOCKS{eyebrowHint ? ` · ${eyebrowHint}` : ""}
      </p>

      <div className="block-list">
        {blocks.map((block, idx) => (
          <div className="block-item" key={block.id}>
            <div className="bi-bar">
              <span className="bi-kind">
                {block.type} {block.type === "heading" ? `(H${block.level})` : ""}
              </span>
              <div className="bi-tools">
                <button type="button" title="Move up" disabled={idx === 0} onClick={() => handleMoveBlock(idx, "up")}>
                  ↑
                </button>
                <button
                  type="button"
                  title="Move down"
                  disabled={idx === blocks.length - 1}
                  onClick={() => handleMoveBlock(idx, "down")}
                >
                  ↓
                </button>
                <button type="button" title="Delete" onClick={() => handleDeleteBlock(block.id)} style={{ color: "var(--coral)" }}>
                  ✕
                </button>
              </div>
            </div>
            <div className="bi-body">
              {block.type === "heading" ? (
                <input
                  type="text"
                  value={block.text}
                  onChange={(e) => handleUpdateBlockText(block.id, e.target.value)}
                  style={{ width: "100%", padding: "8px 10px", fontSize: "18px", fontWeight: 600 }}
                />
              ) : block.type === "list" ? (
                <textarea
                  rows={3}
                  value={block.items.join("\n")}
                  onChange={(e) => {
                    const lines = e.target.value.split("\n");
                    onChange(blocks.map((b) => (b.id === block.id ? { ...b, items: lines } : b)));
                  }}
                  placeholder="One item per line"
                />
              ) : (
                <textarea
                  rows={3}
                  value={"text" in block ? block.text : ""}
                  onChange={(e) => handleUpdateBlockText(block.id, e.target.value)}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="block-add" style={{ marginTop: "16px" }}>
        {allowedBlockTypes.map((type) => (
          <button key={type} type="button" onClick={() => handleAddBlock(type)}>
            ＋ {ADD_BUTTON_LABELS[type]}
          </button>
        ))}
      </div>
    </div>
  );
}
