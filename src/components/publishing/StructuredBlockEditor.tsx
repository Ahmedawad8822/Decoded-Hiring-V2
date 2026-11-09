"use client";

import React from "react";
import { IconButton } from "@/app/admin/_ui";
import type { ContentBlock } from "@/features/publishing/types";

// Shared editing mechanics for the Studio publishing and curriculum screens.

export type StructuredBlockType = Exclude<ContentBlock["type"], "resource">;

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
      <p className="a-micro" >
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
                <IconButton type="button" icon="up" label="Move up" disabled={idx === 0} onClick={() => handleMoveBlock(idx, "up")} />
                <IconButton type="button" icon="down" label="Move down" disabled={idx === blocks.length - 1} onClick={() => handleMoveBlock(idx, "down")} />
                <IconButton type="button" icon="trash" label="Delete" onClick={() => handleDeleteBlock(block.id)} className="s-danger" />
              </div>
            </div>
            <div className="bi-body">
              {block.type === "heading" ? (
                <input
                  type="text"
                  value={block.text}
                  onChange={(e) => handleUpdateBlockText(block.id, e.target.value)}
                  aria-label={`Heading block ${idx + 1}`}
                />
              ) : block.type === "list" ? (
                <textarea
                  rows={6} aria-label={`Body block ${idx + 1}`}
                  value={block.items.join("\n")}
                  onChange={(e) => {
                    const lines = e.target.value.split("\n");
                    onChange(blocks.map((b) => (b.id === block.id ? { ...b, items: lines } : b)));
                  }}
                  placeholder="One item per line"
                />
              ) : (
                <textarea
                  rows={6} aria-label={`Body block ${idx + 1}`}
                  value={"text" in block ? block.text : ""}
                  onChange={(e) => handleUpdateBlockText(block.id, e.target.value)}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="block-add" >
        {allowedBlockTypes.map((type) => (
          <button key={type} type="button" onClick={() => handleAddBlock(type)}>
            ＋ {ADD_BUTTON_LABELS[type]}
          </button>
        ))}
      </div>
    </div>
  );
}
