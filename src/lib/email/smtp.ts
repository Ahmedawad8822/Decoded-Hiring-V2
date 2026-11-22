/**
 * Dependency-free SMTP client for sending mail through an SMTP relay.
 *
 * Runs in Cloudflare Workers: it has no dependencies, uses only
 * Web-standard APIs (TextEncoder/TextDecoder, streams, getRandomValues
 * with a Math.random fallback) and never imports `cloudflare:sockets`.
 * In production the caller injects a `connect` that wraps
 * `connect({ hostname, port }, { secureTransport: "on" })`
 * (implicit TLS, typically port 465). Tests inject a scripted fake.
 *
 * Covers RFC 5321 (conversation) and RFC 5322 (message building).
 */

export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void | Promise<void>;
}

export interface MailAddress {
  address: string;
  name?: string;
}

export interface BuildMessageOptions {
  from: MailAddress;
  to: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailOptions extends BuildMessageOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  clientName?: string;
  timeoutMs?: number;
}

export interface BuildMessageInject {
  /** Fixed timestamp for the Date header (defaults to the current time). */
  now?: Date;
}

export interface SendMailDeps {
  connect(host: string, port: number): SmtpSocket | Promise<SmtpSocket>;
  /** Clock used for the Date header (defaults to the current time). */
  now?: () => Date;
}

export interface SendMailResult {
  messageId: string;
  accepted: string[];
}

/** Stage of the SMTP conversation during which an error occurred. */
export type SmtpStage =
  | "GREETING"
  | "EHLO"
  | "AUTH"
  | "MAIL"
  | "RCPT"
  | "DATA"
  | "BODY"
  | "QUIT";

/**
 * Typed SMTP failure carrying the server reply code, the conversation
 * stage and the server text. Never contains credentials: error text is
 * built only from server replies, never from client commands.
 */
export class SmtpError extends Error {
  readonly code: number;
  readonly stage: SmtpStage | "TIMEOUT";
  readonly serverText: string;

  constructor(code: number, stage: SmtpStage | "TIMEOUT", serverText: string) {
    super(`SMTP ${stage} failed (code ${code}): ${serverText}`);
    this.name = "SmtpError";
    this.code = code;
    this.stage = stage;
    this.serverText = serverText;
  }
}

/** Thrown for invalid message input (header injection, bad addresses). */
export class SmtpMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpMessageError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LINE_OCTETS = 998;
const HEADER_WRAP_LIMIT = 78;
const MULTILINE_CAP = 50;

/** Conservative address check: local@domain, no spaces or angle brackets. */
const ADDRESS_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] ?? 0) : 0;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] ?? 0) : 0;
    const group = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(group >> 18) & 63];
    out += BASE64_ALPHABET[(group >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(group >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[group & 63] : "=";
  }
  return out;
}

function randomHex(numBytes: number): string {
  const bytes = new Uint8Array(numBytes);
  const cryptoObject = (globalThis as unknown as {
    crypto?: { getRandomValues?: (array: Uint8Array) => void };
  }).crypto;
  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function assertNoCrlf(value: string, field: string): void {
  if (value.includes("\r") || value.includes("\n")) {
    throw new SmtpMessageError(`${field} must not contain CR or LF characters.`);
  }
}

function assertValidAddress(address: string, field: string): void {
  assertNoCrlf(address, field);
  if (!ADDRESS_RE.test(address)) {
    throw new SmtpMessageError(
      `Invalid email address in ${field}: must look like local@domain with no spaces or angle brackets.`,
    );
  }
}

function needsRfc2047(value: string): boolean {
  return /[^\x20-\x7e]/.test(value);
}

/**
 * RFC 2047 encoded-word(s) for a non-ASCII header value. Splits long
 * values into several encoded-words so no header line grows unbounded.
 */
function encodeWord(value: string): string {
  const bytes = utf8Bytes(value);
  const words: string[] = [];
  const chunkSize = 30;
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + chunkSize, bytes.length);
    // Never split inside a multi-byte sequence: the byte at the cut must
    // be a leading byte, not a UTF-8 continuation byte (10xxxxxx).
    while (end > start && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }
    if (end <= start) {
      end = Math.min(start + chunkSize, bytes.length);
      while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
        end += 1;
      }
    }
    words.push(`=?UTF-8?B?${base64Encode(bytes.slice(start, end))}?=`);
    start = end;
  }
  return words.join(" ");
}

