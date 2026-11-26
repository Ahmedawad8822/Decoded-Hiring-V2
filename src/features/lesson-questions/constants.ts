// Client-safe question constants and normalisation. Kept separate from
// types.ts so the learner panel does not pull the zod schema into its
// browser bundle.

export const QUESTION_MIN_BODY = 1;
export const QUESTION_MAX_BODY = 2000;
export const QUESTION_MAX_ANSWER = 5000;
export const QUESTIONS_PER_DAY = 10;
export const QUESTIONS_PAGE_SIZE = 25;
/** Public Q&A list per lesson (identity-free, answered only). */
export const PUBLIC_QUESTIONS_LIMIT = 50;

/** Canonical stored form: NFC-normalised and trimmed. */
export function normalizeQuestionBody(raw: string): string {
  return raw.normalize("NFC").trim();
}
