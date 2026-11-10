import { z } from "zod";

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// 26 independent base32 digits carry 130 random bits, without modulo bias.
export function generateCertificateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return Array.from(bytes, (byte) => ID_ALPHABET[byte & 31]).join("");
}

export function isCertificateId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

export const certificateIdSchema = z.string().refine(isCertificateId, "Invalid certificate id");
// Rejects control, invisible-format (zero-width, bidi override) and line/paragraph separator characters,
// and requires at least one visible letter or digit, so names cannot be blank or visually spoofed.
function plainText(min: number, max: number, message: string) {
  return z.string()
    .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), "Invisible or control characters are not allowed")
    .trim().normalize("NFC").min(min, message).max(max, message)
    .refine((value) => /[\p{L}\p{N}]/u.test(value), "Must contain a letter or number");
}
export const recipientNameSchema = plainText(2, 80, "Name must be 2–80 characters");
export const revokeReasonSchema = plainText(1, 200, "A reason must be 1–200 characters");
export const claimCertificateSchema = z.object({
  courseSlug: z.string().min(1).max(200),
  recipientName: recipientNameSchema,
});
export const certificateMutationSchema = z.discriminatedUnion("operation", [
  z.object({ id: certificateIdSchema, operation: z.literal("revoke"), reason: revokeReasonSchema }),
  z.object({ id: certificateIdSchema, operation: z.literal("restore") }),
  z.object({ id: certificateIdSchema, operation: z.literal("edit"), recipientName: recipientNameSchema }),
]);
