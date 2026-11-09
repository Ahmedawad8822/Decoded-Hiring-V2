/** Deployed test sessions only. Credentials are read exclusively from process.env.
 * HTTP contracts: better-auth/dist/api/routes/sign-{in,up}.mjs,
 * api/middlewares/origin-check.mjs, plugins/two-factor/{index,totp/index}.mjs.
 * Enrollment uses the SAME public Server Action as components/learner/enroll-button.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export class SessionToolError extends Error {}
function fail(message: string): never { throw new SessionToolError(message); }
type Mode = "learner" | "admin";
type State = Partial<Record<
  "CPU_LEARNER_COOKIE" | "CPU_ADMIN_COOKIE" | "CPU_ADMIN_TOTP_SECRET" |
  "CPU_ADMIN_BACKUP_CODES" | "CPU_SESSION_ORIGIN" | "CPU_ADMIN_ACCOUNT" | "CPU_LEARNER_ACCOUNT", string>>;
const keys = new Set(["CPU_LEARNER_COOKIE", "CPU_ADMIN_COOKIE", "CPU_ADMIN_TOTP_SECRET", "CPU_ADMIN_BACKUP_CODES", "CPU_SESSION_ORIGIN", "CPU_ADMIN_ACCOUNT", "CPU_LEARNER_ACCOUNT"]);

export function parseArgs(args: string[]) {
  const [mode, ...rest] = args;
  if (mode !== "learner" && mode !== "admin") fail("Choose learner or admin mode.");
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!["--url", "--state"].includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith("--") || options[rest[i]]) {
      fail("Use only MODE --url ORIGIN --state EXTERNAL_FILE; credentials must be environment variables.");
    }
    options[rest[i]] = rest[i + 1];
  }
  if (!options["--url"] || !options["--state"]) fail("Both --url and --state are required.");
  return { mode: mode as Mode, url: options["--url"], statePath: options["--state"] };
}

export function productionUrls(config = fs.readFileSync("wrangler.jsonc", "utf8")): string[] {
  // TypeScript's JSONC parser handles comments without mangling https:// strings.
  const parsed = ts.parseConfigFileTextToJson("wrangler.jsonc", config);
  if (parsed.error) fail("Cannot read production URL guard from wrangler.jsonc.");
  const vars = parsed.config?.env?.production?.vars;
  if (!vars || typeof vars.NEXT_PUBLIC_SITE_URL !== "string" || !vars.NEXT_PUBLIC_SITE_URL) fail("Missing production site URL for the production URL guard.");
  return [vars.NEXT_PUBLIC_SITE_URL, vars.BETTER_AUTH_URL].filter((s): s is string => typeof s === "string");
}

export function validateOrigin(raw: string, production: string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return fail("Invalid --url."); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost"))) {
    fail("Use an HTTPS origin without credentials or a path (HTTP allowed only for localhost).");
  }
  for (const value of production) {
    if (/<[^>]+>|placeholder/i.test(value)) continue;
    let prod: URL;
    try { prod = new URL(value); } catch { return fail("Production URL guard is not a valid URL or placeholder."); }
    if (prod.hostname === url.hostname) fail("Refusing the production site host.");
  }
  return url;
}

const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
export function gitRoots(cwd = process.cwd()): string[] {
  const list = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd, encoding: "utf8" });
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
  return [...list.split("\0").filter(s => s.startsWith("worktree ")).map(s => s.slice(9)), common]
    .map(p => fs.realpathSync(p));
}

export function validateStatePath(file: string, roots = gitRoots()): string {
  const absolute = path.resolve(file);
  const parent = fs.realpathSync(path.dirname(absolute));
  const resolved = path.join(parent, path.basename(absolute));
  if (roots.some(root => inside(resolved, fs.realpathSync(root)))) fail("State file must be outside every git work tree and git directory.");
  if (fs.existsSync(resolved) || (() => { try { fs.lstatSync(resolved); return true; } catch { return false; } })()) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) fail("State must be an owned regular file with no links.");
    if ((stat.mode & 0o777) !== 0o600) fail("Existing state file must have mode 0600.");
  }
  return resolved;
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export function parseState(source: string): State {
  const state: State = {};
  for (const line of source.split("\n").filter(Boolean)) {
    const match = /^([A-Z_]+)='(.*)'$/.exec(line);
    if (!match || !keys.has(match[1]) || match[2].replaceAll("'\"'\"'", "").includes("'") || match[1] in state) fail("Invalid session state format.");
    state[match[1] as keyof State] = match[2].replaceAll("'\"'\"'", "'");
  }
  return state;
}
export function readState(file: string, roots = gitRoots()): State {
  const target = validateStatePath(file, roots);
  if (!fs.existsSync(target)) return {};
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return parseState(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
}
export function writeState(file: string, state: State, roots = gitRoots()) {
  const target = validateStatePath(file, roots);
  const temporary = path.join(path.dirname(target), `.cpu-session-${randomUUID()}`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      const lines = Object.entries(state).map(([key, value]) => {
        if (!keys.has(key) || /[\r\n\0]/.test(value)) return fail("Invalid session state value.");
        return `${key}=${quote(value)}`;
      });
      fs.writeFileSync(fd, lines.join("\n") + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function decodeBase32(secret: string): Buffer {
  if (!/^[A-Z2-7]+={0,6}$/i.test(secret)) fail("Invalid TOTP secret encoding.");
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  return Buffer.from(bytes);
}
/** RFC 6238: network-order 64-bit counter, dynamic truncation, default SHA-1/30s/6 digits. */
export function totp(secret: Uint8Array, seconds = Date.now() / 1000, digits = 6, algorithm = "sha1", period = 30): string {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isInteger(period) || period < 1 || !Number.isInteger(digits) || digits < 6 || digits > 8) fail("Invalid TOTP parameters.");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / period)));
  const digest = createHmac(algorithm, secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, "0");
}

