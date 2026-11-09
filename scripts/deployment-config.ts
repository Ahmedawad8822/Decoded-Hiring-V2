import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";

export type BuildEnvironment = "cputest" | "production";
type EnvironmentConfig = { name?: unknown; vars?: Record<string, unknown> };

/** JSONC parser handles comments/trailing commas without eval or URL-breaking regexes. */
export function parseEnvironment(source: string, environment: BuildEnvironment): EnvironmentConfig {
  const parsed = parseConfigFileTextToJson("wrangler.jsonc", source);
  if (parsed.error) throw new Error("Invalid wrangler.jsonc JSONC");
  const config = parsed.config?.env?.[environment];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Missing env.${environment} in wrangler.jsonc`);
  }
  return config;
}

export function httpsOrigin(value: unknown): string {
  if (typeof value !== "string" || !value || /[<>\s]/.test(value)) {
    throw new Error("Expected a configured HTTPS origin without placeholders");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Expected a valid HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash ||
      (value !== url.origin && value !== `${url.origin}/`)) {
    throw new Error("Expected an HTTPS origin without credentials, path, query or fragment");
  }
  return url.origin;
}

export function environmentOrigin(source: string, environment: BuildEnvironment): string {
  const { vars } = parseEnvironment(source, environment);
  const auth = httpsOrigin(vars?.BETTER_AUTH_URL);
  const site = httpsOrigin(vars?.NEXT_PUBLIC_SITE_URL);
  if (auth !== site) throw new Error(`env.${environment} auth and site origins must match`);
  return site;
}

export function buildEnvironment(value: string | undefined): BuildEnvironment {
  if (value !== "cputest" && value !== "production") throw new Error("--env must be cputest or production");
  return value;
}

export function readWranglerSource(): string {
  return readFileSync("wrangler.jsonc", "utf8");
}
