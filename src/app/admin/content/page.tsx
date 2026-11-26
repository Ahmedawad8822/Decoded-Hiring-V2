import { requireAdminPage } from "@/lib/auth";
import { getAllAdminGuides } from "@/features/guides/service";
import { getAllAdminFieldNotes } from "@/features/field-notes/service";
import { getAllAdminLandingPages } from "@/features/landing-pages/service";
import { getAllOffers } from "@/features/offers/service";
import { getAllAdminCourses } from "@/features/courses/service";
import { ContentWorkspaceClient } from "./content-workspace-client";

export const metadata = {
  title: "Content · Studio | Decoded Hiring",
  description: "Real Guide and Field Notes publishing management.",
};

export default async function AdminContentPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const session = await requireAdminPage();

  const intent = (await searchParams).new;
  const [guides, fieldNotes, landingPages, offers, courses] = await Promise.all([
    getAllAdminGuides(),
    getAllAdminFieldNotes(),
    getAllAdminLandingPages(),
    getAllOffers(),
    getAllAdminCourses(),
  ]);

  return (
    <ContentWorkspaceClient
      initialIntent={intent}
      initialGuides={guides}
      initialFieldNotes={fieldNotes}
      initialLandingPages={landingPages}
      targetOptions={{
        offers: offers.map((o) => ({ id: o.id, title: o.title, active: o.active })),
        courses: courses.map((c) => ({ id: c.id, title: c.title, status: c.status })),
        guides: guides.map((g) => ({ id: g.id, title: g.title, status: g.status })),
      }}
      currentUser={session.user}
    />
  );
}
