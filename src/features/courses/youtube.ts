// ============================================================================
// YOUTUBE URL VALIDATION (Mission 06 video strategy: YouTube only)
// ----------------------------------------------------------------------------
// Accepts watch URLs, youtu.be short links, /embed/ URLs, and bare 11-char
// video IDs. Rejects everything else — no arbitrary embed HTML anywhere.
// ============================================================================

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export function extractYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  // Bare video ID
  if (VIDEO_ID_PATTERN.test(value)) return value;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  // youtu.be/<id>
  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = parsed.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    return VIDEO_ID_PATTERN.test(id) ? id : null;
  }

  // /embed/<id>
  const embedMatch = parsed.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];

  // /watch?v=<id> (or /shorts/<id>, /live/<id>)
  const shortsMatch = parsed.pathname.match(/^\/(shorts|live)\/([A-Za-z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[2];

  const v = parsed.searchParams.get("v");
  if (v && VIDEO_ID_PATTERN.test(v)) return v;

  return null;
}

export function isValidYouTubeUrl(input: string): boolean {
  return extractYouTubeVideoId(input) !== null;
}

export function buildYouTubeEmbedUrl(input: string): string | null {
  const id = extractYouTubeVideoId(input);
  if (!id) return null;
  return `https://www.youtube-nocookie.com/embed/${id}`;
}
