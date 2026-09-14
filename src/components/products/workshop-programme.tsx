"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

const days = [
  {
    number: "DAY 01",
    title: "Diagnose and define",
    label: "5 modules · clarity before activity",
    summary:
      "Recruitment strategy, stakeholder discovery, role clarity, outcomes and evidence standards.",
    modules: [
      "System diagnosis",
      "Recruitment strategy",
      "Stakeholder discovery",
      "Role clarity",
      "Evidence standards",
    ],
    output: "A role brief and an evidence standard.",
  },
  {
    number: "DAY 02",
    title: "Map and engage",
    label: "5 modules · market to conversation",
    summary:
      "Market reality, target-company universes, attraction choices, sourcing and candidate conversation.",
    modules: [
      "Market reality",
      "Target universe",
      "Attraction architecture",
      "Active sourcing",
      "Candidate engagement",
    ],
    output: "A target universe and engagement plan.",
  },
  {
    number: "DAY 03",
    title: "Assess and recommend",
    label: "5 modules · evidence over instinct",
    summary:
      "Competency evidence, ROCKET interviews, quality checks and decisions that withstand challenge.",
    modules: [
      "Competency scorecards",
      "ROCKET interviews",
      "Evidence synthesis",
      "Quality checks",
      "Decision calibration",
    ],
    output: "A scorecard and evidence-backed recommendation.",
  },
  {
    number: "DAY 04",
    title: "Apply AI responsibly",
    label: "5 modules · accountable leverage",
    summary:
      "Workflow design, prompting, human review, operating principles and a practical 30-day plan.",
    modules: [
      "Workflow selection",
      "Prompt engineering",
      "Human review",
      "Guardrails",
      "30-day implementation",
    ],
    output: "An AI-assisted workflow and a 30-day action plan.",
  },
];

export function WorkshopProgramme() {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <div className="hg-programme-accordion">
      {days.map((day, index) => {
        const isOpen = openIndex === index;
        const panelId = `hg-workshop-day-${index + 1}`;

        return (
          <section
            className={`hg-programme-day${isOpen ? " is-open" : ""}`}
            key={day.number}
          >
            <button
              type="button"
              className="hg-programme-day-toggle"
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => setOpenIndex(isOpen ? -1 : index)}
            >
              <span className="hg-programme-day-no">{day.number}</span>
              <span className="hg-programme-day-heading">
                <strong>{day.title}</strong>
                <small>{day.label}</small>
              </span>
              <span className="hg-programme-day-summary">{day.summary}</span>
              <span className="hg-programme-day-icon">
                <Plus aria-hidden="true" />
              </span>
            </button>
            <div
              className="hg-programme-day-detail"
              id={panelId}
              aria-hidden={!isOpen}
            >
              <div className="hg-programme-day-inner">
                <div className="hg-programme-day-content">
                  <div className="hg-day-brief-modules">
                    {day.modules.map((module) => (
                      <span key={module}>{module}</span>
                    ))}
                  </div>
                  <div className="hg-programme-day-output">
                    <b>Leave with</b>
                    <span>{day.output}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
