import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function handleAuth(request: Request) {
  const auth = await getAuth();
  const response = await auth.handler(request);
  // Session creation/rotation can emit Set-Cookie on any auth endpoint.
  // Explicitly exclude every auth response from browser and shared caches.
  // Mutate in place so multiple Set-Cookie headers are never merged or lost.
  try {
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch {
    // Immutable headers: rebuild, appending each Set-Cookie separately.
    const headers = new Headers();
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") headers.set(key, value);
    });
    for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    headers.set("Cache-Control", "private, no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

export const GET = handleAuth;
export const POST = handleAuth;
