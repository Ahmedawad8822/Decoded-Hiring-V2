import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Static header CSP (no per-request nonce, so public routes stay prerendered /
// ISR and cache-first). Trade-off: Next's inline bootstrap scripts
// (self.__next_f.push flight data, runtime chunks) cannot be allow-listed by
// hash in a static header, so script-src needs 'unsafe-inline'.
// JSON-LD (<script type="application/ld+json">) is non-executable data and is
// not governed by script-src. Move to hashes/nonces later if the cost allows.
const contentSecurityPolicy = [
  // Fallback for any fetch directive not listed below.
  "default-src 'self'",
  // Self-hosted bundles + Next's inline bootstrap (see note above);
  // 'unsafe-eval' only in dev for React debugging / HMR.
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  // Same-origin CSS; React style={{}} attributes and Next-inlined CSS need
  // 'unsafe-inline'.
  "style-src 'self' 'unsafe-inline'",
  // Own images, next/image (/_next/image), inline data: and blob: previews.
  "img-src 'self' data: blob:",
  // System fonts only (no next/font, no Google Fonts); data: for inlined assets.
  "font-src 'self' data:",
  // fetch/XHR/server actions to own origin (+ HMR websocket in dev).
  `connect-src 'self'${isProd ? "" : " ws: wss:"}`,
  // Lesson videos: only the privacy-enhanced YouTube embed origin used by
  // src/features/courses/youtube.ts.
  "frame-src https://www.youtube-nocookie.com",
  // No plugins / <object> / <embed>.
  "object-src 'none'",
  // Block <base> tag injection from rewriting relative URLs.
  "base-uri 'self'",
  // Forms (incl. login) may only post to this origin.
  "form-action 'self'",
  // Only same-origin framing; matches X-Frame-Options: SAMEORIGIN.
  "frame-ancestors 'self'",
  // Workers from own origin only (blob: for bundler-generated workers).
  "worker-src 'self' blob:",
  // Upgrade http subresources; production only so local http dev still works.
  ...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), browsing-topics=(), payment=(), usb=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["wrangler", "miniflare", "esbuild"],
  // Staff preview (?preview=true) must read the session, which would make the
  // public article routes dynamic. Rewrite it to dedicated dynamic routes so
  // /guides/[slug] and /field-notes/[slug] stay static/ISR. The browser URL
  // is unchanged. beforeFiles so it wins over the dynamic segment.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/guides/:slug",
          has: [{ type: "query" as const, key: "preview", value: "true" }],
          destination: "/preview/guides/:slug",
        },
        {
          source: "/field-notes/:slug",
          has: [{ type: "query" as const, key: "preview", value: "true" }],
          destination: "/preview/field-notes/:slug",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
