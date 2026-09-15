import { ImageResponse } from "next/og";

// ============================================================================
// OG IMAGE (1200x630) — remediation B.1
// ----------------------------------------------------------------------------
// Replaces the former broken /api/og metadata target: this is a real,
// supported Next.js route producing a valid 1200x630 PNG at request time.
// Simple typographic card in the approved public visual language (dark
// studio palette), no external font/image fetches so it renders anywhere.
// ============================================================================

export const runtime = "nodejs";

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px 100px",
          backgroundColor: "#101418",
          color: "#f5f2ea",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 30,
            letterSpacing: 6,
            textTransform: "uppercase",
            color: "#e8a87c",
            display: "flex",
          }}
        >
          Decoded Hiring
        </div>
        <div
          style={{
            fontSize: 76,
            fontWeight: 700,
            lineHeight: 1.15,
            marginTop: 28,
            display: "flex",
          }}
        >
          Recruitment strategy, practical learning and human-led AI systems.
        </div>
        <div
          style={{
            fontSize: 32,
            marginTop: 40,
            color: "#9aa3ad",
            display: "flex",
          }}
        >
          Ahmed Awad — decodedhiring.com
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
