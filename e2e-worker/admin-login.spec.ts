import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prepareSession, readState } from "../scripts/remote-sessions";
import { WORKER_ADMIN, WORKER_CERTIFICATE_ID } from "../scripts/worker-e2e-setup";

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
    // Repeated anonymous reads of a real certificate must bypass interception.
    for (let read = 0; read < 2; read++) {
      const certificate = await anonymous.get(`/certificates/${WORKER_CERTIFICATE_ID}`);
      expect(certificate.status()).toBe(200);
      expect(certificate.headers()["cache-control"]).toContain("no-store");
      expect(/(?:public|s-maxage)/i.test(certificate.headers()["cache-control"] ?? "")).toBe(false);
      expect(certificate.headers()["x-opennext-cache"]).not.toBe("HIT");
      const html = await certificate.text();
      expect(html).toMatch(/noindex/);
      expect(html).toContain("Valid");
      expect(html).toContain("Worker Certificate Learner");
      expect(html).not.toContain(WORKER_ADMIN.email);
    }
    for (const id of ["malformed", "Z".repeat(26)]) {
      const missing = await anonymous.get(`/certificates/${id}`);
      expect(missing.status()).toBe(404);
      expect(missing.headers()["cache-control"]).toContain("no-store");
      expect(missing.headers()["x-opennext-cache"]).not.toBe("HIT");
    }
    const manifest: Record<string, { exportedName: string }> = JSON.parse(
      fs.readFileSync(".next/server/server-reference-manifest.json", "utf8"),
    ).node;
    async function action(client: typeof admin, name: string, input: unknown) {
      const entry = Object.entries(manifest).find(([, value]) => value.exportedName === name);
      if (!entry) throw new Error(`Missing compiled action: ${name}`);
      const response = await client.post("/admin/courses", {
        headers: { origin: baseURL!, "next-action": entry[0], "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
        data: JSON.stringify([input]),
      });
      expect(response.status()).toBe(200);
      const row = (await response.text()).split("\n").map((line) => line.slice(line.indexOf(":") + 1))
        .find((line) => line.startsWith('{"ok":'));
      if (!row) throw new Error(`Missing action result for ${name}`);
      return JSON.parse(row) as { ok: boolean; data?: { id: string } };
    }
    const claim = { courseSlug: "worker-certificate-course", recipientName: "Replacement Name" };
    expect((await action(anonymous, "claimCertificateAction", claim)).ok).toBe(false);
    expect((await action(learner, "claimCertificateAction", claim)).ok).toBe(false);
    const repeated = await action(admin, "claimCertificateAction", claim);
    expect(repeated.data?.id).toBe(WORKER_CERTIFICATE_ID);
    for (const client of [anonymous, learner]) {
      expect((await action(client, "mutateCertificateAction", { id: WORKER_CERTIFICATE_ID, operation: "restore" })).ok).toBe(false);
    }
    for (const input of [
      { id: WORKER_CERTIFICATE_ID, operation: "revoke", reason: "<b>Review required</b>" },
      { id: WORKER_CERTIFICATE_ID, operation: "restore" },
      { id: WORKER_CERTIFICATE_ID, operation: "edit", recipientName: "Corrected Worker Learner" },
    ]) {
      expect((await action(admin, "mutateCertificateAction", input)).ok).toBe(true);
      const verify = await anonymous.get(`/certificates/${WORKER_CERTIFICATE_ID}`);
      expect(verify.headers()["cache-control"]).toContain("no-store");
      expect(verify.headers()["x-opennext-cache"]).not.toBe("HIT");
      const html = await verify.text();
      if (input.operation === "revoke") {
        expect(html).toContain("Revoked on");
        expect(html).toContain("&lt;b&gt;Review required&lt;/b&gt;");
      } else expect(html).toContain("Valid");
      if (input.operation === "edit") expect(html).toContain("Corrected Worker Learner");
    }
    for (const client of [anonymous, admin, learner]) {
      const session = await client.get("/api/auth/get-session");
      expect(session.headers()["cache-control"]).toContain("no-store");
      expect(session.headers()["x-opennext-cache"]).not.toBe("HIT");
      const protectedPage = await client.get("/admin/content", { maxRedirects: 0 });
      expect(protectedPage.headers()["cache-control"]).toContain("no-store");
      expect(protectedPage.headers()["x-opennext-cache"]).not.toBe("HIT");
      expect(protectedPage.status()).toBe(client === admin ? 200 : 307);
      for (const route of ["/learn", "/learn/courses/mission-01-demo/complete"]) {
        const classroom = await client.get(route, { maxRedirects: 0 });
        expect(classroom.headers()["cache-control"]).toContain("no-store");
        expect(/(?:public|s-maxage)/i.test(classroom.headers()["cache-control"] ?? "")).toBe(false);
        expect(classroom.headers()["x-opennext-cache"]).not.toBe("HIT");
        expect(classroom.status()).toBe(client === anonymous ? 307 : 200);
        if (client !== anonymous) expect(await classroom.text()).toMatch(/noindex/);
      }
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
