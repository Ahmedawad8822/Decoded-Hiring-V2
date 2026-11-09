"use client";

import { PageHeader, Tabs } from "../_ui";
import { useState } from "react";
import { Guide, FieldNote } from "@/lib/db";
import { GuideManagerClient } from "./guide-manager-client";
import { FieldNotesManagerClient } from "./field-notes-manager-client";

interface ContentWorkspaceClientProps {
  initialIntent?: string;
  initialGuides: Guide[];
  initialFieldNotes: FieldNote[];
  currentUser: { id: string; email: string; name?: string | null };
}

export function ContentWorkspaceClient({
  initialIntent,
  initialGuides,
  initialFieldNotes,
  currentUser,
}: ContentWorkspaceClientProps) {
  const [tab, setTab] = useState<"guides" | "field-notes">(initialIntent === "field-note" ? "field-notes" : "guides");

  return (
    <div>
      <PageHeader eyebrow="Publish" title="Content" description="Ideas worth sharing. Write, refine, and publish your next piece." />
      <Tabs panelId="content-panel" label="Content types" value={tab} onChange={value => setTab(value as "guides" | "field-notes")} tabs={[{ value: "guides", label: `Guides (${initialGuides.length})` }, { value: "field-notes", label: `Field Notes (${initialFieldNotes.length})` }]} />

      <div role="tabpanel" id="content-panel" aria-label={tab === "guides" ? "Guides" : "Field Notes"}>
        {tab === "guides" ? (
          <GuideManagerClient startNew={initialIntent === "guide"} initialGuides={initialGuides} currentUser={currentUser} />
        ) : (
          <FieldNotesManagerClient startNew={initialIntent === "field-note"} initialNotes={initialFieldNotes} />
        )}
      </div>
    </div>
  );
}
