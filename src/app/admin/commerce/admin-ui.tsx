"use client";

import Link from "next/link";
import React, { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type {
  BoundedAdminList,
  CommerceAdminPageKey,
} from "@/features/commerce/admin-model";

export type ActionResult = { ok: boolean; error?: string };

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

export { StatusPill } from "../_ui";

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="s-padding-10px-14px s-danger s-text-sm"
      role="alert"

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
  return (
    <p className="muted s-margin-6px-0-0 s-text-sm" >
      Showing {list.items.length} of {list.total} {label}
      {list.totalPages > 1 ? ` · page ${list.page} of ${list.totalPages}` : ""}.
    </p>
  );
}

export function PageControls<T>({
  pageKey,
  list,
  anchor,
}: {
  pageKey: CommerceAdminPageKey;
  list: BoundedAdminList<T>;
  anchor: string;
}) {
  const searchParams = useSearchParams();
  if (list.totalPages <= 1) return null;

  const href = (page: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(pageKey, String(page));
    return `?${params.toString()}#${anchor}`;
  };

  return (
    <div className="s-row s-gap-8 s-align-items-center s-flex-wrap-wrap" >
      {list.page > 1 && (
        <Link className="btn ghost small" href={href(list.page - 1)}>
          Previous
        </Link>
      )}
      <span className="muted s-text-xs" >
        Page {list.page} of {list.totalPages}
      </span>
      {list.page < list.totalPages && (
        <Link className="btn ghost small" href={href(list.page + 1)}>
          Next
        </Link>
      )}
    </div>
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
