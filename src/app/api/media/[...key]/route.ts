import { getMedia } from "@/lib/media/service";
import { notFound } from "next/navigation";

export async function GET(
  request: Request,
  props: { params: Promise<{ key: string[] }> }
) {
  const { key: keySegments } = await props.params;
  const key = keySegments.join("/");

  const mediaObj = await getMedia(key);
  if (!mediaObj) {
    return notFound();
  }

  return new Response(mediaObj.body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": mediaObj.contentType,
      "Content-Length": mediaObj.size.toString(),
      "Cache-Control": "public, max-age=31536000, immutable",
      ...(mediaObj.etag ? { ETag: mediaObj.etag } : {}),
    },
  });
}