function formatDisplayName(name: string): string {
  assertNoCrlf(name, "From name");
  if (needsRfc2047(name)) {
    return encodeWord(name);
  }
  if (/[()<>[\]:;@\\,."]/.test(name) || name.trim() !== name || name.length === 0) {
    return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return name;
}

function formatSubject(subject: string): string {
  assertNoCrlf(subject, "Subject");
  return needsRfc2047(subject) ? encodeWord(subject) : subject;
}

/** Fold a header line near 78 columns; continuations start with a space. */
function foldHeaderLine(line: string, limit: number = HEADER_WRAP_LIMIT): string {
  if (line.length <= limit) {
    return line;
  }
  const chunks: string[] = [];
  for (const word of line.split(" ")) {
    let rest = word;
    while (rest.length > limit) {
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    if (rest.length > 0) {
      chunks.push(rest);
    }
  }
  let out = chunks[0] ?? "";
  let current = out.length;
  for (let i = 1; i < chunks.length; i += 1) {
    const word = chunks[i] ?? "";
    if (current + 1 + word.length <= limit) {
      out += ` ${word}`;
      current += 1 + word.length;
    } else {
      out += `\r\n ${word}`;
      current = 1 + word.length;
    }
  }
  return out;
}

function formatDateRfc5322(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const day = DAY_NAMES[date.getUTCDay()] ?? "Thu";
  const month = MONTH_NAMES[date.getUTCMonth()] ?? "Jan";
  return (
    `${day}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

function qpToken(byte: number, isLast: boolean): string {
  if (byte === 61) {
    return "=3D";
  }
  if (byte === 32 || byte === 9) {
    if (isLast) {
      return byte === 32 ? "=20" : "=09";
    }
    return byte === 32 ? " " : "\t";
  }
  if (byte >= 33 && byte <= 126) {
    return String.fromCharCode(byte);
  }
  return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

/** Encode one logical line as quoted-printable, wrapping at 76 columns. */
function qpEncodeLine(line: string): string {
  const bytes = utf8Bytes(line);
  const tokens: string[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    tokens.push(qpToken(bytes[i] ?? 0, i === bytes.length - 1));
  }
  let out = "";
  let current = "";
  for (const token of tokens) {
    if (current.length + token.length > 76) {
      out += `${current}=\r\n`;
      current = "";
    }
    current += token;
  }
  out += current;
  return out;
}

/**
 * Quoted-printable body with CRLF endings and dot-stuffing (any
 * transmitted line starting with "." gains an extra ".").
 */
function qpEncodeBody(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized
    .split("\n")
    .map((line) => {
      const encoded = qpEncodeLine(line);
      return encoded
        .split("\r\n")
        .map((part) => (part.startsWith(".") ? `.${part}` : part))
        .join("\r\n");
    })
    .join("\r\n");
}

function validateMessageInput(options: BuildMessageOptions): void {
  assertValidAddress(options.from.address, "from");
  if (options.from.name !== undefined) {
    assertNoCrlf(options.from.name, "From name");
  }
  if (options.to.length === 0) {
    throw new SmtpMessageError("At least one recipient is required.");
  }
  for (const recipient of options.to) {
    assertValidAddress(recipient, "to");
  }
  if (options.replyTo !== undefined) {
    assertValidAddress(options.replyTo, "replyTo");
  }
  assertNoCrlf(options.subject, "Subject");
  if (typeof options.text !== "string") {
    throw new SmtpMessageError("A text body is required.");
  }
  if (options.html !== undefined && typeof options.html !== "string") {
    throw new SmtpMessageError("The html body must be a string when provided.");
  }
}

/**
 * Build the raw RFC 5322 message (CRLF endings). Returns the message
 * text; the Message-ID header it generates is returned by `sendMail`.
 */
export function buildMessage(
  options: BuildMessageOptions,
  inject?: BuildMessageInject,
): string {
  validateMessageInput(options);

  const fromDomain = options.from.address.split("@")[1] ?? "example.test";
  const messageId = `<${randomHex(12)}@${fromDomain.toLowerCase()}>`;
  const date = formatDateRfc5322(inject?.now ?? new Date());

  const fromValue =
    options.from.name === undefined
      ? options.from.address
      : `${formatDisplayName(options.from.name)} <${options.from.address}>`;

  const headers = [
    foldHeaderLine(`From: ${fromValue}`),
    foldHeaderLine(`To: ${options.to.join(", ")}`),
  ];
  if (options.replyTo !== undefined) {
    headers.push(foldHeaderLine(`Reply-To: ${options.replyTo}`));
  }
  headers.push(foldHeaderLine(`Subject: ${formatSubject(options.subject)}`));
  headers.push(`Date: ${date}`);
  headers.push(`Message-ID: ${messageId}`);
  headers.push("MIME-Version: 1.0");

  if (options.html === undefined) {
    headers.push("Content-Type: text/plain; charset=utf-8");
    headers.push("Content-Transfer-Encoding: quoted-printable");
    return `${headers.join("\r\n")}\r\n\r\n${qpEncodeBody(options.text)}`;
  }

  let boundary = `b${randomHex(12)}`;
  let guard = 0;
  while (
    (options.text.includes(boundary) || options.html.includes(boundary)) &&
    guard < 10
  ) {
    boundary = `b${randomHex(12)}`;
    guard += 1;
  }

  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qpEncodeBody(options.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qpEncodeBody(options.html),
    `--${boundary}--`,
  ];
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
}

function extractMessageId(raw: string): string {
  const match = raw.match(/^Message-ID:\s*(<[^\r\n>]+>)/im);
  if (!match?.[1]) {
    throw new SmtpMessageError("Built message is missing a Message-ID header.");
  }
  return match[1];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SmtpError(0, "TIMEOUT", `Timed out waiting for the server after ${ms} ms.`));
    }, ms);
  });
  const guarded = Promise.race([promise, timeout]) as Promise<T>;
  return guarded.finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/** CRLF-buffered line reader over the socket's readable stream. */
class SmtpLineReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private queue: string[] = [];
  private ended = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async readLine(timeoutMs: number, stage: SmtpStage): Promise<string> {
    while (this.queue.length === 0) {
      if (this.ended) {
        if (this.buffer.length > 0) {
          throw new SmtpError(0, stage, "Connection ended mid-reply without CRLF.");
        }
        throw new SmtpError(0, stage, "Connection closed by the server.");
      }
      const result = await withTimeout(this.reader.read(), timeoutMs).catch(
        (error: unknown) => {
          if (error instanceof SmtpError && error.stage === "TIMEOUT") {
            throw new SmtpError(0, stage, error.serverText);
          }
          throw error;
        },
      );
      if (result.done || result.value === undefined) {
        this.ended = true;
        continue;
      }
      this.buffer += this.decoder.decode(result.value, { stream: true });
      const parts = this.buffer.split(/\r\n|\n/);
      this.buffer = parts.pop() ?? "";
      this.queue.push(...parts);
    }
    const line = this.queue.shift();
    if (line === undefined) {
      throw new SmtpError(0, stage, "Connection closed by the server.");
    }
    return line;
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // Already closed or released; socket.close() still runs.
    }
    try {
      this.reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}

interface SmtpReply {
  code: number;
  lines: string[];
  text: string;
}

function parseReplyLine(line: string): { code: number; more: boolean; text: string } | null {
  const match = line.match(/^(\d{3})([ -])(.*)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    code: Number.parseInt(match[1], 10),
    more: match[2] === "-",
    text: match[3] ?? "",
  };
}

/** Read one (possibly multi-line, 250-.../250 ...) server reply. */
async function readReply(
  reader: SmtpLineReader,
  timeoutMs: number,
  stage: SmtpStage,
): Promise<SmtpReply> {
  const first = await reader.readLine(timeoutMs, stage);
  const parsed = parseReplyLine(first);
  if (!parsed) {
    throw new SmtpError(0, stage, `Invalid server reply: ${first.slice(0, 200)}`);
  }
  const lines = [parsed.text];
  if (parsed.more) {
    for (let i = 0; i < MULTILINE_CAP; i += 1) {
      const next = await reader.readLine(timeoutMs, stage);
      const part = parseReplyLine(next);
      if (!part) {
        throw new SmtpError(parsed.code, stage, `Invalid server reply: ${next.slice(0, 200)}`);
      }
      lines.push(part.text);
      if (!part.more && part.code === parsed.code) {
        break;
      }
      if (!part.more) {
        break;
      }
      if (i === MULTILINE_CAP - 1) {
        throw new SmtpError(parsed.code, stage, "Server reply has too many lines.");
      }
    }
  }
  return { code: parsed.code, lines, text: lines.join(" ") };
}

function expectCode(reply: SmtpReply, expected: number[], stage: SmtpStage): void {
  if (!expected.includes(reply.code)) {
    throw new SmtpError(reply.code, stage, reply.text);
  }
}

/** AUTH mechanisms advertised in the EHLO reply (handles "AUTH x" / "AUTH=x"). */
function parseAuthMechanisms(lines: string[]): Set<string> {
  const mechanisms = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^AUTH(?:[ =](.*))?$/i);
    const rest = match?.[1];
    if (rest === undefined) {
      continue;
    }
    for (const token of rest.split(/\s+/)) {
      if (token) {
        mechanisms.add(token.toUpperCase());
      }
    }
  }
  return mechanisms;
}

/**
 * Send one message via SMTP. `deps.connect` provides the socket (in
 * production, a Cloudflare `cloudflare:sockets` connection with implicit
 * TLS). Always closes the socket, including on error.
 */
export async function sendMail(
  options: MailOptions,
  deps: SendMailDeps,
): Promise<SendMailResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Validate credentials for line-injection before touching the network.
  // Error text never echoes these values.
  for (const [field, value] of [
    ["username", options.username],
    ["password", options.password],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new SmtpMessageError(`${field} must be a non-empty string.`);
    }
    assertNoCrlf(value, field);
  }
  const clientName = options.clientName ?? "localhost";
  assertNoCrlf(clientName, "clientName");
  if (/\s/.test(clientName) || clientName.length === 0) {
    throw new SmtpMessageError("clientName must be a single hostname without whitespace.");
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new SmtpMessageError("port must be an integer between 1 and 65535.");
  }

  // Build (and validate) the message before connecting.
  const raw = buildMessage(options, deps.now ? { now: deps.now() } : undefined);
  const messageId = extractMessageId(raw);

  const socket = await deps.connect(options.host, options.port);
  const reader = new SmtpLineReader(socket.readable);
  const writer = socket.writable.getWriter();
  const close = async (): Promise<void> => {
    await reader.close();
    try {
      writer.releaseLock();
    } catch {
      // Already released.
    }
    await socket.close();
  };

  const write = async (bytes: Uint8Array): Promise<void> => {
    await withTimeout(writer.write(bytes), timeoutMs);
  };

  try {
    const greeting = await readReply(reader, timeoutMs, "GREETING");
    expectCode(greeting, [220], "GREETING");

    await write(utf8Bytes(`EHLO ${clientName}\r\n`));
    const ehlo = await readReply(reader, timeoutMs, "EHLO");
    expectCode(ehlo, [250], "EHLO");

    const mechanisms = parseAuthMechanisms(ehlo.lines);
    if (mechanisms.has("PLAIN")) {
      const initial = base64Encode(utf8Bytes(`\0${options.username}\0${options.password}`));
      await write(utf8Bytes(`AUTH PLAIN ${initial}\r\n`));
      expectCode(await readReply(reader, timeoutMs, "AUTH"), [235], "AUTH");
    } else if (mechanisms.has("LOGIN")) {
      await write(utf8Bytes("AUTH LOGIN\r\n"));
      expectCode(await readReply(reader, timeoutMs, "AUTH"), [334], "AUTH");
      await write(utf8Bytes(`${base64Encode(utf8Bytes(options.username))}\r\n`));
      expectCode(await readReply(reader, timeoutMs, "AUTH"), [334], "AUTH");
      await write(utf8Bytes(`${base64Encode(utf8Bytes(options.password))}\r\n`));
      expectCode(await readReply(reader, timeoutMs, "AUTH"), [235], "AUTH");
    } else {
      throw new SmtpError(
        ehlo.code,
        "AUTH",
        `Server does not advertise a supported auth mechanism (PLAIN, LOGIN): ${ehlo.text}`,
      );
    }

    await write(utf8Bytes(`MAIL FROM:<${options.from.address}>\r\n`));
    expectCode(await readReply(reader, timeoutMs, "MAIL"), [250], "MAIL");

    const accepted: string[] = [];
    for (const recipient of options.to) {
      await write(utf8Bytes(`RCPT TO:<${recipient}>\r\n`));
      expectCode(await readReply(reader, timeoutMs, "RCPT"), [250, 251], "RCPT");
      accepted.push(recipient);
    }

    await write(utf8Bytes("DATA\r\n"));
    expectCode(await readReply(reader, timeoutMs, "DATA"), [354], "DATA");

    await write(utf8Bytes(`${raw}\r\n.\r\n`));
    expectCode(await readReply(reader, timeoutMs, "BODY"), [250], "BODY");

    // The message is accepted once the server answers 250 to the body. A
    // failed QUIT must not turn that into an error, or a retry would send
    // the same email twice.
    try {
      await withTimeout(writer.write(utf8Bytes("QUIT\r\n")), timeoutMs);
      await readReply(reader, timeoutMs, "QUIT");
    } catch {
      // Ignored: delivery already succeeded.
    }

    await close();
    return { messageId, accepted };
  } catch (error) {
    await close();
    throw error;
  }
}

export const SMTP_MAX_LINE_OCTETS = MAX_LINE_OCTETS;
