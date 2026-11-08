import { AsyncLocalStorage } from "node:async_hooks";
import type { ClockGlobal } from "./render-clock";

// Kept out of render-cache's imports: OpenNext also compiles its cache config
// for an edge bundle which does not resolve node:async_hooks. Only the custom
// Worker entry instantiates the clock (Wrangler uses nodejs_compat).
export function withRenderStart<T>(fn: () => T, now = Date.now): T {
  const clock = (globalThis as ClockGlobal).__dhRenderClock ??= new AsyncLocalStorage<number>();
  return clock.run(now() - 1, fn);
}
