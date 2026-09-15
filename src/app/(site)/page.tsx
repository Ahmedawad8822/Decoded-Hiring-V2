import { publicMetadata } from "@/lib/seo";
import { ApprovedHomepage } from "@/features/content/approved-homepage";
import { defaultHomeSections } from "@/features/content/homepage-model";

export const metadata = publicMetadata({
  title: "Decoded Hiring | Recruitment strategy, systems and AI",
  description:
    "Explore Ahmed Awad's evidence-led approach to recruitment strategy, operating systems and responsible AI for talent acquisition.",
  path: "/",
});

export default function HomePage() {
  return <ApprovedHomepage sections={defaultHomeSections} />;
}
