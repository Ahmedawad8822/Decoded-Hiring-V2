"use client";

import { useState } from "react";
import { Guide, FieldNote } from "@/lib/db";
import { GuideManagerClient } from "./guide-manager-client";
import { FieldNotesManagerClient } from "./field-notes-manager-client";

interface ContentWorkspaceClientProps {
  initialGuides: Guide[];
  initialFieldNotes: FieldNote[];
  currentUser: { id: string; email: string; name?: string | null };
}

// ============================================================================
// CONTENT WORKSPACE TABS (Mission 05)
// ----------------------------------------------------------------------------
// Single /admin/content surface for both publishing verticals. Guides keep
// their existing manager untouched; Field Notes get their own lighter
// manager. No second admin shell, no redesign of Admin Studio.
// ============================================================================

export function ContentWorkspaceClient({
  initialGuides,
  initialFieldNotes,
  currentUser,
}: ContentWorkspaceClientProps) {
  const [tab, setTab] = useState<"guides" | "field-notes">("guides");

  return (
    <div>
      <div
        role="tablist"
        aria-label="Content types"
        style={{
          display: "flex",
          gap: "8px",
          marginBottom: "20px",
          borderBottom: "1px solid var(--line)",
          paddingBottom: "12px",
        }}
      >
        <button
          role="tab"
          aria-selected={tab === "guides"}
          type="button"
          onClick={() => setTab("guides")}
          className={`btn small ${tab === "guides" ? "primary" : "ghost"}`}
        >
          Guides ({initialGuides.length})
        </button>
        <button
          role="tab"
          aria-selected={tab === "field-notes"}
          type="button"
          onClick={() => setTab("field-notes")}
          className={`btn small ${tab === "field-notes" ? "primary" : "ghost"}`}
        >
          Field Notes ({initialFieldNotes.length})
        </button>
      </div>

      {tab === "guides" ? (
        <GuideManagerClient initialGuides={initialGuides} currentUser={currentUser} />
      ) : (
        <FieldNotesManagerClient initialNotes={initialFieldNotes} />
      )}
    </div>
  );
}
