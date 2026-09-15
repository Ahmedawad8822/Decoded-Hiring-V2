import { notFound } from "next/navigation";
import { NextResponse } from "next/server";

export async function GET() {
  // Hard security gate: strictly development-only
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }

  const email = process.env.ADMIN_INITIAL_EMAIL || "";
  const password = process.env.ADMIN_INITIAL_PASSWORD || "";

  return NextResponse.json({ email, password });
}
