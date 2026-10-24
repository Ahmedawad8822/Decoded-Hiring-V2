"use client";

import { ArrowUpRight } from "lucide-react";
import { useActionState, useState } from "react";

import { submitLead } from "./actions";
import type { LeadActionState, LeadSubmissionKind } from "./types";

type LeadFormProps = {
  kind: LeadSubmissionKind;
  sourceRoute: string;
  audiencePath?: string;
  submitLabel: string;
  className?: string;
};

function FieldError({ state, name }: { state: LeadActionState; name: string }) {
  const error = state && !state.ok ? state.fieldErrors?.[name]?.[0] : undefined;
  return error ? <p className="hg-form-error">{error}</p> : null;
}

export function LeadForm({
  kind,
  sourceRoute,
  audiencePath = "",
  submitLabel,
  className,
}: LeadFormProps) {
  const action = submitLead.bind(null, kind, sourceRoute, audiencePath);
  const [state, formAction, pending] = useActionState(action, undefined);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const isAiOs = kind === "ai_os";
  const isWorkshop = kind === "workshop";

  if (state?.ok) {
    return (
      <div className="hg-lead-success" role="status">
        <p className="hg-kicker">Request received</p>
        <h3>
          {isAiOs
            ? "You are on the research list."
            : "Your context has been saved."}
        </h3>
        <p>{state.message}</p>
      </div>
    );
  }

  return (
    <form action={formAction} className={className ?? "hg-form-grid"}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <label className="hg-honeypot" aria-hidden="true">
        Website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <div className="hg-field">
        <label htmlFor={`${kind}-name`}>Name</label>
        <input
          id={`${kind}-name`}
          name="fullName"
          autoComplete="name"
          required
        />
        <FieldError state={state} name="fullName" />
      </div>
      <div className="hg-field">
        <label htmlFor={`${kind}-email`}>Work email</label>
        <input
          id={`${kind}-email`}
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        <FieldError state={state} name="email" />
      </div>
      <div className="hg-field">
        <label htmlFor={`${kind}-position`}>Position</label>
        <input
          id={`${kind}-position`}
          name="positionTitle"
          autoComplete="organization-title"
        />
      </div>
      <div className="hg-field">
        <label htmlFor={`${kind}-company`}>Company</label>
        <input
          id={`${kind}-company`}
          name="companyName"
          autoComplete="organization"
        />
      </div>
      <div className="hg-field">
        <label htmlFor={`${kind}-country`}>Country</label>
        <select
          id={`${kind}-country`}
          name="countryCode"
          defaultValue="EG"
          autoComplete="country"
        >
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
        <label htmlFor={`${kind}-phone`}>Phone / WhatsApp (optional)</label>
        <input
          id={`${kind}-phone`}
          name="phoneE164"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+201001234567"
        />
        <FieldError state={state} name="phoneE164" />
      </div>

      {isAiOs ? (
        <>
          <div className="hg-field hg-full">
            <label htmlFor="ai-os-level">How are you using AI today?</label>
            <select id="ai-os-level" name="aiUseLevel" defaultValue="" required>
              <option value="" disabled>
                Select one
              </option>
              <option value="exploring">Exploring</option>
              <option value="using_tools">Using AI tools</option>
              <option value="building_workflows">Building workflows</option>
              <option value="building_agents">Building agents</option>
            </select>
            <FieldError state={state} name="aiUseLevel" />
          </div>
          <div className="hg-field hg-full">
            <label htmlFor="ai-os-workflow">
              Which recruitment workflow would you improve first?
            </label>
            <input
              id="ai-os-workflow"
              name="workflowToImprove"
              maxLength={160}
              required
            />
            <FieldError state={state} name="workflowToImprove" />
          </div>
        </>
      ) : (
        <>
          {isWorkshop && (
            <>
              <div className="hg-field">
                <label htmlFor="workshop-team-size">
                  Recruitment team size
                </label>
                <input
                  id="workshop-team-size"
                  name="teamSize"
                  type="number"
                  min="1"
                />
              </div>
              <div className="hg-field">
                <label htmlFor="workshop-delivery">Best starting route</label>
                <select
                  id="workshop-delivery"
                  name="deliveryPreference"
                  defaultValue={
                    audiencePath === "open_cohort"
                      ? "open_cohort"
                      : "private_team"
                  }
                >
                  <option value="private_team">Private team</option>
                  <option value="open_cohort">Open cohort</option>
                  <option value="flexible">Not sure yet</option>
                </select>
              </div>
            </>
          )}
          <div className="hg-field hg-full">
            <label htmlFor={`${kind}-problem`}>
              {kind === "coaching"
                ? "What decision feels blocked?"
                : "What is happening now?"}
            </label>
            <textarea
              id={`${kind}-problem`}
              name="problemSummary"
              minLength={20}
              maxLength={2000}
              required
            />
            <p className="hg-field-hint">
              Do not include candidate names or confidential personal
              information.
            </p>
            <FieldError state={state} name="problemSummary" />
          </div>
          <div className="hg-field hg-full">
            <label htmlFor={`${kind}-outcome`}>What should be different?</label>
            <textarea
              id={`${kind}-outcome`}
              name="desiredOutcome"
              maxLength={1200}
            />
          </div>
          <div className="hg-field hg-full">
            <label htmlFor={`${kind}-timing`}>
              When would this become useful?
            </label>
            <input
              id={`${kind}-timing`}
              name="timing"
              maxLength={120}
              placeholder="For example: this quarter"
            />
          </div>
        </>
      )}

      <fieldset className="hg-consent-box hg-full">
        <legend>How we may use your details</legend>
        <label>
          <input type="checkbox" name="privacyAcknowledged" required /> I
          understand that my details and message are used to review and reply to
          this request. Required.
        </label>
        {isAiOs && (
          <label>
            <input type="checkbox" name="researchAccepted" required /> Email me
            about AI Recruiter OS research and this programme waitlist. I can
            withdraw at any time. Required.
          </label>
        )}
        {!isAiOs && (
          <label>
            <input type="checkbox" name="emailMarketing" /> Email me useful
            hiring notes and relevant programme updates. Optional.
          </label>
        )}
        <label>
          <input type="checkbox" name="whatsapp" /> Ahmed may follow up on
          WhatsApp. Optional; add a phone number.
        </label>
        <label>
          <input type="checkbox" name="calls" /> Ahmed may follow up by phone.
          Optional; add a phone number.
        </label>
      </fieldset>

      {state && !state.ok && (
        <p className="hg-form-status hg-full" role="alert">
          {state.message} Reference: {state.requestId.slice(0, 8)}
        </p>
      )}
      <div className="hg-actions hg-full">
        <button type="submit" className="hg-primary" disabled={pending}>
          {pending ? "Sending safely…" : submitLabel}{" "}
          <ArrowUpRight aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
