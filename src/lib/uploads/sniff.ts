// ============================================================================
// UPLOAD CONTENT SNIFFING (security: never trust the client-declared MIME)
// ----------------------------------------------------------------------------
// Detects the real image type from the leading bytes. SVG/XML is deliberately
// never detected: SVG is scriptable content and is not an allowed upload type.
// ============================================================================

export type SniffedImageType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/avif";

function toBytes(buffer: ArrayBuffer | Uint8Array): Uint8Array {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = ascii("GIF87a");
const GIF89 = ascii("GIF89a");
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");
const FTYP = ascii("ftyp");
const AVIF_BRANDS = [ascii("avif"), ascii("avis")];

/** Returns the real image MIME type from magic bytes, or null if not an allowed image. */
export function sniffImageType(buffer: ArrayBuffer | Uint8Array): SniffedImageType | null {
  const bytes = toBytes(buffer);

  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return "image/gif";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  // ISO BMFF: [size:4]["ftyp"][major brand:4][minor:4][compatible brands...]
  if (startsWith(bytes, FTYP, 4)) {
    if (AVIF_BRANDS.some((brand) => startsWith(bytes, brand, 8))) return "image/avif";
    // Major brand may differ (e.g. "mif1"); accept avif/avis among compatible brands.
    const declared =
      ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    const end = Math.min(declared, bytes.length, 512);
    for (let i = 16; i + 4 <= end; i += 4) {
      if (AVIF_BRANDS.some((brand) => startsWith(bytes, brand, i))) return "image/avif";
    }
  }
  return null;
}
