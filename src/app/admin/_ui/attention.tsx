"use client";

import { createContext, useContext, type ReactNode } from "react";

export type Attention = Partial<Record<"leads" | "drafts" | "bookings", number>>;
const Context = createContext<Attention>({});

export function AttentionProvider({ children, initialCounts = {} }: { children: ReactNode; initialCounts?: Attention }) {
  return <Context.Provider value={initialCounts}>{children}</Context.Provider>;
}

export function useAttention() { return useContext(Context); }
