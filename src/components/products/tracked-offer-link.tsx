"use client";

import type { ComponentProps, ReactNode } from "react";

import { recordPublicOfferCta } from "@/features/analytics/public-actions";

export function TrackedOfferLink({
  offerSlug,
  route,
  target,
  surface,
  children,
  ...anchorProps
}: {
  offerSlug: string;
  route: "/coaching" | "/workshop";
  target: "schedule" | "lead" | "contact" | "checkout";
  surface: "hero-primary" | "hero-secondary" | "inline";
  children: ReactNode;
} & Omit<ComponentProps<"a">, "onClick">) {
  return (
    <a
      {...anchorProps}
      onClick={() => {
        void recordPublicOfferCta({
          eventKey: crypto.randomUUID(),
          offerSlug,
          route,
          target,
          surface,
        });
      }}
    >
      {children}
    </a>
  );
}
