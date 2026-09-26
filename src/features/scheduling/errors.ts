// ============================================================================
// SCHEDULING DOMAIN ERRORS (Mission 08.1 remediation §3)
// ----------------------------------------------------------------------------
// Neutral, provider-independent domain errors for the scheduling core.
// These represent business-state violations:
//   HOLD_NOT_FOUND         — no hold row exists for the slot
//   NOT_OWNER              — supplied ownerToken does not match the current lease
//   WRONG_STATE            — hold is in a state that disallows the operation
//   EXPIRED                — hold has passed its expiry (HELD with past expiresAt)
//   CONCURRENT_MODIFICATION — CAS lost on a reclaim/release/consume
//   DUPLICATE_SLUG         — a booking type with the given slug already exists
//
// SchedulingProviderError (in providers.ts) remains for concrete PROVIDER
// ADAPTER failures (payment gateway, calendar provider, mailbox, meeting).
// Core hold/policy modules must depend ONLY on these domain errors — they
// must NOT import from the provider module for domain-state conditions.
// ============================================================================

export type SchedulingDomainErrorCode =
  | "HOLD_NOT_FOUND"
  | "NOT_OWNER"
  | "WRONG_STATE"
  | "EXPIRED"
  | "CONCURRENT_MODIFICATION"
  | "DUPLICATE_SLUG";

export class SchedulingDomainError extends Error {
  public readonly code: SchedulingDomainErrorCode;

  constructor(message: string, code: SchedulingDomainErrorCode) {
    super(message);
    this.name = "SchedulingDomainError";
    this.code = code;
  }

  /**
   * Type guard: true if `error` is a SchedulingDomainError, optionally
   * narrowed to a specific code.
   */
  static is(error: unknown, code?: SchedulingDomainErrorCode): boolean {
    if (!(error instanceof SchedulingDomainError)) return false;
    return code ? error.code === code : true;
  }
}
