import React from "react";
import { GuideBlock, isSafeUrl } from "@/features/guides/types";

export function renderInlineFormattedText(text: string): React.ReactNode {
  if (!text) return null;
  // Match **bold**, *italic*, or [label](url)
  const regex = /(\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\))/g;
  const elements: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push(text.substring(lastIndex, match.index));
    }

    if (match[2]) {
      elements.push(<strong key={`b-${match.index}`}>{match[2]}</strong>);
    } else if (match[3]) {
      elements.push(<em key={`i-${match.index}`}>{match[3]}</em>);
    } else if (match[4] && match[5]) {
      const label = match[4];
      const url = match[5];
      if (isSafeUrl(url)) {
        elements.push(
          <a
            key={`a-${match.index}`}
            href={url}
            rel="noopener noreferrer"
            target={url.startsWith("http") ? "_blank" : undefined}
          >
            {label}
          </a>
        );
      } else {
        // Disallowed protocol: sanitize to safe inert text
        elements.push(<span key={`safe-${match.index}`}>{label}</span>);
      }
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    elements.push(text.substring(lastIndex));
  }

  return elements.length > 0 ? elements : text;
}

export function GuideBlockRenderer({ blocks }: { blocks: GuideBlock[] }) {
  if (!blocks || !Array.isArray(blocks)) {
    return null;
  }

  return (
    <>
      {blocks.map((block) => {
        switch (block.type) {
          case "heading": {
            const anchor = block.anchor || block.text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
            if (block.level === 3) {
              return (
                <h3 id={anchor} key={block.id}>
                  {renderInlineFormattedText(block.text)}
                </h3>
              );
            }
            return (
              <h2 id={anchor} key={block.id}>
                {renderInlineFormattedText(block.text)}
              </h2>
            );
          }

          case "paragraph":
            return <p key={block.id}>{renderInlineFormattedText(block.text)}</p>;

          case "blockquote":
            return (
              <blockquote className="pull-quote" key={block.id}>
                {renderInlineFormattedText(block.text)}
              </blockquote>
            );

          case "callout":
            return (
              <div className={`callout ${block.tone}`} key={block.id}>
                <span className="c-label">{block.label}</span>
                {renderInlineFormattedText(block.text)}
              </div>
            );

          case "list": {
            const isOrdered = block.style === "ordered";
            const ListTag = isOrdered ? "ol" : "ul";
            return (
              <ListTag key={block.id}>
                {block.items.map((item, idx) => (
                  <li key={`${block.id}-item-${idx}`}>{renderInlineFormattedText(item)}</li>
                ))}
              </ListTag>
            );
          }

          case "resource":
            return (
              <div className="resource-card" style={{ marginTop: "2.5em" }} key={block.id}>
                <div style={{ display: "grid", gap: "8px", flex: 1, minWidth: "240px" }}>
                  <div style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
                    <span className="rc-icon" aria-hidden="true">
                      ▼
                    </span>
                    <div>
                      <h4>{block.title}</h4>
                      <p className="rc-meta mono">{block.meta}</p>
                    </div>
                  </div>
                  <p
                    className="rr-note"
                    style={{ fontSize: "12.5px", color: "var(--muted-strong)" }}
                  >
                    {renderInlineFormattedText(block.note)}
                  </p>
                </div>
                <button
                  className="btn secondary"
                  type="button"
                  data-toast="Download link requested|Check your inbox for the resource.|"
                >
                  {block.buttonLabel}
                </button>
              </div>
            );

          default:
            return null;
        }
      })}
    </>
  );
}
