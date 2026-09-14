"use client";

import {
  ClipboardCheck,
  Plus,
  Route,
  ScanSearch,
  Sparkles,
} from "lucide-react";
import { useState } from "react";

const days = [
  {
    fold: "Diagnose",
    meta: "5 modules · clarity first",
    title: "Diagnose & define",
    body: "Turn the vacancy request into a shared role definition, hiring strategy and evidence standard.",
    topics: ["Stakeholder discovery", "Role clarity", "Strategy"],
    icon: ScanSearch,
  },
  {
    fold: "Map",
    meta: "5 modules · market reality",
    title: "Map & engage",
    body: "Build a realistic target universe, choose the right attraction approach and start stronger candidate conversations.",
    topics: ["Talent mapping", "Sourcing universe", "Engagement"],
    icon: Route,
  },
  {
    fold: "Assess",
    meta: "5 modules · evidence over instinct",
    title: "Assess & recommend",
    body: "Replace interview opinion with structured evidence and recommendations that can withstand challenge.",
    topics: ["ROCKET interviews", "Scorecards", "Quality decisions"],
    icon: ClipboardCheck,
  },
  {
    fold: "Apply AI",
    meta: "5 modules · accountable leverage",
    title: "Apply AI responsibly",
    body: "Design useful AI-assisted workflows with human review, clear guardrails and a practical 30-day implementation plan.",
    topics: ["Workflow design", "Prompting", "Guardrails"],
    icon: Sparkles,
  },
] as const;

export function WorkshopDays() {
  const [openDay, setOpenDay] = useState(0);

  return (
    <div className="hg-product-visual hg-days" aria-label="Four workshop days">
      {days.map((day, index) => {
        const Icon = day.icon;
        const isOpen = openDay === index;
        return (
          <section
            className={`hg-day ${isOpen ? "is-open" : ""}`}
            data-day={index + 1}
            key={day.fold}
          >
            <button
              className="hg-day-toggle"
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpenDay(index)}
            >
              <span className="hg-day-no">
                DAY {String(index + 1).padStart(2, "0")}
              </span>
              <span className="hg-day-fold-title">{day.fold}</span>
              <Plus aria-hidden="true" />
            </button>
            <div className="hg-day-detail" aria-hidden={!isOpen}>
              <div className="hg-day-art">
                <Icon aria-hidden="true" />
              </div>
              <small>{day.meta}</small>
              <strong>{day.title}</strong>
              <p>{day.body}</p>
              <div className="hg-day-topics">
                {day.topics.map((topic) => (
                  <span key={topic}>{topic}</span>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
