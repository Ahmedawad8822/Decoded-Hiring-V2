"use client";

import { CalendarDays, CheckCircle2, Clock3, RefreshCw } from "lucide-react";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";

import { recordPublicBookingStarted } from "@/features/analytics/public-actions";
import {
  submitPublicBooking,
  type PublicBookingActionState,
} from "@/features/scheduling/public-actions";
import type {
  PublicSchedulingConfig,
  PublicSchedulingSlot,
} from "@/features/scheduling/public-scheduling";
import type { PublicBookingSlotsResponse } from "@/features/scheduling/public-slots-handler";

type EnabledConfig = Extract<PublicSchedulingConfig, { enabled: true }>;

type SlotsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unavailable" }
  | { status: "ready"; slots: PublicSchedulingSlot[] };

// Fetches live availability from the cached page's companion route handler.
// Same-origin, never cached. The server re-validates the slot on submit.
async function fetchSlots(
  config: EnabledConfig,
  signal: AbortSignal,
): Promise<SlotsState> {
  const response = await fetch(
    "/api/public/booking-slots?offer=" + encodeURIComponent(config.offerSlug),
    { cache: "no-store", signal, headers: { Accept: "application/json" } },
  );
  if (!response.ok) return { status: "error" };
  const body = (await response.json()) as PublicBookingSlotsResponse;
  if (!body.enabled) return { status: "unavailable" };
  // The cached shell is older than the Studio config: refuse to book against
  // a different booking type than the form was rendered for.
  if (body.bookingTypeId !== config.bookingTypeId) {
    return { status: "unavailable" };
  }
  return { status: "ready", slots: body.slots };
}

function fieldError(
  state: PublicBookingActionState,
  name: string,
): string | undefined {
  return state && !state.ok ? state.fieldErrors?.[name]?.[0] : undefined;
}

function dayKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function dayLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function timeLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function groupSlots(
  slots: PublicSchedulingSlot[],
  timeZone: string,
): Array<{ key: string; label: string; slots: PublicSchedulingSlot[] }> {
  const groups = new Map<
    string,
    { key: string; label: string; slots: PublicSchedulingSlot[] }
  >();

  for (const slot of slots) {
    const key = dayKey(slot.startAt, timeZone);
    const current = groups.get(key) ?? {
      key,
      label: dayLabel(slot.startAt, timeZone),
      slots: [],
    };
    current.slots.push(slot);
    groups.set(key, current);
  }
  return [...groups.values()];
}

