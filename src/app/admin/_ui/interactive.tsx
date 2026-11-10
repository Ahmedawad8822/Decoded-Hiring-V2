"use client";

import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { Icon } from "./icon";

export function FileDrop({ className = "", onChange, "aria-label": accessibleName, ref: outerRef, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const [filename, setFilename] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return <div className={`file-drop ${dragging ? "is-dragging" : ""} ${className}`}
    onDragOver={e => { if (props.disabled) return; e.preventDefault(); setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={e => {
      e.preventDefault(); setDragging(false);
      if (props.disabled || !input.current) return;
      input.current.files = e.dataTransfer.files;
      input.current.dispatchEvent(new Event("change", { bubbles: true }));
    }}>
    <Icon name="upload" width="26" height="26" />
    <strong>{filename || "Drop a file here, or browse"}</strong><small>{props.accept || "Choose a file from your device"}</small>
    <input {...props} ref={node => { input.current = node; if (typeof outerRef === "function") outerRef(node); else if (outerRef) outerRef.current = node; }} type="file" aria-label={accessibleName || "File"} onChange={e => { setFilename(e.target.files?.[0]?.name || ""); onChange?.(e); }} />
  </div>;
}

export function Drawer({ children, triggerLabel = "Open navigation", title = "Studio navigation" }: { children: ReactNode; triggerLabel?: string; title?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const release = () => { document.body.style.overflow = ""; };
    const media = window.matchMedia("(min-width: 1024px)");
    const closeWide = () => { if (media.matches) dialog.close(); };
    dialog.addEventListener("close", release);
    media.addEventListener("change", closeWide);
    return () => { release(); dialog.removeEventListener("close", release); media.removeEventListener("change", closeWide); };
  }, []);
  const close = () => ref.current?.close();
  // Keep Tab / Shift+Tab cycling inside the open drawer (showModal alone lets
  // focus leave to the browser chrome after the last control).
  const trapTab = (e: import("react").KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !ref.current.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !ref.current.contains(active))) { e.preventDefault(); first.focus(); }
  };
  return <><button className="btn ghost st-burger" type="button" aria-label={triggerLabel} onClick={() => { ref.current?.showModal(); document.body.style.overflow = "hidden"; }}><Icon name="menu" /></button>
    <dialog ref={ref} className="studio-drawer" aria-labelledby={titleId} onKeyDown={trapTab} onClick={e => { if (e.target === ref.current) close(); }}>
      <div className="drawer-panel"><div className="drawer-heading"><h2 id={titleId}>{title}</h2><button className="btn ghost" type="button" aria-label="Close navigation" onClick={close}><Icon name="close" /></button></div><div onClick={e => { if ((e.target as HTMLElement).closest("a")) close(); }}>{children}</div></div>
    </dialog></>;
}

export function Tabs({ label, tabs, value, onChange, panelId }: { label: string; tabs: { value: string; label: string }[]; value: string; onChange: (value: string) => void; panelId?: string }) {
  return <div className="ui-tabs" role="tablist" aria-label={label}>{tabs.map((tab, i) => <button key={tab.value} role="tab" aria-controls={panelId} type="button" aria-selected={value === tab.value} tabIndex={value === tab.value ? 0 : -1} onClick={() => onChange(tab.value)} onKeyDown={e => {
    let target = i;
    if (e.key === "ArrowRight") target = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") target = (i + tabs.length - 1) % tabs.length;
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = tabs.length - 1;
    else return;
    e.preventDefault(); onChange(tabs[target].value);
    (e.currentTarget.parentElement?.children[target] as HTMLButtonElement)?.focus();
  }}>{tab.label}</button>)}</div>;
}

export function StatusFilters({ value, onChange, items }: { value: string; onChange: (value: string) => void; items: { value: string; label: string; count?: number }[] }) {
  return <div className="filter-chips" role="group" aria-label="Filter status">{items.map(item => <button type="button" key={item.value} aria-pressed={value === item.value} onClick={() => onChange(item.value)}>{item.label}{item.count !== undefined && <span>{item.count}</span>}</button>)}</div>;
}

export type ToastState = { title: string; message: string; type?: "info" | "error" };

/**
 * One toast at a time, auto-dismissed after `ms`. Each new toast cancels the
 * previous dismiss timer: otherwise an earlier toast's timer clears a newer one
 * early (e.g. "Archived" vanishing moments after it appears).
 */
export function useToast(ms = 4000) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const showToast = (title: string, message: string, type: "info" | "error" = "info") => {
    clearTimeout(timer.current);
    setToast({ title, message, type });
    timer.current = setTimeout(() => setToast(null), ms);
  };
  return [toast, showToast] as const;
}
