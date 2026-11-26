"use client";

import { useActionState, useEffect, useRef, useState, Suspense, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

import { submitLandingLead } from "@/features/leads/actions";
import type { LeadActionState } from "@/features/leads/types";
import { recordLandingPageCta, recordLandingPageView } from "@/features/analytics/public-actions";
import { appendUtmsToHref, parseUtmParams } from "@/features/landing-pages/types";

// ============================================================================
// LANDING PAGE CLIENT ISLAND
// ----------------------------------------------------------------------------
// Everything request-specific (UTMs, view/CTA events, the lead form) lives
// here so the server page stays cacheable: it never reads searchParams,
// cookies or headers. Links work without JavaScript (bare href); UTM
// pass-through and analytics are progressive enhancement.
// ============================================================================

function useUtmQuery(): string {
  const params = useSearchParams();
  const utms = parseUtmParams(params);
  const entries = Object.entries(utms);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join("&");
}

/** Fires the view event once per page load (best-effort, rate-limited). */
export function LandingPageTracker({ pageId, slug }: { pageId: string; slug: string }) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void recordLandingPageView({
      eventKey: crypto.randomUUID(),
      landingPageId: pageId,
      slug,
    });
  }, [pageId, slug]);
  return null;
}

export function TrackedLandingCta({
  pageId,
  slug,
  href,
  surface,
  children,
}: {
  pageId: string;
  slug: string;
  href: string;
  surface: "hero" | "cta_band" | "target_summary" | "sticky";
  children: ReactNode;
}) {
  return (
    <Suspense fallback={<a className="hg-primary" href={href}>{children}</a>}>
      <TrackedLandingCtaInner pageId={pageId} slug={slug} href={href} surface={surface}>
        {children}
      </TrackedLandingCtaInner>
    </Suspense>
  );
}

function TrackedLandingCtaInner({
  pageId,
  slug,
  href,
  surface,
  children,
}: {
  pageId: string;
  slug: string;
  href: string;
  surface: "hero" | "cta_band" | "target_summary" | "sticky";
  children: ReactNode;
}) {
  const params = useSearchParams();
  const withUtms = appendUtmsToHref(href, parseUtmParams(params));
  return (
    <a
      className="hg-primary"
      href={withUtms}
      onClick={() => {
        void recordLandingPageCta({
          eventKey: crypto.randomUUID(),
          landingPageId: pageId,
          slug,
          surface,
        });
      }}
    >
      {children}
    </a>
  );
}

function FieldError({ state, name }: { state: LeadActionState; name: string }) {
  const error = state && !state.ok ? state.fieldErrors?.[name]?.[0] : undefined;
  return error ? <p className="hg-form-error">{error}</p> : null;
}

/** Lead-capture form for the "lead form" block: UTMs ride as hidden fields. */
export function LandingLeadBlock({ slug }: { slug: string }) {
  const action = submitLandingLead.bind(null, slug);
  const [state, formAction, pending] = useActionState(action, undefined);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const utmQuery = useUtmQuery();
  const utmFields = utmQuery
    ? Object.fromEntries(utmQuery.split("&").map((pair) => pair.split("=").map(decodeURIComponent)))
    : {};

  if (state?.ok) {
    return (
      <div className="hg-lead-success" role="status">
        <p className="hg-kicker">Request received</p>
        <h3>Your context has been saved.</h3>
        <p>{state.message}</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="hg-form-grid">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {Object.entries(utmFields).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value as string} />
      ))}
      <label className="hg-honeypot" aria-hidden="true">
        Website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <div className="hg-field">
        <label htmlFor={`landing-${slug}-name`}>Name</label>
        <input id={`landing-${slug}-name`} name="fullName" autoComplete="name" required />
        <FieldError state={state} name="fullName" />
      </div>
      <div className="hg-field">
        <label htmlFor={`landing-${slug}-email`}>Work email</label>
        <input
          id={`landing-${slug}-email`}
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        <FieldError state={state} name="email" />
      </div>
      <div className="hg-field">
        <label htmlFor={`landing-${slug}-country`}>Country</label>
        <select id={`landing-${slug}-country`} name="countryCode" defaultValue="EG" autoComplete="country">
          <option value="EG">Egypt</option>
          <option value="SA">Saudi Arabia</option>
          <option value="AE">United Arab Emirates</option>
          <option value="QA">Qatar</option>
          <option value="KW">Kuwait</option>
          <option value="BH">Bahrain</option>
          <option value="OM">Oman</option>
        </select>
      </div>
      <div className="hg-field">
        <label htmlFor={`landing-${slug}-phone`}>Phone / WhatsApp (optional)</label>
        <input
          id={`landing-${slug}-phone`}
          name="phoneE164"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+201001234567"
        />
        <FieldError state={state} name="phoneE164" />
      </div>
      <div className="hg-field hg-full">
        <label htmlFor={`landing-${slug}-problem`}>What is happening now?</label>
        <textarea
          id={`landing-${slug}-problem`}
          name="problemSummary"
          minLength={20}
          maxLength={2000}
          required
        />
        <p className="hg-field-hint">
          Do not include candidate names or confidential personal information.
        </p>
        <FieldError state={state} name="problemSummary" />
      </div>
      <div className="hg-field hg-full">
        <label htmlFor={`landing-${slug}-outcome`}>What should be different?</label>
        <textarea id={`landing-${slug}-outcome`} name="desiredOutcome" maxLength={1200} />
      </div>
      <fieldset className="hg-consent-box hg-full">
        <legend>How we may use your details</legend>
        <label>
          <input type="checkbox" name="privacyAcknowledged" required /> I understand that my
          details and message are used to review and reply to this request. Required.
        </label>
        <label>
          <input type="checkbox" name="emailMarketing" /> Email me useful hiring notes and
          relevant programme updates. Optional.
        </label>
      </fieldset>
      {state && !state.ok && (
        <p className="hg-form-status hg-full" role="alert">
          {state.message} Reference: {state.requestId.slice(0, 8)}
        </p>
      )}
      <div className="hg-actions hg-full">
        <button type="submit" className="hg-primary" disabled={pending}>
          {pending ? "Sending safely…" : "Send the context"}
        </button>
      </div>
    </form>
  );
}
