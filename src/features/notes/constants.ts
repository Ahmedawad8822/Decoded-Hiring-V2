// Client-safe note constants and normalisation. Kept separate from types.ts so
// the learner panel does not pull the zod schema into its browser bundle.

export const NOTE_MAX_BODY = 10_000;
export const NOTE_THROTTLE_MS = 1_000;

/** Canonical stored form: NFC-normalised and trimmed. */
export function normalizeNoteBody(raw: string): string {
  return raw.normalize("NFC").trim();
}
