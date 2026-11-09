import "./helpers/env";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeBase32, totp, validateOrigin, validateStatePath, writeState, readState, parseState, parseArgs, RemoteClient, enrollmentProps, enrollmentActionId, enrollCourses } from "../scripts/remote-sessions";

// RFC 6238 Appendix B, public algorithm test vectors (not account secrets).
test("RFC 6238 Appendix B: SHA-1, SHA-256, SHA-512 across all six timestamps", () => {
  const rows = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ] as const;
  const seed = "12345678901234567890";
  for (const [time, sha1, sha256, sha512] of rows) {
    assert.equal(totp(Buffer.from(seed), time, 8), sha1);
    assert.equal(totp(Buffer.from(seed + "123456789012"), time, 8, "sha256"), sha256);
    assert.equal(totp(Buffer.from(seed.repeat(3) + "1234"), time, 8, "sha512"), sha512);
  }
  assert.equal(decodeBase32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").toString(), seed);
  assert.equal(totp(decodeBase32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), 59), "287082");
});

test("origin and argv guards fail closed", () => {
  assert.equal(validateOrigin("https://test.invalid", ["<PROD_SITE_URL>"]).origin, "https://test.invalid");
  assert.equal(validateOrigin("http://localhost:3000", []).hostname, "localhost");
  for (const url of ["http://test.invalid", "http://localhost.evil", "https://x.invalid/path", "https://user:password@test.invalid", "https://test.invalid?q=x"]) assert.throws(() => validateOrigin(url, []));
  assert.throws(() => validateOrigin("https://prod.invalid:9999", ["https://prod.invalid"]));
  assert.throws(() => validateOrigin("https://test.invalid", ["bad-config"]));
  assert.throws(() => parseArgs(["admin", "--password", "forbidden"]));
  assert.throws(() => parseArgs(["learner", "--url"]));
  assert.equal(parseArgs(["learner", "--url", "https://test.invalid", "--state", "/tmp/state"]).mode, "learner");
});

