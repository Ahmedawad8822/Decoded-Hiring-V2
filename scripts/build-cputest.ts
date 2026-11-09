// Stable Workers Builds entry point. Keep the dashboard command unchanged.
import { buildEnv } from "./build-env";

buildEnv("cputest").catch((error) => {
  console.error("cputest build failed:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
