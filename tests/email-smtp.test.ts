/**
 * SMTP CLIENT: dependency-free mail sending over an injected socket.
 *
 * Uses a scripted fake socket that asserts the client's commands and
 * plays back canned server replies (split chunks, coalesced replies,
 * rejections, and silence for timeouts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first.

import {
  buildMessage,
  sendMail,
  SmtpError,
  type BuildMessageOptions,
  type MailOptions,
  type SmtpSocket,
} from "../src/lib/email/smtp";

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

const USERNAME = "alice";
const PASSWORD = "s3cr3t-pw-9";
const FROM = "sender@example.com";
const TO = ["a@example.test", "b@example.test"];

function baseOptions(overrides?: Partial<MailOptions>): MailOptions {
  return {
    host: "mail.example.test",
    port: 465,
    username: USERNAME,
    password: PASSWORD,
    clientName: "sender.example.test",
    from: { address: FROM, name: "Sender Name" },
    to: [...TO],
    subject: "Hello",
    text: "line one\nline two",
    ...overrides,
  };
}

type Step = { expect: string; respond: string[] } | { expectData: true; respond: string[] };

interface Fake {
  socket: SmtpSocket;
  received: string[];
  data: string[];
  stepsConsumed: () => number;
  closed: () => boolean;
}

function createFake(steps: Step[], initial: string[] = []): Fake {
  const received: string[] = [];
  const data: string[] = [];
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let incoming = "";
  let stepIndex = 0;
  let closed = false;

  const enqueue = (chunk: string): void => {
    const bytes = enc.encode(chunk);
    if (controller) {
      controller.enqueue(bytes);
    }
  };

  const handleLine = (line: string): void => {
    const step = steps[stepIndex];
    assert.ok(step, `unexpected command from client: ${line}`);
    if ("expectData" in step) {
      data.push(line);
      if (line === ".") {
        stepIndex += 1;
        for (const chunk of step.respond) {
          enqueue(chunk);
        }
      }
      return;
    }
    received.push(line);
    assert.equal(line, step.expect, `command #${stepIndex}`);
    stepIndex += 1;
    for (const chunk of step.respond) {
      enqueue(chunk);
    }
  };

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of initial) {
        c.enqueue(enc.encode(chunk));
      }
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      incoming += dec.decode(chunk, { stream: true });
      let idx = incoming.indexOf("\r\n");
      while (idx >= 0) {
        const line = incoming.slice(0, idx);
        incoming = incoming.slice(idx + 2);
        handleLine(line);
        idx = incoming.indexOf("\r\n");
      }
    },
  });

  return {
    socket: {
      readable,
      writable,
      close() {
        closed = true;
        try {
          controller?.close();
        } catch {
          // Already closed.
        }
      },
    },
    received,
    data,
    stepsConsumed: () => stepIndex,
    closed: () => closed,
  };
}

const AUTH_PLAIN = `AUTH PLAIN ${b64(`\0${USERNAME}\0${PASSWORD}`)}`;

function plainScript(ehloChunks: string[]): Step[] {
  return [
    { expect: "EHLO sender.example.test", respond: ehloChunks },
    { expect: AUTH_PLAIN, respond: ["235 2.7.0 Authenticated\r\n"] },
    { expect: `MAIL FROM:<${FROM}>`, respond: ["250 OK\r\n"] },
    { expect: `RCPT TO:<${TO[0]}>`, respond: ["250 OK\r\n"] },
    { expect: `RCPT TO:<${TO[1]}>`, respond: ["250 OK\r\n"] },
    { expect: "DATA", respond: ["354 End data with .\r\n"] },
    { expectData: true, respond: ["250 OK queued\r\n"] },
    { expect: "QUIT", respond: ["221 Bye\r\n"] },
  ];
}

function transmittedMessage(fake: Fake): string {
  assert.ok(fake.data.length > 0, "expected DATA content");
  assert.equal(fake.data[fake.data.length - 1], ".");
  return fake.data.slice(0, -1).join("\r\n");
}

test("happy path with AUTH PLAIN sends the right commands and returns messageId", async () => {
  const fake = createFake(
    plainScript(["250-mail.example.test Hello\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n"]),
    ["220 mail.example.test ESMTP ready\r\n"],
  );
  const result = await sendMail(baseOptions(), {
    connect: async () => fake.socket,
  });

  assert.deepEqual(fake.received, [
    "EHLO sender.example.test",
    AUTH_PLAIN,
    `MAIL FROM:<${FROM}>`,
    `RCPT TO:<${TO[0]}>`,
    `RCPT TO:<${TO[1]}>`,
    "DATA",
    "QUIT",
  ]);
  assert.equal(fake.stepsConsumed(), 8);
  assert.equal(fake.closed(), true);
  assert.deepEqual(result.accepted, TO);
  const sent = transmittedMessage(fake);
  const match = sent.match(/^Message-ID:\s*(<[^\r\n>]+>)/im);
  assert.ok(match?.[1], "transmitted message has a Message-ID");
  assert.equal(result.messageId, match[1]);
});

test("falls back to AUTH LOGIN when PLAIN is not advertised", async () => {
  const fake = createFake(
    [
      { expect: "EHLO sender.example.test", respond: ["250-mail.example.test Hi\r\n250 AUTH LOGIN\r\n"] },
      { expect: "AUTH LOGIN", respond: ["334 VXNlcm5hbWU6\r\n"] },
      { expect: b64(USERNAME), respond: ["334 UGFzc3dvcmQ6\r\n"] },
      { expect: b64(PASSWORD), respond: ["235 2.7.0 Authenticated\r\n"] },
      { expect: `MAIL FROM:<${FROM}>`, respond: ["250 OK\r\n"] },
      { expect: `RCPT TO:<${TO[0]}>`, respond: ["250 OK\r\n"] },
      { expect: `RCPT TO:<${TO[1]}>`, respond: ["250 OK\r\n"] },
      { expect: "DATA", respond: ["354 Go ahead\r\n"] },
      { expectData: true, respond: ["250 OK\r\n"] },
      { expect: "QUIT", respond: ["221 Bye\r\n"] },
    ],
    ["220 mail.example.test ESMTP\r\n"],
  );
  const result = await sendMail(baseOptions(), { connect: () => fake.socket });
  assert.deepEqual(result.accepted, TO);
  assert.equal(fake.closed(), true);
  assert.ok(fake.received.includes("AUTH LOGIN"));
});

test("fails clearly when the server advertises no supported AUTH", async () => {
  const fake = createFake(
    [{ expect: "EHLO sender.example.test", respond: ["250-mail.example.test Hi\r\n250 HELP\r\n"] }],
    ["220 mail.example.test ESMTP\r\n"],
  );
  await assert.rejects(sendMail(baseOptions(), { connect: () => fake.socket }), (error: unknown) => {
    assert.ok(error instanceof SmtpError);
    assert.equal(error.stage, "AUTH");
    assert.ok(!error.message.includes(PASSWORD), "error must never contain the password");
    return true;
  });
  assert.equal(fake.closed(), true);
});

test("handles a multi-line EHLO reply split across chunks", async () => {
  const fake = createFake(
    plainScript(["250-ma", "il.example.test Hel", "lo\r\n250-AUTH PL", "AIN LOGIN\r\n250 HELP\r\n"]),
    ["220-ma", "il.example.test ESMTP\r\n220 Ready\r\n"],
  );
  const result = await sendMail(baseOptions(), { connect: () => fake.socket });
  assert.deepEqual(result.accepted, TO);
  assert.equal(fake.closed(), true);
});

test("handles several replies arriving in one chunk", async () => {
  // Greeting plus the whole EHLO reply delivered eagerly in a single
  // chunk, before the client even sends EHLO.
  const fake = createFake(plainScript([]), [
    "220 mail.example.test ESMTP\r\n250-mail.example.test Hello\r\n250 AUTH PLAIN\r\n",
  ]);
  const result = await sendMail(baseOptions(), { connect: () => fake.socket });
  assert.deepEqual(result.accepted, TO);
  assert.deepEqual(fake.received.slice(0, 2), ["EHLO sender.example.test", AUTH_PLAIN]);
  assert.equal(fake.closed(), true);
});

test("rejected RCPT throws SmtpError and closes the socket", async () => {
  const fake = createFake(
    [
      {
        expect: "EHLO sender.example.test",
        respond: ["250-mail.example.test Hi\r\n250 AUTH PLAIN\r\n"],
      },
      { expect: AUTH_PLAIN, respond: ["235 ok\r\n"] },
      { expect: `MAIL FROM:<${FROM}>`, respond: ["250 OK\r\n"] },
      { expect: `RCPT TO:<${TO[0]}>`, respond: ["550 5.1.1 No such mailbox\r\n"] },
    ],
    ["220 mail.example.test ESMTP\r\n"],
  );
  await assert.rejects(sendMail(baseOptions(), { connect: () => fake.socket }), (error: unknown) => {
    assert.ok(error instanceof SmtpError);
    assert.equal(error.code, 550);
    assert.equal(error.stage, "RCPT");
    assert.ok(error.message.includes("550"));
    assert.ok(!error.message.includes(PASSWORD), "error must never contain the password");
    return true;
  });
  assert.equal(fake.closed(), true);
});

test("5xx after DATA throws SmtpError and closes the socket", async () => {
  const fake = createFake(
    [
      {
        expect: "EHLO sender.example.test",
        respond: ["250-mail.example.test Hi\r\n250 AUTH PLAIN\r\n"],
      },
      { expect: AUTH_PLAIN, respond: ["235 ok\r\n"] },
      { expect: `MAIL FROM:<${FROM}>`, respond: ["250 OK\r\n"] },
      { expect: `RCPT TO:<${TO[0]}>`, respond: ["250 OK\r\n"] },
      { expect: `RCPT TO:<${TO[1]}>`, respond: ["250 OK\r\n"] },
      { expect: "DATA", respond: ["354 Go ahead\r\n"] },
      { expectData: true, respond: ["550 5.6.0 Message content rejected\r\n"] },
    ],
    ["220 mail.example.test ESMTP\r\n"],
  );
  await assert.rejects(sendMail(baseOptions(), { connect: () => fake.socket }), (error: unknown) => {
    assert.ok(error instanceof SmtpError);
    assert.equal(error.code, 550);
    assert.equal(error.stage, "BODY");
    assert.ok(!error.message.includes(PASSWORD), "error must never contain the password");
    return true;
  });
  assert.equal(fake.closed(), true);
});

test("a silent server triggers a timeout SmtpError and closes the socket", async () => {
  const fake = createFake(
    [{ expect: "EHLO sender.example.test", respond: [] }],
    ["220 mail.example.test ESMTP\r\n"],
  );
  const started = Date.now();
  await assert.rejects(
    sendMail(baseOptions({ timeoutMs: 60 }), { connect: () => fake.socket }),
    (error: unknown) => {
      assert.ok(error instanceof SmtpError);
      assert.ok(error.message.toLowerCase().includes("timed out"));
      assert.ok(!error.message.includes(PASSWORD), "error must never contain the password");
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, "timed out promptly instead of hanging");
  assert.equal(fake.closed(), true);
});

test("header injection and invalid addresses are rejected", () => {
  const good: BuildMessageOptions = {
    from: { address: "sender@example.com" },
    to: ["a@example.test"],
    subject: "Hello",
    text: "body",
  };
  assert.doesNotThrow(() => buildMessage(good));

  const badSubjects = ["Hi\r\nBcc: evil@example.test", "Hi\nBcc: evil@example.test"];
  for (const subject of badSubjects) {
    assert.throws(() => buildMessage({ ...good, subject }), /CR or LF/);
  }
  assert.throws(() => buildMessage({ ...good, from: { address: "sender@example.com", name: "A\r\nB" } }), /CR or LF/);
  assert.throws(() => buildMessage({ ...good, from: { address: "a@example.test\r\n" } }), /CR or LF/);
  assert.throws(() => buildMessage({ ...good, to: ["a@example.test", "b@example.test\n"] }), /CR or LF/);
  assert.throws(() => buildMessage({ ...good, replyTo: "r@example.test\r\nX: 1" }), /CR or LF/);

  const invalid = [
    "plainaddress",
    "a b@example.com",
    "<a@example.com>",
    "a@example",
    "@example.com",
    "a@@example.com",
    "",
    "a@b@c.com",
  ];
  for (const address of invalid) {
    assert.throws(() => buildMessage({ ...good, to: [address] }), /Invalid email address/, address);
    assert.throws(() => buildMessage({ ...good, from: { address } }), /Invalid email address/, address);
  }
  assert.throws(() => buildMessage({ ...good, to: [] }), /recipient/);
});

test("buildMessage encodes, dot-stuffs and formats the message", () => {
  const subject = "Héllo — Grüße 🎉";
  const name = "Jürgen Müller";
  const raw = buildMessage(
    {
      from: { address: "sender@example.com", name },
      to: ["a@example.test"],
      replyTo: "reply@example.test",
      subject,
      text: "first\n.hidden\nlast",
      html: "<p>hi</p>",
    },
    { now: new Date("2026-11-22T12:00:00.000Z") },
  );

  // CRLF only, everywhere.
  assert.ok(raw.includes("\r\n"));
  assert.ok(!/(?<!\r)\n/.test(raw), "no bare LF");
  assert.ok(!/\r(?!\n)/.test(raw), "no bare CR");

  // Non-ASCII subject decodes back via RFC 2047 encoded-words.
  const subjectLine = raw.split("\r\n").find((line) => line.startsWith("Subject:"));
  assert.ok(subjectLine);
  const words = [...subjectLine.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => m[1] ?? "");
  assert.ok(words.length > 0, "subject uses encoded-words");
  assert.equal(words.map((w) => Buffer.from(w, "base64").toString("utf8")).join(""), subject);

  // Non-ASCII display name is encoded too.
  const fromLine = raw.split("\r\n").find((line) => line.startsWith("From:"));
  assert.ok(fromLine?.includes("=?UTF-8?B?"));

  // Dot-stuffing.
  assert.ok(raw.includes("\r\n..hidden\r\n"), "body line starting with . is stuffed");

  // Multipart with both bodies.
  assert.ok(raw.includes("multipart/alternative"));
  assert.ok(raw.includes("Content-Type: text/plain; charset=utf-8"));
  assert.ok(raw.includes("Content-Type: text/html; charset=utf-8"));
  assert.ok(/boundary="[^"]+"/.test(raw));

  // Reply-To, Date, Message-ID, MIME version.
  assert.ok(raw.includes("Reply-To: reply@example.test"));
  assert.ok(raw.includes("Date: Sun, 22 Nov 2026 12:00:00 +0000"));
  assert.match(raw, /^Message-ID: <[^@\r\n]+@example\.com>$/im);
  assert.ok(raw.includes("MIME-Version: 1.0"));

  // Every line fits in 998 octets.
  for (const line of raw.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 998, `line too long: ${line.slice(0, 40)}`);
  }
});

test("long lines are wrapped so every line stays within 998 octets", () => {
  const raw = buildMessage({
    from: { address: "sender@example.com" },
    to: ["a@example.test"],
    subject: `A very long subject ${"x".repeat(1500)}`,
    text: `${"y".repeat(2000)}\nsecond line`,
  });
  assert.ok(!/(?<!\r)\n/.test(raw));
  for (const line of raw.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 998, `line too long (${line.length})`);
  }
});

test("single-part message without html", () => {
  const raw = buildMessage({
    from: { address: "sender@example.com" },
    to: ["a@example.test", "b@example.test"],
    subject: "Plain",
    text: "hello",
  });
  assert.ok(!raw.includes("multipart"));
  assert.ok(raw.includes("Content-Type: text/plain; charset=utf-8"));
  assert.ok(!raw.includes("Reply-To:"));
  assert.ok(raw.includes("To: a@example.test, b@example.test"));
});

test("sendMail uses the injected clock for the Date header", async () => {
  const fake = createFake(plainScript(["250-mail.example.test Hi\r\n250 AUTH PLAIN\r\n"]), [
    "220 mail.example.test ESMTP\r\n",
  ]);
  await sendMail(baseOptions(), {
    connect: () => fake.socket,
    now: () => new Date("2026-11-22T12:00:00.000Z"),
  });
  const sent = transmittedMessage(fake);
  assert.ok(sent.includes("Date: Sun, 22 Nov 2026 12:00:00 +0000"));
  assert.equal(fake.closed(), true);
});

test("a failed QUIT after the server accepted the body still reports success", async () => {
  const steps = plainScript(["250-mail.example.test Hello\r\n250 AUTH PLAIN\r\n"]);
  const quit = steps[steps.length - 1];
  assert.ok(quit && "expect" in quit);
  quit.respond = ["421 Closing connection\r\n"];
  const fake = createFake(steps, ["220 mail.example.test ESMTP ready\r\n"]);
  const result = await sendMail(baseOptions(), { connect: async () => fake.socket });
  assert.deepEqual(result.accepted, TO);
  assert.equal(fake.closed(), true);
});
