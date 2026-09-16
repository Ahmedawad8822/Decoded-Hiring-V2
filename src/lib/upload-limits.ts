/**
 * Multipart request-body guard (upload size defense — three layers).
 *
 * Layer 1 (header): Content-Length is a WHOLE-BODY number — the file bytes
 * PLUS the multipart/form envelope (boundary lines, part headers, and any
 * sibling fields such as namespace/courseId/lessonId/title). Treating the
 * exact FILE limit as the whole-body limit would reject a valid file that
 * sits at the file limit. This small, explicit envelope allowance keeps the
 * header guard strict (it never lets a body with a clearly oversized file
 * through) without false-rejecting a legitimate at-limit upload.
 *
 * The ACTUAL file limit is enforced exactly, one layer later, by
 * File.size (layer 2) and by each service's byteLength validation
 * (layer 3). Cloudflare/platform request-body limits remain the final
 * outer boundary.
 */
export const MULTIPART_ENVELOPE_ALLOWANCE = 256 * 1024; // 256 KiB

/** True when the declared request-body size exceeds the file limit plus the
 * explicit multipart/form envelope allowance. */
export function isRequestBodyOverLimit(contentLength: number, fileLimit: number): boolean {
  return contentLength > fileLimit + MULTIPART_ENVELOPE_ALLOWANCE;
}