export class RemoteClient {
  private jar = new Map<string, string>();
  constructor(readonly origin: URL, private transport: typeof fetch = fetch) {}
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  sessionCookie() { return [...this.jar].filter(([k]) => /^(?:__Secure-)?better-auth\.session_token$/.test(k)).map(([k,v]) => `${k}=${v}`).join("; "); }
  async request(route: string, body?: unknown, extra: Record<string, string> = {}) {
    const url = new URL(route, this.origin);
    if (url.origin !== this.origin.origin) fail("Refusing a cross-origin request.");
    const res = await this.transport(url, {
      method: body === undefined ? "GET" : "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { origin: this.origin.origin, cookie: this.cookie(), ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 429) fail("Rate limited (HTTP 429). Stop and wait for the auth rate-limit window before retrying; no automatic retries.");
    if (res.status >= 300 && res.status < 400) fail("Unexpected redirect; check the origin and deployed auth configuration.");
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const split = pair.indexOf("=");
      const name = pair.slice(0, split), value = pair.slice(split + 1);
      if (!/^(?:__Secure-)?better-auth\.[\w.-]+$/.test(name)) continue;
      if (!value || /;\s*max-age=0(?:;|$)/i.test(cookie) || /;\s*expires=/i.test(cookie) && new Date(cookie.match(/;\s*expires=([^;]+)/i)![1]).getTime() <= Date.now()) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }
  async json(route: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await this.request(`/api/auth${route}`, body);
    if (!res.ok) fail(`Authentication request failed (HTTP ${res.status}); check credentials and saved 2FA state.`);
    const value = await res.json();
    if (!value || typeof value !== "object") fail("Unexpected authentication response.");
    return value as Record<string, unknown>;
  }
}

/** Decode only the JSON string argument of Next's inline Flight pushes; never evaluate HTML/JS. */
export function flightText(html: string): string {
  return [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g)]
    .map(match => JSON.parse(match[1]) as string).join("");
}
export function courseSlugs(html: string): string[] {
  return [...new Set([...html.matchAll(/href="\/learn\/courses\/([a-z0-9-]+)"/g)].map(m => m[1]))];
}
export function enrollmentProps(html: string): { courseId: string; courseSlug: string } | undefined {
  for (const match of flightText(html).matchAll(/\{"courseId":"([^"\\]+)","courseSlug":"([a-z0-9-]+)"\}/g)) {
    return { courseId: match[1], courseSlug: match[2] };
  }
}
export function enrollmentActionId(js: string): string | undefined {
  return js.match(/createServerReference\)?\(\s*["']([a-f0-9]+)["'][\s\S]{0,250}?["']enrollFreeAction["']/)?.[1];
}
export async function enrollCourses(client: RemoteClient): Promise<number> {
  const catalog = await client.request("/learn/courses");
  if (!catalog.ok) fail("Cannot read learner course catalog.");
  const slugs = courseSlugs(await catalog.text());
  if (!slugs.length) fail("No published courses discovered; cannot prepare lesson measurement.");
  let actionId: string | undefined;
  for (const slug of slugs) {
    const route = `/learn/courses/${slug}`;
    const response = await client.request(route);
    if (!response.ok) fail("Cannot read a course overview.");
    const html = await response.text();
    if (new RegExp(`href="${route}/lessons/[a-z0-9-]+"`).test(html)) continue;
    const props = enrollmentProps(html);
    if (!props || props.courseSlug !== slug) fail("Course needs arranged access or has no published lessons. Free enrollment is unavailable; ask an owner to grant only this learner's course access through the existing admin flow.");
    if (!actionId) {
      const chunks = [...new Set([...html.matchAll(/<script[^>]+src="([^"?#]+\.js)[^"]*"/g)].map(m => m[1]))];
      for (const chunk of chunks) {
        if (!chunk.startsWith("/_next/static/")) continue;
        const res = await client.request(chunk);
        if (res.ok) actionId = enrollmentActionId(await res.text());
        if (actionId) break;
      }
    }
    if (!actionId) fail("Cannot discover public enrollment action; deployed Next.js bundle format may have changed.");
    const result = await client.request(route, [props.courseId], {
      "next-action": actionId, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component",
    });
    const flight = await result.text();
    const row = flight.split("\n").map(line => line.slice(line.indexOf(":") + 1)).find(line => line.startsWith('{"ok":'));
    if (!result.ok || !row || JSON.parse(row).ok !== true) fail("Public free enrollment was refused; check the course's effective offer/access policy.");
    const check = await client.request(route);
    if (!check.ok || !new RegExp(`href="${route}/lessons/[a-z0-9-]+"`).test(await check.text())) fail("Enrollment did not expose a published lesson; measurement is not ready.");
  }
  return slugs.length;
}

export async function prepareSession(options: ReturnType<typeof parseArgs>, env: Record<string, string | undefined> = process.env, transport: typeof fetch = fetch) {
  const origin = validateOrigin(options.url, productionUrls());
  const roots = gitRoots();
  const file = validateStatePath(options.statePath, roots);
  const state = readState(file, roots);
  if (state.CPU_SESSION_ORIGIN && state.CPU_SESSION_ORIGIN !== origin.origin) fail("State belongs to another origin; use a separate file.");
  const prefix = options.mode === "admin" ? "CPU_ADMIN" : "CPU_LEARNER";
  const email = env[`${prefix}_EMAIL`], password = env[`${prefix}_PASSWORD`];
  if (!email || !password) fail(`Set ${prefix}_EMAIL and ${prefix}_PASSWORD in the environment.`);
  const account = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  const accountKey = `${prefix}_ACCOUNT` as const;
  if (state[accountKey] && state[accountKey] !== account) fail("State belongs to another account; use a separate file.");
  state.CPU_SESSION_ORIGIN = origin.origin;
  state[accountKey] = account;
  const client = new RemoteClient(origin, transport);
  const signIn = await client.request("/api/auth/sign-in/email", { email, password });
  let signed: Record<string, unknown>;
  if (!signIn.ok) {
    if (options.mode !== "learner" || signIn.status !== 401) fail(`Sign-in failed (HTTP ${signIn.status}); no retries performed.`);
    const name = env.CPU_LEARNER_NAME;
    if (!name) fail("Set CPU_LEARNER_NAME for first-time signup.");
    signed = await client.json("/sign-up/email", { email, password, name });
  } else signed = await signIn.json() as Record<string, unknown>;
  const user = signed.user as { role?: string; twoFactorEnabled?: boolean } | undefined;
  if (options.mode === "admin") {
    if (signed.twoFactorRedirect === true) {
      if (!state.CPU_ADMIN_TOTP_SECRET) fail("Admin requires 2FA but this state has no secret; use the original external state file. No recovery codes consumed.");
    } else {
      if (user?.role !== "admin") fail("Refusing a non-admin account in admin mode.");
      if (!user.twoFactorEnabled && !state.CPU_ADMIN_TOTP_SECRET) {
        const enabled = await client.json("/two-factor/enable", { password, method: "totp" });
        if (typeof enabled.totpURI !== "string" || !Array.isArray(enabled.backupCodes) || !enabled.backupCodes.every(v => typeof v === "string")) fail("Unexpected two-factor setup response.");
        const uri = new URL(enabled.totpURI);
        const secret = uri.searchParams.get("secret");
        if (uri.protocol !== "otpauth:" || !secret || uri.searchParams.get("period") !== "30" || uri.searchParams.get("digits") !== "6") fail("Unsupported TOTP configuration.");
        decodeBase32(secret);
        state.CPU_ADMIN_TOTP_SECRET = secret;
        state.CPU_ADMIN_BACKUP_CODES = JSON.stringify(enabled.backupCodes);
        // Persist recovery material BEFORE verification rotates the session/enables 2FA.
        writeState(file, state, roots);
      }
    }
    if (!state.CPU_ADMIN_TOTP_SECRET) fail("No saved TOTP secret for this admin.");
    const verified = await client.json("/two-factor/verify-totp", { code: totp(decodeBase32(state.CPU_ADMIN_TOTP_SECRET)), trustDevice: false });
    if ((verified.user as { role?: string })?.role !== "admin") fail("Verification did not return an admin.");
    // On initial enable Better Auth's verify-totp returns the pre-update user;
    // read the rotated session once to confirm the persisted enforcement flag.
    const session = await client.json("/get-session");
    const current = session.user as { role?: string; twoFactorEnabled?: boolean } | undefined;
    if (current?.role !== "admin" || current.twoFactorEnabled !== true) fail("Verified session does not satisfy the admin 2FA gate.");
  } else if (signed.twoFactorRedirect || user?.role !== "user") fail("Learner mode requires a learner account without 2FA.");
  const cookie = client.sessionCookie();
  if (!cookie) fail("No session cookie returned by the auth API.");
  state[`${prefix}_COOKIE`] = cookie;
  writeState(file, state, roots);
  const enrolled = options.mode === "learner" ? await enrollCourses(client) : undefined;
  console.log(options.mode === "learner" ? `learner: signed in, enrolled in ${enrolled} course(s)` : "admin: signed in, two-factor verified");
}

if (/(?:^|[/\\])remote-sessions\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  Promise.resolve().then(() => prepareSession(parseArgs(process.argv.slice(2)))).catch(error => {
    console.error(error instanceof SessionToolError ? error.message : "Session preparation failed; no credential or response details logged.");
    process.exitCode = 1;
  });
}