export function PublicScheduler({
  config: model,
  fallbackHref,
  fallbackLabel,
}: {
  config: EnabledConfig;
  fallbackHref: string;
  fallbackLabel: string;
}) {
  const [slotsState, setSlotsState] = useState<SlotsState>({
    status: "loading",
  });
  const [reloadCount, setReloadCount] = useState(0);
  const slots = useMemo(
    () => (slotsState.status === "ready" ? slotsState.slots : []),
    [slotsState],
  );
  const [state, formAction, pending] = useActionState<
    PublicBookingActionState,
    FormData
  >(submitPublicBooking, undefined);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [acquisitionKey] = useState(() => crypto.randomUUID());
  const startedRef = useRef(false);
  const [selectedStartAt, setSelectedStartAt] = useState("");

  const groups = useMemo(
    () => groupSlots(slots, model.timezone),
    [slots, model.timezone],
  );
  const effectiveSelectedStartAt = slots.some(
    (slot) => slot.startAt === selectedStartAt,
  )
    ? selectedStartAt
    : slots[0]?.startAt ?? "";

  // A rejected submit with SLOT_UNAVAILABLE means another person reached the
  // slot first: `slotTaken` changes identity per result, so the effect below
  // reloads the live list in place (replaces the old router.refresh()).
  const slotTaken =
    state && !state.ok && state.code === "SLOT_UNAVAILABLE" ? state : null;

  useEffect(() => {
    const controller = new AbortController();
    fetchSlots(model, controller.signal).then(
      (next) => setSlotsState(next),
      () => {
        if (!controller.signal.aborted) setSlotsState({ status: "error" });
      },
    );
    return () => controller.abort();
  }, [model, reloadCount, slotTaken]);

  function retryLoad() {
    setSlotsState({ status: "loading" });
    setReloadCount((count) => count + 1);
  }

  function noteBookingStarted() {
    if (startedRef.current) return;
    startedRef.current = true;
    void recordPublicBookingStarted({
      eventKey: requestKey,
      offerSlug: model.offerSlug,
      offerKind: model.offerKind,
      bookingTypeId: model.bookingTypeId,
    });
  }

  if (state?.ok) {
    return (
      <div className="hg-scheduler-success" role="status">
        <CheckCircle2 aria-hidden="true" />
        <div>
          <p className="hg-kicker">Time reserved</p>
          <h3>{dayLabel(state.startAt, state.timezone)}</h3>
          <p>
            {timeLabel(state.startAt, state.timezone)} · {model.durationMinutes}{" "}
            minutes · {state.timezone}
          </p>
          <p>{state.message}</p>
          <small>Booking reference: {state.bookingId.slice(0, 12)}</small>
        </div>
      </div>
    );
  }

  if (slotsState.status === "loading") {
    return (
      <div
        className="hg-scheduler-empty"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <RefreshCw aria-hidden="true" />
        <div>
          <h3>Loading open times…</h3>
          <p>Checking live availability for {model.bookingTitle}.</p>
        </div>
      </div>
    );
  }

  if (slotsState.status === "error" || slotsState.status === "unavailable") {
    return (
      <div className="hg-scheduler-empty" role="status">
        <CalendarDays aria-hidden="true" />
        <div>
          <h3>
            {slotsState.status === "error"
              ? "Open times could not be loaded."
              : "Online scheduling is not available right now."}
          </h3>
          <p>
            {slotsState.status === "error"
              ? "Please try again. The enquiry route is still available."
              : "Please use the enquiry route instead."}
          </p>
          {slotsState.status === "error" && (
            <button type="button" className="hg-secondary" onClick={retryLoad}>
              Try again
            </button>
          )}{" "}
          <a className="hg-secondary" href={fallbackHref}>
            {fallbackLabel}
          </a>
        </div>
      </div>
    );
  }

  if (slots.length === 0) {
    return (
      <div className="hg-scheduler-empty">
        <CalendarDays aria-hidden="true" />
        <div>
          <h3>No open times are visible right now.</h3>
          <p>
            Availability can change as holds expire and new times are opened.
            The enquiry route is still available.
          </p>
          <a className="hg-secondary" href={fallbackHref}>
            {fallbackLabel}
          </a>
        </div>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="hg-scheduler"
      onFocusCapture={noteBookingStarted}
    >
      <input type="hidden" name="offerSlug" value={model.offerSlug} />
      <input type="hidden" name="offerKind" value={model.offerKind} />
      <input type="hidden" name="bookingTypeId" value={model.bookingTypeId} />
      <input type="hidden" name="startAt" value={effectiveSelectedStartAt} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <input type="hidden" name="acquisitionKey" value={acquisitionKey} />
      <label className="hg-honeypot" aria-hidden="true">
        Website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>

      <div className="hg-scheduler-times">
        <div className="hg-scheduler-heading">
          <div>
            <p className="hg-kicker">Choose a time</p>
            <h3>{model.bookingTitle}</h3>
          </div>
          <span>
            <Clock3 aria-hidden="true" />
            {model.durationMinutes} min
          </span>
        </div>

        <p className="hg-scheduler-timezone">
          Times shown in <strong>{model.timezone}</strong>.
        </p>

        <div className="hg-slot-days">
          {groups.map((group) => (
            <section className="hg-slot-day" key={group.key}>
              <h4>{group.label}</h4>
              <div className="hg-slot-grid">
                {group.slots.map((slot) => {
                  const selected = slot.startAt === effectiveSelectedStartAt;
                  return (
                    <button
                      key={slot.slotKey}
                      type="button"
                      className={"hg-slot" + (selected ? " is-selected" : "")}
                      aria-pressed={selected}
                      onClick={() => setSelectedStartAt(slot.startAt)}
                    >
                      {timeLabel(slot.startAt, model.timezone)}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      <div className="hg-scheduler-details">
        <p className="hg-kicker">Reserve the slot</p>
        <h3>Who should this time be held for?</h3>

        <div className="hg-form-grid">
          <div className="hg-field">
            <label htmlFor={model.offerKind + "-booking-name"}>Name</label>
            <input
              id={model.offerKind + "-booking-name"}
              name="requesterName"
              autoComplete="name"
              required
            />
            {fieldError(state, "requesterName") && (
              <p className="hg-form-error">
                {fieldError(state, "requesterName")}
              </p>
            )}
          </div>

          <div className="hg-field">
            <label htmlFor={model.offerKind + "-booking-email"}>
              Work email
            </label>
            <input
              id={model.offerKind + "-booking-email"}
              name="requesterEmail"
              type="email"
              autoComplete="email"
              required
            />
            {fieldError(state, "requesterEmail") && (
              <p className="hg-form-error">
                {fieldError(state, "requesterEmail")}
              </p>
            )}
          </div>

          <div className="hg-field hg-full">
            <label htmlFor={model.offerKind + "-booking-phone"}>
              Phone / WhatsApp (optional)
            </label>
            <input
              id={model.offerKind + "-booking-phone"}
              name="requesterPhone"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+201001234567"
            />
            {fieldError(state, "requesterPhone") && (
              <p className="hg-form-error">
                {fieldError(state, "requesterPhone")}
              </p>
            )}
          </div>

          <div className="hg-field hg-full">
            <label htmlFor={model.offerKind + "-booking-notes"}>
              Useful context (optional)
            </label>
            <textarea
              id={model.offerKind + "-booking-notes"}
              name="notes"
              maxLength={1200}
              placeholder="What should Ahmed know before the conversation?"
            />
            <p className="hg-field-hint">
              Do not include candidate names or confidential personal
              information.
            </p>
            {fieldError(state, "notes") && (
              <p className="hg-form-error">{fieldError(state, "notes")}</p>
            )}
          </div>
        </div>

        <label className="hg-scheduler-consent">
          <input type="checkbox" name="privacyAcknowledged" required /> I
          understand my details are used to reserve this time and coordinate the
          session.
        </label>
        {fieldError(state, "privacyAcknowledged") && (
          <p className="hg-form-error">
            {fieldError(state, "privacyAcknowledged")}
          </p>
        )}

        {state && !state.ok && (
          <div className="hg-scheduler-alert" role="alert">
            <RefreshCw aria-hidden="true" />
            <span>{state.message}</span>
          </div>
        )}

        <div className="hg-actions">
          <button
            type="submit"
            className="hg-primary"
            disabled={pending || !effectiveSelectedStartAt}
          >
            {pending ? "Reserving safely…" : "Reserve this time"}
          </button>
          <a className="hg-secondary" href={fallbackHref}>
            {fallbackLabel}
          </a>
        </div>

        <p className="hg-route-note">
          This reserves the Decoded Hiring booking in the site itself. External
          calendar invites and email delivery are not promised while those
          providers remain unconfigured.
        </p>
      </div>
    </form>
  );
}
