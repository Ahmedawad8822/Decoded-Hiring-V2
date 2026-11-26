"use client";

import { PageHeader, Tabs } from "../_ui";
import { useState } from "react";
import { Guide, FieldNote, Page } from "@/lib/db";
import { GuideManagerClient } from "./guide-manager-client";
import { FieldNotesManagerClient } from "./field-notes-manager-client";
import { PagesManagerClient } from "./pages-manager-client";

interface ContentWorkspaceClientProps {
  initialIntent?: string;
  initialGuides: Guide[];
  initialFieldNotes: FieldNote[];
  initialPages: Page[];
  currentUser: { id: string; email: string; name?: string | null };
}

type ContentTab = "guides" | "field-notes" | "pages";

function tabForIntent(intent?: string): ContentTab {
  if (intent === "field-note") return "field-notes";
  if (intent === "page") return "pages";
  return "guides";
}

export function ContentWorkspaceClient({
  initialIntent,
  initialGuides,
  initialFieldNotes,
  initialPages,
  currentUser,
}: ContentWorkspaceClientProps) {
  const [tab, setTab] = useState<ContentTab>(tabForIntent(initialIntent));

  return (
    <div>
      <PageHeader eyebrow="Publish" title="Content" description="Ideas worth sharing. Write, refine, and publish your next piece." />
      <Tabs panelId="content-panel" label="Content types" value={tab} onChange={value => setTab(value as ContentTab)} tabs={[{ value: "guides", label: `Guides (${initialGuides.length})` }, { value: "field-notes", label: `Field Notes (${initialFieldNotes.length})` }, { value: "pages", label: `Pages (${initialPages.length})` }]} />

      <div role="tabpanel" id="content-panel" aria-label={tab === "guides" ? "Guides" : tab === "field-notes" ? "Field Notes" : "Pages"}>
        {tab === "guides" ? (
          <GuideManagerClient startNew={initialIntent === "guide"} initialGuides={initialGuides} currentUser={currentUser} />
        ) : tab === "field-notes" ? (
          <FieldNotesManagerClient startNew={initialIntent === "field-note"} initialNotes={initialFieldNotes} />
        ) : (
          <PagesManagerClient startNew={initialIntent === "page"} initialPages={initialPages} />
        )}
      </div>
    </div>
  );
}
