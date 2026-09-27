"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";

import type { BoundedAdminList } from "@/features/commerce/admin-model";

export type ActionResult = { ok: boolean; error?: string };

export const cardStyle: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-surface)",
  background: "var(--paper-bright)",
  padding: "20px 22px",
};

export const fieldStyle: React.CSSProperties = {
  padding: "9px 11px",
  borderRadius: 8,
  border: "1px solid var(--line-strong)",
  fontSize: 13,
  width: "100%",
};

export const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: 5,
  fontSize: 12,
  fontWeight: 600,
};

export const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  margin: 0,
};

export function nullable(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

export function integer(value: FormDataEntryValue | null, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function minutesFromClock(value: FormDataEntryValue | null): number {
  const [hours, minutes] = String(value ?? "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

export function clockFromMinutes(value: number): string {
  const hours = Math.floor(value / 60).toString().padStart(2, "0");
  const minutes = (value % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function dateTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function money(amountMinor: number | null, currency: string | null): string {
  if (amountMinor == null || !currency) return "Not priced";
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

export function StatusPill({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: "1px solid var(--line)",
        borderRadius: 999,
        padding: "3px 8px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: ".02em",
      }}
    >
      {children}
    </span>
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      style={{
        padding: "10px 14px",
        borderRadius: 8,
        background: "var(--coral-soft, #f5d6cd)",
        color: "#7c2d12",
        border: "1px solid rgba(235,116,94,.4)",
        fontSize: 13,
      }}
    >
      {error}
    </div>
  );
}

export function BoundedListNote<T>({
  list,
  label,
}: {
  list: BoundedAdminList<T>;
  label: string;
}) {
  if (!list.truncated) return null;
  return (
    <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
      Showing {list.items.length} of {list.total} {label}. The total is authoritative.
    </p>
  );
}

export function useAdminMutation() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<ActionResult>) {
    setBusy(key);
    setError(null);
    try {
      const result = await fn();
      if (!result.ok) {
        setError(result.error || "Action failed.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Action failed.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { busy, error, setError, run };
}
