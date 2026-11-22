// ============================================================================
// INTERNAL DRAIN TOKEN (Batch G)
// ----------------------------------------------------------------------------
// Random token generated once per isolate, stored on a globalThis symbol.
// The cron `scheduled()` handler in worker.ts stamps it on the in-process
// POST to /api/cron/email-drain; the route compares it in constant time
// and returns 404 for anything else. Keeping the getter here (not in
// worker.ts) lets both the entrypoint and the route share one isolate-wide
// token without importing the generated OpenNext worker bundle.
// ============================================================================

// Symbol.for, not Symbol(): worker.ts and the OpenNext route bundle each load
// their own copy of this module, so only a registry symbol is shared.
const SLOT = Symbol.for("decoded-hiring.email-drain-token");

function slotStore(): Record<symbol, string | undefined> {
  return globalThis as unknown as Record<symbol, string | undefined>;
}

export function getDrainToken(): string {
  const store = slotStore();
  let token = store[SLOT];
  if (!token) {
    token = crypto.randomUUID();
    store[SLOT] = token;
  }
  return token;
}

/** Constant-time comparison; null/missing/wrong all return false. */
export function isValidDrainToken(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const expected = getDrainToken();
  if (candidate.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
  }
  return diff === 0;
}
