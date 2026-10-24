import { ZodError } from "zod";
import { publicErrorMessage } from "./errors";

// ============================================================================
// SERVER ACTION RESULTS
// ----------------------------------------------------------------------------
// Errors thrown out of a Server Action are serialised by Next.js: in
// development the raw message (SQL, provider bodies) reaches the browser, and
// in production it is replaced by an opaque digest, so even user-facing
// messages are lost. Actions therefore RETURN a result instead of throwing.
// ============================================================================

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Run an action body and convert any failure to a user-safe result:
 * AppError and Zod validation messages are kept, anything else is logged
 * server-side and replaced by the fallback.
 */
export async function toActionResult<T>(
  run: () => Promise<T>,
  fallback: string
): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      return { ok: false, error: err.issues.map((i) => i.message).join(", ") };
    }
    return { ok: false, error: publicErrorMessage(err, fallback) };
  }
}

/** Client helper: return the data or throw the (already user-safe) error. */
export function unwrapActionResult<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
