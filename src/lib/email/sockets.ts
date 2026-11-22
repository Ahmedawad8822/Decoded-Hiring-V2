import type { SmtpSocket } from "./smtp";

// ============================================================================
// CLOUDFLARE SOCKETS ADAPTER (Batch G)
// ----------------------------------------------------------------------------
// The ONLY module that touches `cloudflare:sockets`. It is imported lazily
// (dynamic import inside outbox.ts) so Node tests, `next dev` and `next
// build` never resolve the Workers-only specifier. Production injects this
// as the `connect` for `sendMail` over implicit TLS (typically port 465).
// ============================================================================

interface SocketsModule {
  connect(
    address: { hostname: string; port: number },
    options?: { secureTransport: string },
  ): SmtpSocket;
}

export async function connectSmtp(host: string, port: number): Promise<SmtpSocket> {
  // Workers-only runtime module: the installed @cloudflare/workers-types
  // version ships no declarations for it, and the specifier must never
  // resolve in Node/tests or `next build` (webpackIgnore keeps it raw).
  // @ts-expect-error cloudflare:sockets has no type declarations.
  const mod = (await import(/* webpackIgnore: true */ "cloudflare:sockets")) as SocketsModule;
  return mod.connect({ hostname: host, port }, { secureTransport: "on" });
}
