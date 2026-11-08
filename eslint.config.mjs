import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  globalIgnores(["internal/**", ".next/**", "node_modules/**", "public/**", "prototypes/**", ".worktrees/**", ".claude/**", ".open-next/**", ".wrangler/**", ".cpu-profile/**"]),
]);
