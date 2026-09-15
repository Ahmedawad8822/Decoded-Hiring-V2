import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export interface CloudflareEnv {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
}

interface PlatformProxyResult {
  env: CloudflareEnv;
  dispose: () => Promise<void>;
}

let localProxyPromise: Promise<PlatformProxyResult> | null = null;

/**
 * Clean runtime boundary for Cloudflare bindings:
 * - In Worker/Production runtime: returns bindings from global context or process.env.
 * - In local Node.js development: uses Wrangler's getPlatformProxy with local Miniflare emulation.
 */
export async function getCloudflareBindings(): Promise<CloudflareEnv> {
  // 1. Production / Worker native context
  const globalEnv = (globalThis as unknown as { __env__?: CloudflareEnv }).__env__;
  if (globalEnv?.DB && globalEnv?.MEDIA_BUCKET) {
    return globalEnv;
  }

  const procEnv = process.env as unknown as { DB?: D1Database; MEDIA_BUCKET?: R2Bucket };
  if (procEnv.DB && procEnv.MEDIA_BUCKET && typeof procEnv.DB.prepare === "function") {
    return procEnv as CloudflareEnv;
  }

  // 2. Local Node development / test environment emulation via Wrangler
  if (!localProxyPromise) {
    localProxyPromise = (async () => {
      const { getPlatformProxy } = await import("wrangler");
      const proxy = await getPlatformProxy<CloudflareEnv>({
        configPath: "wrangler.jsonc",
        persist: { path: ".wrangler/state/v3" },
      });
      return proxy as unknown as PlatformProxyResult;
    })();
  }

  const proxy = await localProxyPromise;
  return proxy.env;
}

export async function disposeCloudflareBindings(): Promise<void> {
  if (localProxyPromise) {
    const proxy = await localProxyPromise;
    localProxyPromise = null;
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