test("state is external, private, atomic and shell data is never evaluated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-session-test-"));
  try {
    const repo = path.join(dir, "repo"); fs.mkdirSync(repo);
    const linked = path.join(dir, "linked"); fs.symlinkSync(repo, linked);
    assert.throws(() => validateStatePath(path.join(repo, "state"), [repo]));
    assert.throws(() => validateStatePath(path.join(linked, "state"), [repo]));
    const file = path.join(dir, "state");
    // Synthetic metacharacters test quoting; these are not usable cookies.
    const value = "synthetic='$(never-run)' `never-run`;";
    writeState(file, { CPU_LEARNER_COOKIE: value }, [repo]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(readState(file, [repo]).CPU_LEARNER_COOKIE, value);
    writeState(file, { CPU_ADMIN_COOKIE: "synthetic" }, [repo]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o644);
    assert.throws(() => readState(file, [repo]));
    fs.chmodSync(file, 0o600);
    fs.symlinkSync(file, path.join(dir, "symlink"));
    assert.throws(() => writeState(path.join(dir, "symlink"), {}, [repo]));
    fs.linkSync(file, path.join(dir, "hardlink"));
    assert.throws(() => readState(file, [repo]));
    assert.throws(() => parseState("CPU_ADMIN_COOKIE='x'; echo bad"));
    assert.throws(() => parseState("UNKNOWN='x'"));
    assert.throws(() => parseState("CPU_ADMIN_COOKIE='x'\nCPU_ADMIN_COOKIE='y'"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP client sends Origin, never follows redirects, rotates/deletes challenge cookies and stops on 429", async () => {
  let count = 0;
  const client = new RemoteClient(new URL("https://test.invalid"), (async (url, init) => {
    assert.equal(new URL(String(url)).origin, "https://test.invalid");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("origin"), "https://test.invalid");
    count++;
    if (count === 1) return new Response("{}", { headers: { "set-cookie": "__Secure-better-auth.two_factor=synthetic; Path=/; HttpOnly" } });
    if (count === 2) {
      assert.match(new Headers(init?.headers).get("cookie")!, /two_factor=synthetic/);
      const headers = new Headers();
      headers.append("set-cookie", "__Secure-better-auth.two_factor=; Max-Age=0");
      headers.append("set-cookie", "__Secure-better-auth.session_token=synthetic; HttpOnly");
      return new Response("{}", { headers });
    }
    return new Response("sensitive body must not be logged", { status: 429 });
  }) as typeof fetch);
  await client.request("/api/auth/sign-in/email", {});
  await client.request("/api/auth/two-factor/verify-totp", {});
  assert.equal(client.sessionCookie(), "__Secure-better-auth.session_token=synthetic");
  assert.doesNotMatch(client.cookie(), /two_factor/);
  await assert.rejects(client.request("/api/auth/sign-in/email", {}), /HTTP 429/);
  assert.equal(count, 3);
  await assert.rejects(client.request("https://other.invalid"), /cross-origin/);
  const redirect = new RemoteClient(new URL("https://test.invalid"), (async () => new Response(null, { status: 302, headers: { location: "https://other.invalid" } })) as typeof fetch);
  await assert.rejects(redirect.request("/"), /redirect/);
});

test("public enrollment discovers deployed action and verifies lesson access, skips existing enrollment", async () => {
  const props = { courseId: "synthetic-course", courseSlug: "demo" };
  const html = `<script src="/_next/static/course.js"></script><script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(props))}])</script>`;
  assert.deepEqual(enrollmentProps(html), props);
  assert.equal(enrollmentActionId('(0,l.createServerReference)("40abcdef",l.callServer,void 0,l.findSourceMapURL,"enrollFreeAction")'), "40abcdef");
  let enrolled = false, writes = 0;
  const client = new RemoteClient(new URL("https://test.invalid"), (async (url, init) => {
    const route = new URL(String(url)).pathname;
    if (route === "/learn/courses") return new Response('<a href="/learn/courses/demo">demo</a>');
    if (route === "/_next/static/course.js") return new Response('createServerReference("40abcdef",x,undefined,x,"enrollFreeAction")');
    if (init?.method === "POST") {
      assert.equal(new Headers(init.headers).get("next-action"), "40abcdef");
      assert.equal(init.body, JSON.stringify([props.courseId]));
      writes++; enrolled = true;
      return new Response('0:{}\n1:{"ok":true,"data":{}}\n');
    }
    return new Response(enrolled ? '<a href="/learn/courses/demo/lessons/first">lesson</a>' : html);
  }) as typeof fetch);
  assert.equal(await enrollCourses(client), 1);
  assert.equal(await enrollCourses(client), 1);
  assert.equal(writes, 1);
});

test("real D1/Better Auth: bootstrap recovery is persisted before verify, resume and later 2FA challenge", async () => {
  const { getAuth, checkAdmin } = await import("../src/lib/auth");
  const { getDb, users } = await import("../src/lib/db");
  const { migrateLocalDb } = await import("../src/lib/db/migrate");
  const { disposeCloudflareBindings } = await import("../src/lib/cloudflare/bindings");
  const { eq } = await import("drizzle-orm");
  const { randomUUID } = await import("node:crypto");
  const { prepareSession } = await import("../scripts/remote-sessions");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-session-auth-"));
  const statePath = path.join(dir, "state");
  try {
    await migrateLocalDb();
    const auth = await getAuth();
    const email = `${randomUUID()}@example.test`, password = randomUUID() + randomUUID();
    const created = await auth.api.signUpEmail({ body: { email, password, name: "Local fixture" } });
    const db = await getDb();
    await db.update(users).set({ role: "admin" }).where(eq(users.id, created.user.id));
    let enables = 0, verifies = 0, interrupt = true;
    const transport = (async (url, init) => {
      const route = new URL(String(url)).pathname;
      if (route.endsWith("/enable")) enables++;
      if (route.endsWith("/verify-totp")) {
        verifies++;
        const pending = readState(statePath);
        assert.equal(Boolean(pending.CPU_ADMIN_TOTP_SECRET), true);
        assert.equal(JSON.parse(pending.CPU_ADMIN_BACKUP_CODES!).length >= 8, true);
        if (interrupt) { interrupt = false; throw new Error("simulated interruption"); }
      }
      return auth.handler(new Request(url, init));
    }) as typeof fetch;
    const options = { mode: "admin" as const, url: "http://localhost:3000", statePath };
    const env = { CPU_ADMIN_EMAIL: email, CPU_ADMIN_PASSWORD: password };
    await assert.rejects(prepareSession(options, env, transport), /simulated interruption/);
    await prepareSession(options, env, transport);
    const recovery = readState(statePath).CPU_ADMIN_BACKUP_CODES;
    await prepareSession(options, env, transport);
    assert.equal(enables, 1);
    assert.equal(verifies, 3);
    assert.equal(readState(statePath).CPU_ADMIN_BACKUP_CODES === recovery, true);
    const state = readState(statePath);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: state.CPU_ADMIN_COOKIE! }) });
    assert.equal(checkAdmin(session).user.role, "admin");
    const { GET, POST } = await import("../src/app/api/auth/[...all]/route");
    const httpSignIn = await POST(new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }));
    assert.equal(httpSignIn.status, 200);
    assert.equal(httpSignIn.headers.get("cache-control"), "private, no-store");
    assert.equal(httpSignIn.headers.getSetCookie().length > 0, true);
    const httpSession = await GET(new Request("http://localhost:3000/api/auth/get-session", {
      headers: { cookie: state.CPU_ADMIN_COOKIE! },
    }));
    assert.equal(httpSession.headers.get("cache-control"), "private, no-store");
    assert.equal((await httpSession.json()).user.twoFactorEnabled, true);
  } finally {
    await disposeCloudflareBindings();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("measurement --sessions loads private state, sends signed-in GETs and never prints cookies", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-measure-state-"));
  try {
    const file = path.join(dir, "state");
    writeState(file, { CPU_SESSION_ORIGIN: "https://test.workers.dev", CPU_ADMIN_COOKIE: "synthetic-session-for-measurement" });
    const source = `
      globalThis.fetch = async (url, init) => {
        if (init?.method && init.method !== "GET") throw new Error("measurement must be GET-only");
        if (new URL(url).pathname === "/admin/content" && init.headers.cookie !== "synthetic-session-for-measurement") throw new Error("state was not loaded");
        return new Response("<html></html>", { status: 200 });
      };
      process.argv = [process.execPath, "measure-workers-cpu.ts", "--url", "https://test.workers.dev", "--sessions", process.env.TEST_SESSION_PATH, "--runs", "1", "--delay", "0", "--routes", "/admin/content"];
      await import("./scripts/measure-workers-cpu.ts");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: process.cwd(), env: { ...process.env, TEST_SESSION_PATH: file, CPU_ADMIN_COOKIE: "wrong-environment-value" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.includes("crawled /admin/content"), true);
    assert.equal(result.stdout.includes("synthetic-session-for-measurement"), false);
    assert.equal(result.stderr, "");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
