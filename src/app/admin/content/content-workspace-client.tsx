"use client";

import { PageHeader, Tabs } from "../_ui";
import { useState } from "react";
import { Guide, FieldNote, LandingPage } from "@/lib/db";
import { GuideManagerClient } from "./guide-manager-client";
import { FieldNotesManagerClient } from "./field-notes-manager-client";
import { LandingPagesManagerClient, type LandingTargetOptions } from "./landing-pages-manager-client";

interface ContentWorkspaceClientProps {
  initialIntent?: string;
  initialGuides: Guide[];
  initialFieldNotes: FieldNote[];
  initialLandingPages: LandingPage[];
  targetOptions: LandingTargetOptions;
  currentUser: { id: string; email: string; name?: string | null };
}

export function ContentWorkspaceClient({
  initialIntent,
  initialGuides,
  initialFieldNotes,
  initialLandingPages,
  targetOptions,
  currentUser,
}: ContentWorkspaceClientProps) {
  const [tab, setTab] = useState<"guides" | "field-notes" | "landing-pages">(
    initialIntent === "field-note" ? "field-notes" : initialIntent === "landing-page" ? "landing-pages" : "guides"
  );

  return (
    <div>
      <PageHeader eyebrow="Publish" title="Content" description="Ideas worth sharing. Write, refine, and publish your next piece." />
      <Tabs
        panelId="content-panel"
        label="Content types"
        value={tab}
        onChange={value => setTab(value as "guides" | "field-notes" | "landing-pages")}
        tabs={[
          { value: "guides", label: `Guides (${initialGuides.length})` },
          { value: "field-notes", label: `Field Notes (${initialFieldNotes.length})` },
          { value: "landing-pages", label: `Landing pages (${initialLandingPages.length})` },
        ]}
      />

      <div role="tabpanel" id="content-panel" aria-label={tab === "guides" ? "Guides" : tab === "field-notes" ? "Field Notes" : "Landing pages"}>
        {tab === "guides" ? (
          <GuideManagerClient startNew={initialIntent === "guide"} initialGuides={initialGuides} currentUser={currentUser} />
        ) : tab === "field-notes" ? (
          <FieldNotesManagerClient startNew={initialIntent === "field-note"} initialNotes={initialFieldNotes} />
        ) : (
          <LandingPagesManagerClient
            startNew={initialIntent === "landing-page"}
            initialPages={initialLandingPages}
            targetOptions={targetOptions}
          />
        )}
      </div>
    </div>
  );
}
