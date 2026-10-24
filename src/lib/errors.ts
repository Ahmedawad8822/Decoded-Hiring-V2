// ============================================================================
// APPLICATION ERRORS (public/internal boundary)
// ----------------------------------------------------------------------------
// AppError marks a failure whose message was written for the end user (bad
// input, missing record, lifecycle rule, auth). Server actions and route
// handlers may return its message verbatim. Every other error (driver/SQL
// errors, bugs, platform failures) is internal: it is logged server-side and
// the caller only ever sees a generic fallback.
// ============================================================================

export type AppErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "conflict";

export class AppError extends Error {
  readonly kind: AppErrorKind;

  constructor(kind: AppErrorKind, message: string) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

const HTTP_STATUS: Record<AppErrorKind, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
};

/** User-safe message: AppError text, otherwise the fallback (and a log). */
export function publicErrorMessage(error: unknown, fallback: string): string {
  if (isAppError(error)) return error.message;
  console.error(`[internal error] ${fallback}:`, error);
  return fallback;
}

/** HTTP status for an error: AppError kind mapping, otherwise 500. */
export function httpStatusFor(error: unknown): number {
  return isAppError(error) ? HTTP_STATUS[error.kind] : 500;
}
