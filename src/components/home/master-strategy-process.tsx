"use client";

import {
  ChartNoAxesCombined,
  RotateCcw,
  Route,
  ScanSearch,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

const stages = [
  {
    title: "Define",
    body: "Role, impact and success.",
    outcome: "Role clarity established.",
    detail:
      "The process begins by agreeing on the role, its impact and what success must look like.",
    icon: ScanSearch,
  },
  {
    title: "Analyze",
    body: "Market, talent and demand.",
    outcome: "Market reality understood.",
    detail:
      "Talent availability, hiring demand and context reveal what is realistically possible.",
    icon: ChartNoAxesCombined,
  },
  {
    title: "Choose",
    body: "The right attraction approach.",
    outcome: "The right approach selected.",
    detail:
      "The attraction method now follows the hiring problem instead of habit or a favourite tool.",
    icon: Route,
  },
  {
    title: "Align & execute",
    body: "Culture, process and capability.",
    outcome: "The system aligned and moving.",
    detail:
      "People, culture, process and capability work together instead of competing for attention.",
    icon: UsersRound,
  },
  {
    title: "Improve",
    body: "Measure what changes decisions.",
    outcome: "Evidence becomes improvement.",
    detail:
      "Useful measures close the loop, expose friction and make the next hiring cycle stronger.",
    icon: TrendingUp,
  },
] as const;

export function MasterStrategyProcess() {
  const reduceMotion = useReducedMotion();
  const [activeStage, setActiveStage] = useState(0);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (reduceMotion) return;

    const timers = stages
      .slice(1)
      .map((_, index) =>
        window.setTimeout(() => setActiveStage(index + 1), (index + 1) * 850),
      );

    return () => timers.forEach(window.clearTimeout);
  }, [reduceMotion, run]);

  function replay() {
    setActiveStage(0);
    setRun((value) => value + 1);
  }

  const active = stages[activeStage];

  return (
    <section className="hg-section hg-process" id="strategy">
      <div className="hg-process-head">
        <div>
          <p className="hg-kicker">The first principle</p>
          <h2 className="hg-title">
            Strategy is a process, not a list of tools.
          </h2>
        </div>
        <div className="hg-process-side">
          <p className="hg-body">
            Great hiring does not happen by chance. It follows a visible system
            that learns.
          </p>
          <button className="hg-process-replay" type="button" onClick={replay}>
            <RotateCcw aria-hidden="true" /> Replay the hiring system
          </button>
        </div>
      </div>

      <div
        className="hg-process-track"
        aria-label="Five stage talent acquisition strategy"
        style={
          {
            "--hg-process-line-x": `${activeStage * 20}%`,
            "--hg-process-dot-x": `${10 + activeStage * 20}%`,
            "--hg-process-line-y": `${activeStage * 25}%`,
            "--hg-process-dot-y": `${25 + activeStage * 25}%`,
          } as React.CSSProperties
        }
      >
        <span className="hg-process-signal-line" aria-hidden="true" />
        <span className="hg-process-signal-dot" aria-hidden="true" />
        {stages.map((stage, index) => {
          const Icon = stage.icon;
          const stateClass =
            index === activeStage
              ? "is-active"
              : index < activeStage
                ? "is-complete"
                : "";

          return (
            <button
              className={`hg-process-step ${stateClass}`}
              type="button"
              onClick={() => setActiveStage(index)}
              key={stage.title}
              aria-current={index === activeStage ? "step" : undefined}
            >
              <span className="hg-process-node">
                <Icon aria-hidden="true" />
              </span>
              <strong>{stage.title}</strong>
              <p>{stage.body}</p>
            </button>
          );
        })}
      </div>

      <div className="hg-process-live" aria-live="polite">
        <span>{String(activeStage + 1).padStart(2, "0")}</span>
        <strong>{active.outcome}</strong>
        <small>{active.detail}</small>
      </div>
    </section>
  );
}
