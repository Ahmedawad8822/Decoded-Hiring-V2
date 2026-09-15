// ============================================================================
// SHARED PREVIEW AUTHORIZATION (Mission 05 extraction)
// ----------------------------------------------------------------------------
// Guides and Field Notes share one admin-preview rule: a non-published
// document is visible only when `?preview=true` is requested AND the
// requester holds an authenticated admin session. Server-side checks remain
// authoritative — hidden buttons are never treated as authorization.
// No preview tokens.
// ============================================================================

export interface PreviewSession {
  user?: { id?: string; role?: string | null } | null;
}

export function canPreviewAsAdmin(
  session: PreviewSession | null | undefined
): boolean {
  return session?.user?.role === "admin";
}

export function resolvePreviewAccess(options?: {
  preview?: boolean;
  session?: PreviewSession | null;
}): boolean {
  if (!options?.preview) return false;
  return canPreviewAsAdmin(options.session);
}
