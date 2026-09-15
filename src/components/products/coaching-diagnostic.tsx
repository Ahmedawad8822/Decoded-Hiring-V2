"use client";

import { ArrowUpRight } from "lucide-react";
import { useState } from "react";

const cases = [
  {
    label: "Pipeline & market",
    summary: "Activity is high. Confidence is low.",
    title: "The pipeline is moving, but it is not producing confidence.",
    signal: "Candidates arrive, yet shortlists remain weak or inconsistent.",
    root: "The target universe, role evidence or attraction channel may be wrong.",
    focus:
      "Separate market reality from process activity, then decide where to intervene.",
    output:
      "A targeted experiment with an owner, metric and next review point.",
  },
  {
    label: "Role & brief",
    summary: "The search keeps changing shape.",
    title:
      "The search keeps changing because the decision was never made upstream.",
    signal:
      "Stakeholders revise the brief, profile or expectations after the search begins.",
    root: "Success, evidence and decision ownership may not be aligned.",
    focus:
      "Make the real trade-offs visible and rebuild the role around outcomes.",
    output:
      "A clearer role decision, evidence standard and stakeholder conversation.",
  },
  {
    label: "Interview & evidence",
    summary: "Opinions are outrunning proof.",
    title:
      "The interview process is busy, but the decision remains subjective.",
    signal:
      "Feedback is vague, contradictory or dominated by the loudest opinion.",
    root: "The team may be discussing impressions without a shared evidence standard.",
    focus:
      "Translate the hiring decision into observable evidence and calibrated questions.",
    output: "A practical scorecard and a stronger decision conversation.",
  },
  {
    label: "Team & workflow",
    summary: "The process works only through heroics.",
    title: "The process works—but only because someone keeps rescuing it.",
    signal:
      "Hand-offs fail, follow-ups disappear and important context lives in one person.",
    root: "Ownership, workflow visibility or operating rules may be missing.",
    focus:
      "Map the failure points and decide what to standardise, automate or stop.",
    output:
      "A cleaner workflow with ownership, boundaries and a first implementation move.",
  },
];

export function CoachingDiagnostic() {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = cases[activeIndex];

  return (
    <div className="hg-coaching-diagnostic-layout">
      <div
        className="hg-coaching-cases"
        aria-label="Choose a recruitment challenge"
      >
        {cases.map((item, index) => {
          const isActive = index === activeIndex;
          return (
            <button
              key={item.label}
              type="button"
              className={`hg-coaching-case${isActive ? " is-active" : ""}`}
              aria-pressed={isActive}
              onClick={() => setActiveIndex(index)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{item.label}</strong>
              <small>{item.summary}</small>
              <ArrowUpRight aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <article className="hg-decision-board" aria-live="polite">
        <div className="hg-decision-board-top">
          <span>Decision board</span>
          <b>CASE {String(activeIndex + 1).padStart(2, "0")} / 04</b>
        </div>
        <h3 key={`title-${activeIndex}`}>{active.title}</h3>
        <div className="hg-decision-board-grid" key={`grid-${activeIndex}`}>
          <div>
            <span>Visible signal</span>
            <p>{active.signal}</p>
          </div>
          <div>
            <span>Likely upstream issue</span>
            <p>{active.root}</p>
          </div>
          <div>
            <span>What we resolve</span>
            <p>{active.focus}</p>
          </div>
          <div className="hg-decision-output">
            <span>You leave with</span>
            <p>{active.output}</p>
          </div>
        </div>
      </article>
    </div>
  );
}
