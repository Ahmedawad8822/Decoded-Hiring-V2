import type { AsyncLocalStorage } from "node:async_hooks";

// OpenNext bundles middleware and the server independently. Share the ALS on
// globalThis so both bundles see the outer Worker's request start, including
// forced ISR HEADs where Next can skip the initial incremental-cache read.
export type ClockGlobal = typeof globalThis & { __dhRenderClock?: AsyncLocalStorage<number> };

export function renderStartedAt(): number | undefined {
  return (globalThis as ClockGlobal).__dhRenderClock?.getStore();
}
