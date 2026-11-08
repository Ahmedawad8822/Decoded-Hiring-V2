import { handlePublicBookingSlotsRequest } from "@/features/scheduling/public-slots-handler";

// Live availability must never be cached; see public-slots-handler.ts.
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handlePublicBookingSlotsRequest(request);
}
