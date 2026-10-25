/** Minimal byte fixtures that carry real image magic bytes (not decodable images). */
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

export const IMAGE_FIXTURES: Record<string, Uint8Array> = {
  "image/png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  "image/jpeg": new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  "image/gif": new Uint8Array([...ascii("GIF89a"), 1, 0, 1, 0]),
  "image/webp": new Uint8Array([...ascii("RIFF"), 0x1a, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8 ")]),
  "image/avif": new Uint8Array([0, 0, 0, 0x1c, ...ascii("ftyp"), ...ascii("avif"), 0, 0, 0, 0, ...ascii("avifmif1")]),
};
