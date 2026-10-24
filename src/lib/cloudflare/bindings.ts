import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface CloudflareEnv {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
}

interface PlatformProxyResult {
  env: CloudflareEnv;
  dispose: () => Promise<void>;
}

type BindingGlobal = typeof globalThis & {
  __decodedHiringLocalProxyPromise?: Promise<PlatformProxyResult> | null;
};

function bindingGlobal(): BindingGlobal {
  return globalThis as BindingGlobal;
}

// TEST-ONLY override seam (mirrors UploadMediaDeps in media/service.ts):
// regression tests inject a fake D1 binding here instead of stubbing the
// platform proxy. Production code never sets it; getCloudflareBindings()
// returns it verbatim when present, so binding resolution semantics
// (OpenNext worker context → local platform proxy) are unchanged.
let testD1Override: D1Database | null = null;

export function setD1DatabaseForTest(db: D1Database): void {
  testD1Override = db;
}

export function clearD1DatabaseForTest(): void {
  testD1Override = null;
}

/**
 * Clean runtime boundary for Cloudflare bindings:
 * - On Cloudflare Workers (OpenNext): the request's `env` from getCloudflareContext().
 * - In local Node.js (next dev/build, tests, scripts): Wrangler's getPlatformProxy
 *   with local Miniflare emulation.
 */
export async function getCloudflareBindings(): Promise<CloudflareEnv> {
  // 0. Test-only injected D1 (paired with the real R2/MEDIA_BUCKET binding).
  if (testD1Override) {
    const env = await resolveCloudflareBindings();
    return { DB: testD1Override, MEDIA_BUCKET: env.MEDIA_BUCKET };
  }

  return resolveCloudflareBindings();
}

async function resolveCloudflareBindings(): Promise<CloudflareEnv> {
  // 1. Cloudflare Workers via OpenNext: the worker entrypoint publishes the
  // request context globally. Sync mode throws when no worker context exists
  // (next dev/build, tests, scripts), which selects the local fallback below.
  const workerEnv = getWorkerEnv();
  if (workerEnv) {
    return workerEnv;
  }

  // 2. Local Node development / test environment emulation via Wrangler
  const state = bindingGlobal();
  if (!state.__decodedHiringLocalProxyPromise) {
    state.__decodedHiringLocalProxyPromise = (async () => {
      // Computed specifier + webpackIgnore keep wrangler out of every bundle
      // (same technique @opennextjs/cloudflare uses); it is a Node-only dev tool.
      const { getPlatformProxy } = (await import(
        /* webpackIgnore: true */ `${"__wrangler".replaceAll("_", "")}`
      )) as typeof import("wrangler");
      const proxy = await getPlatformProxy<CloudflareEnv>({
        configPath: "wrangler.jsonc",
        // DH_LOCAL_STATE_DIR lets test processes use a throwaway state dir;
        // unset (dev, db:migrate:local, seeds, e2e) keeps the shared default.
        persist: { path: process.env.DH_LOCAL_STATE_DIR || ".wrangler/state/v3" },
      });
      return proxy as unknown as PlatformProxyResult;
    })();
  }

  const proxy = await state.__decodedHiringLocalProxyPromise;
  return proxy.env;
}

function getWorkerEnv(): CloudflareEnv | null {
  try {
    const { env } = getCloudflareContext();
    const workerEnv = env as unknown as Partial<CloudflareEnv>;
    return workerEnv.DB && workerEnv.MEDIA_BUCKET ? (workerEnv as CloudflareEnv) : null;
  } catch {
    return null;
  }
}

export async function disposeCloudflareBindings(): Promise<void> {
  const state = bindingGlobal();
  if (state.__decodedHiringLocalProxyPromise) {
    const proxy = await state.__decodedHiringLocalProxyPromise;
    state.__decodedHiringLocalProxyPromise = null;
    await proxy.dispose();
  }
}

export async function getD1Database(): Promise<D1Database> {
  const env = await getCloudflareBindings();
  return env.DB;
}

export async function getR2Bucket(): Promise<R2Bucket> {
  const env = await getCloudflareBindings();
  return env.MEDIA_BUCKET;
}
