import { handlePublicOfferAvailabilityRequest } from "@/features/offers/availability-handler";

// Live availability must never be cached; see availability-handler.ts.
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handlePublicOfferAvailabilityRequest(request);
}
