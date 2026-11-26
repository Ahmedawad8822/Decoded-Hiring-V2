"use client";

import { PageHeader, Tabs } from "../_ui";
import { useState } from "react";
import { Guide, FieldNote, Page, LandingPage } from "@/lib/db";
import { GuideManagerClient } from "./guide-manager-client";
import { FieldNotesManagerClient } from "./field-notes-manager-client";
import { PagesManagerClient } from "./pages-manager-client";
import { LandingPagesManagerClient, type LandingTargetOptions } from "./landing-pages-manager-client";

interface ContentWorkspaceClientProps {
  initialIntent?: string;
  initialGuides: Guide[];
  initialFieldNotes: FieldNote[];
  initialPages: Page[];
  initialLandingPages: LandingPage[];
  targetOptions: LandingTargetOptions;
  currentUser: { id: string; email: string; name?: string | null };
}

type ContentTab = "guides" | "field-notes" | "pages" | "landing-pages";

function tabForIntent(intent?: string): ContentTab {
  if (intent === "field-note") return "field-notes";
  if (intent === "page") return "pages";
  if (intent === "landing-page") return "landing-pages";
  return "guides";
}

export function ContentWorkspaceClient({
  initialIntent,
  initialGuides,
  initialFieldNotes,
  initialPages,
  initialLandingPages,
  targetOptions,
  currentUser,
}: ContentWorkspaceClientProps) {
  const [tab, setTab] = useState<ContentTab>(tabForIntent(initialIntent));

  return (
    <div>
      <PageHeader eyebrow="Publish" title="Content" description="Ideas worth sharing. Write, refine, and publish your next piece." />
      <Tabs panelId="content-panel" label="Content types" value={tab} onChange={value => setTab(value as ContentTab)} tabs={[{ value: "guides", label: `Guides (${initialGuides.length})` }, { value: "field-notes", label: `Field Notes (${initialFieldNotes.length})` }, { value: "pages", label: `Pages (${initialPages.length})` }, { value: "landing-pages", label: `Landing pages (${initialLandingPages.length})` }]} />

      <div role="tabpanel" id="content-panel" aria-label={tab === "guides" ? "Guides" : tab === "field-notes" ? "Field Notes" : tab === "pages" ? "Pages" : "Landing pages"}>
        {tab === "guides" ? (
          <GuideManagerClient startNew={initialIntent === "guide"} initialGuides={initialGuides} currentUser={currentUser} />
        ) : tab === "field-notes" ? (
          <FieldNotesManagerClient startNew={initialIntent === "field-note"} initialNotes={initialFieldNotes} />
        ) : (
          tab === "pages" ? (
            <PagesManagerClient startNew={initialIntent === "page"} initialPages={initialPages} />
          ) : (
            <LandingPagesManagerClient
              startNew={initialIntent === "landing-page"}
              initialPages={initialLandingPages}
              targetOptions={targetOptions}
            />
          )
        )}
      </div>
    </div>
  );
}
