/**
 * Canonical-host redirect for the production custom domain.
 *
 * When the site origin (`NEXT_PUBLIC_SITE_URL`) is a custom domain, requests
 * that arrive on `www.<domain>` or on the Worker's `*.workers.dev` address are
 * permanently redirected to the same path on the canonical origin, so search
 * engines and users see one site and auth cookies live on one host.
 *
 * When the site origin is itself a workers.dev address (test environments),
 * nothing is redirected. Any other host (e.g. the cron's in-process request)
 * passes through unchanged. Pure and cheap: one URL parse per request.
 */
export function canonicalRedirect(
  requestUrl: string,
  siteOrigin: string | undefined,
): string | null {
  if (!siteOrigin) return null;
  let site: URL;
  let url: URL;
  try {
    site = new URL(siteOrigin);
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (site.protocol !== "https:" || site.hostname.endsWith(".workers.dev")) {
    return null;
  }
  const host = url.hostname;
  if (host === site.hostname) return null;
  const isAlias = host === `www.${site.hostname}` || host.endsWith(".workers.dev");
  if (!isAlias) return null;
  return `${site.origin}${url.pathname}${url.search}`;
}
