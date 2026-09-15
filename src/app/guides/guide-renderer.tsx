import {
  ContentBlockRenderer,
  renderInlineFormattedText,
} from "@/components/publishing/ContentBlockRenderer";
import type { GuideBlock } from "@/features/guides/types";

// ============================================================================
// GUIDE BLOCK RENDERER (Mission 05: thin wrapper over the shared renderer)
// ----------------------------------------------------------------------------
// Rendering behavior is unchanged — this wrapper preserves the original
// import path (@/app/guides/guide-renderer) and export names so all Guide
// pages keep working. New code (Field Notes) imports ContentBlockRenderer
// directly from @/components/publishing/ContentBlockRenderer.
// ============================================================================

export { renderInlineFormattedText };

export function GuideBlockRenderer({ blocks }: { blocks: GuideBlock[] }) {
  return <ContentBlockRenderer blocks={blocks} />;
}
