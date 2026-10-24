import { requireAdminPage } from "@/lib/auth";
import { listDrafts } from "@/features/editorial-ai/drafts/service";
import { EditorialListClient } from "./page-client";
import type { DraftStatus } from "@/features/editorial-ai/drafts/types";

// Auth-gated admin page that resolves the live D1 session server-side.
// force-dynamic: never prerender at build — parallel Miniflare workers
// would contend on the local D1 SQLite file (SQLITE_BUSY_RECOVERY).
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Editorial · Studio | Decoded Hiring",
  description: "Review and publish AI-generated editorial drafts.",
};

export default async function EditorialPage({ searchParams }: { searchParams: Promise<{ status?: string; type?: string }> }) {
  await requireAdminPage();
  const { status, type } = await searchParams;
  const drafts = await listDrafts({
    status: status as DraftStatus | undefined,
    contentType: type as "GUIDE" | "FIELD_NOTE" | undefined,
  });

  return <EditorialListClient initialDrafts={drafts} />;
}
