import { z } from "zod";

// ============================================================================
// TRANSACTIONAL EMAIL CONFIGURATION (Batch G)
// ----------------------------------------------------------------------------
// All variables are OPTIONAL. Email is ENABLED only when SMTP_USERNAME,
// SMTP_PASSWORD and MAIL_FROM_ADDRESS are all set; otherwise the outbox
// queues rows but never sends, and nothing throws. Read lazily on every
// call (never at module load) so tests can swap env vars per case.
//
// Documented in .env.example and Docs/Engineering/DEPLOYMENT.md. Secrets
// (SMTP_PASSWORD) are never logged.
// ============================================================================

const emailConfigSchema = z.object({
  SMTP_HOST: z.string().trim().min(1).default("mail.spacemail.com"),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_USERNAME: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  SMTP_PASSWORD: z
    .string()
    .min(1)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  MAIL_FROM_ADDRESS: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  MAIL_FROM_NAME: z.string().trim().min(1).default("Decoded Hiring"),
  MAIL_REPLY_TO: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});

export interface EmailConfig {
  host: string;
  port: number;
  username?: string;
  /** Worker secret — never log this value. */
  password?: string;
  fromAddress?: string;
  fromName: string;
  replyTo?: string;
  /** True only when username, password and fromAddress are all set. */
  enabled: boolean;
}

function readEnv(): Record<string, string | undefined> {
  return {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USERNAME: process.env.SMTP_USERNAME,
    SMTP_PASSWORD: process.env.SMTP_PASSWORD,
    MAIL_FROM_ADDRESS: process.env.MAIL_FROM_ADDRESS,
    MAIL_FROM_NAME: process.env.MAIL_FROM_NAME,
    MAIL_REPLY_TO: process.env.MAIL_REPLY_TO,
  };
}

export function getEmailConfig(env: Record<string, string | undefined> = readEnv()): EmailConfig {
  const parsed = emailConfigSchema.parse(env);
  const enabled =
    parsed.SMTP_USERNAME !== undefined &&
    parsed.SMTP_PASSWORD !== undefined &&
    parsed.MAIL_FROM_ADDRESS !== undefined;
  return {
    host: parsed.SMTP_HOST,
    port: parsed.SMTP_PORT,
    username: parsed.SMTP_USERNAME,
    password: parsed.SMTP_PASSWORD,
    fromAddress: parsed.MAIL_FROM_ADDRESS,
    fromName: parsed.MAIL_FROM_NAME,
    replyTo: parsed.MAIL_REPLY_TO,
    enabled,
  };
}

/** True when the outbox is allowed to send (all credentials present). */
export function isEmailEnabled(
  env: Record<string, string | undefined> = readEnv(),
): boolean {
  return getEmailConfig(env).enabled;
}
