// ============================================================================
// Shared route set + helpers for the CPU tooling:
//   scripts/profile-cpu.ts          local workerd profiler (npm run perf:cpu)
//   scripts/measure-workers-cpu.ts  deployed *.workers.dev crawler (npm run perf:cpu:remote)
// Keep the route list here so both tools always cover the same pages.
// ============================================================================

/** Who the request is sent as. */
export type RouteAuth = "none" | "learner" | "admin";

export type CpuRoute = {
  /** Short label used in tables. */
  name: string;
  /** Request path, may contain fixture slugs. */
  path: string;
  auth: RouteAuth;
  method?: "GET" | "POST";
  /** JSON body for POST routes. */
  body?: unknown;
  /** Needs the throwaway local fixtures (profile-cpu-seed). Remote runs skip fixture-only slugs unless overridden. */
  note?: string;
};

/** Fixture slugs created by scripts/profile-cpu-seed.ts (and the e2e bootstrap). */
export const FIXTURES = {
  guideSlug: "profile-guide-1",
  fieldNoteSlug: "profile-field-note-1",
  courseSlug: "mission-01-demo",
  lessonSlug: "why-role-clarity-fails",
} as const;

export const PROFILE_ADMIN = {
  email: process.env.ADMIN_INITIAL_EMAIL || "admin@profile.local",
  password: process.env.ADMIN_INITIAL_PASSWORD || "profile-admin-password-2026!",
};
export const PROFILE_LEARNER = {
  email: process.env.PROFILE_LEARNER_EMAIL || "learner@profile.local",
  password: process.env.PROFILE_LEARNER_PASSWORD || "profile-learner-password-2026!",
};

/** Route types measured. Signed-in routes need a session cookie (see the tools). */
export function buildRoutes(fixtures: Record<keyof typeof FIXTURES, string> = FIXTURES): CpuRoute[] {
  return [
    { name: "/", path: "/", auth: "none" },
    { name: "/guides", path: "/guides", auth: "none" },
    { name: "/guides/[slug]", path: `/guides/${fixtures.guideSlug}`, auth: "none" },
    { name: "/field-notes", path: "/field-notes", auth: "none" },
    { name: "/field-notes/[slug]", path: `/field-notes/${fixtures.fieldNoteSlug}`, auth: "none" },
    { name: "/contact", path: "/contact", auth: "none" },
    { name: "/coaching", path: "/coaching", auth: "none" },
    { name: "/workshop", path: "/workshop", auth: "none" },
    { name: "/mission-01", path: "/mission-01", auth: "none" },
    { name: "/ai-recruiter-os", path: "/ai-recruiter-os", auth: "none" },
    { name: "/about", path: "/about", auth: "none" },
    { name: "/sitemap.xml", path: "/sitemap.xml", auth: "none" },
    { name: "/admin/login", path: "/admin/login", auth: "none" },
    { name: "/learn (learner)", path: "/learn", auth: "learner" },
    { name: "/learn/courses (learner)", path: "/learn/courses", auth: "learner" },
    { name: "/learn/courses/[slug] (learner)", path: `/learn/courses/${fixtures.courseSlug}`, auth: "learner" },
    {
      name: "lesson page (learner)",
      path: `/learn/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}`,
      auth: "learner",
    },
    { name: "/admin/content (admin)", path: "/admin/content", auth: "admin" },
    { name: "/admin/courses (admin)", path: "/admin/courses", auth: "admin" },
    { name: "/admin/leads (admin)", path: "/admin/leads", auth: "admin" },
    { name: "/admin/commerce (admin)", path: "/admin/commerce", auth: "admin" },
    { name: "/admin/editorial (admin)", path: "/admin/editorial", auth: "admin" },
    {
      name: "GET /api/auth/get-session (learner)",
      path: "/api/auth/get-session",
      auth: "learner",
      note: "session read; every gated page pays this",
    },
  ];
}

/** POST sign-in: password hashing (scrypt) is the classic Workers CPU hog. Needs a distinct client IP per call (rate limit). */
export function signInRoute(creds: { email: string; password: string }): CpuRoute {
  return {
    name: "POST /api/auth/sign-in/email",
    path: "/api/auth/sign-in/email",
    auth: "none",
    method: "POST",
    body: { email: creds.email, password: creds.password },
    note: "password verification (scrypt) + session insert",
  };
}

// ---------------------------------------------------------------------------
// Stats / formatting
// ---------------------------------------------------------------------------

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export type Summary = { n: number; p50: number; p95: number; max: number; mean: number };

export function summarize(values: number[]): Summary {
  const v = [...values].sort((a, b) => a - b);
  const mean = v.reduce((s, x) => s + x, 0) / (v.length || 1);
  return { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), max: v[v.length - 1] ?? NaN, mean };
}

export function fmt(n: number | undefined, digits = 1): string {
  return n === undefined || !Number.isFinite(n) ? "-" : n.toFixed(digits);
}

export function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`;
  return [head, sep, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/** Replace (or append) the generated block between markers in a markdown file's text. */
export function replaceBlock(doc: string, begin: string, end: string, block: string): string {
  const b = doc.indexOf(begin);
  const e = doc.indexOf(end);
  if (b >= 0 && e > b) return doc.slice(0, b + begin.length) + "\n" + block + "\n" + doc.slice(e);
  return `${doc.replace(/\s*$/, "")}\n\n${begin}\n${block}\n${end}\n`;
}

export type CpuTailRow = { outcome?: string; cpuMs?: number; wallMs?: number; status?: number };

/** Wrangler prints consecutive pretty JSON objects, not JSONL. Also accepts normalized JSONL/arrays. */
export function parseCpuTail(text: string): Map<string, CpuTailRow> {
  const byProbe = new Map<string, CpuTailRow>();
  const objects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start < 0) {
      if (ch !== "{" && ch !== "[") continue;
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      if (--depth === 0) {
        try { objects.push(JSON.parse(text.slice(start, i + 1))); } catch { /* non-JSON preamble */ }
        start = -1;
      }
    }
  }
  const ms = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  for (const raw of objects.flat()) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const event = obj.event as { request?: { headers?: Record<string, unknown> }; response?: { status?: number } } | undefined;
    const headers = event?.request?.headers;
    if (!headers || typeof headers !== "object") continue;
    const id = Object.entries(headers).find(([key]) => key.toLowerCase() === "x-cpu-probe")?.[1];
    if (typeof id !== "string") continue;
    // cpuTime / wallTime: TraceItem (ms). Aliases are accepted only in normalized exports.
    byProbe.set(id, {
      outcome: typeof obj.outcome === "string" ? obj.outcome : undefined,
      cpuMs: ms(obj.cpuTime ?? obj.cpuTimeMs ?? obj.CPUTimeMs ?? obj.cpu_time_ms),
      wallMs: ms(obj.wallTime ?? obj.wallTimeMs ?? obj.WallTimeMs ?? obj.wall_time_ms),
      status: event?.response?.status,
    });
  }
  return byProbe;
}
