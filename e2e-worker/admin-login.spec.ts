import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prepareSession, readState } from "../scripts/remote-sessions";
import { WORKER_ADMIN } from "../scripts/worker-e2e-setup";

test.use({ trace: "off" });

// These tests sign in/up several times. Give them their own client address so
// they never consume the shared 127.0.0.1 auth rate-limit budget (5/min/path)
// that the browser sign-ins in other specs depend on.
const ISOLATED_CLIENT = { "cf-connecting-ip": "198.51.100.23" };

test("HTTP auth responses and admin gates stay private and uncached", async ({ playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL, extraHTTPHeaders: ISOLATED_CLIENT });
  const admin = await playwright.request.newContext({ baseURL, extraHTTPHeaders: ISOLATED_CLIENT });
  const learner = await playwright.request.newContext({ baseURL, extraHTTPHeaders: ISOLATED_CLIENT });
  try {
    const signIn = await admin.post("/api/auth/sign-in/email", { data: WORKER_ADMIN, headers: { origin: baseURL! } });
    expect(signIn.status()).toBe(200);
    expect(Boolean(signIn.headers()["set-cookie"])).toBe(true);
    expect(signIn.headers()["x-opennext-cache"]).not.toBe("HIT");
    // Mutation responses must never advertise a shared cache lifetime.
    expect(signIn.headers()["cache-control"]).toContain("no-store");
    expect(/(?:public|s-maxage)/i.test(signIn.headers()["cache-control"] ?? "")).toBe(false);
    const created = await learner.post("/api/auth/sign-up/email", {
      data: { email: `${randomUUID()}@example.test`, password: randomUUID() + randomUUID(), name: "Local fixture" }, headers: { origin: baseURL! },
    });
    expect(created.status()).toBe(200);
    for (const client of [anonymous, admin, learner]) {
      const session = await client.get("/api/auth/get-session");
      expect(session.headers()["cache-control"]).toContain("no-store");
      expect(session.headers()["x-opennext-cache"]).not.toBe("HIT");
      const protectedPage = await client.get("/admin/content", { maxRedirects: 0 });
      expect(protectedPage.headers()["cache-control"]).toContain("no-store");
      expect(protectedPage.headers()["x-opennext-cache"]).not.toBe("HIT");
      expect(protectedPage.status()).toBe(client === admin ? 200 : 307);
    }
  } finally { await Promise.all([anonymous.dispose(), admin.dispose(), learner.dispose()]); }
});

test("HTTP session tool uses deployed free enrollment action and supports later learner sign-in", async ({ baseURL }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-session-worker-"));
  const statePath = path.join(dir, "sessions");
  const origin = "http://localhost:3000";
  // Local fixture auth trusts its actual 127.0.0.1 origin. Preserve that header
  // and Host while using localhost in the tool's HTTP-only URL guard.
  const transport = (async (url, init) => {
    const target = new URL(String(url));
    const actual = new URL(baseURL!);
    target.host = actual.host;
    const headers = new Headers(init?.headers);
    headers.set("origin", actual.origin);
    headers.set("cf-connecting-ip", "198.51.100.24");
    return fetch(target, { ...init, headers });
  }) as typeof fetch;
  try {
    const env = { CPU_LEARNER_EMAIL: `${randomUUID()}@example.test`, CPU_LEARNER_PASSWORD: randomUUID() + randomUUID(), CPU_LEARNER_NAME: "Local fixture" };
    const options = { mode: "learner" as const, url: origin, statePath };
    await prepareSession(options, env, transport);
    expect(Boolean(readState(statePath).CPU_LEARNER_COOKIE)).toBe(true);
    await prepareSession(options, env, transport);
    const catalog = await transport(new URL("/learn/courses", origin), { headers: { cookie: readState(statePath).CPU_LEARNER_COOKIE! } });
    expect(catalog.status).toBe(200);
    expect(await catalog.text()).toContain("ENROLLED");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
