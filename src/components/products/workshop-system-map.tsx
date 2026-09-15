"use client";

import type { CSSProperties } from "react";
import {
  BadgeCheck,
  CheckCircle2,
  ClipboardCheck,
  Crosshair,
  Map,
  MessagesSquare,
  ScanSearch,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

type Stage = {
  title: string;
  copy: string;
  x: string;
  y: string;
  icon: LucideIcon;
};

const stages: Stage[] = [
  {
    title: "Diagnose",
    copy: "Expose the business problem, constraint and consequence behind the hiring request.",
    x: "8%",
    y: "71%",
    icon: ScanSearch,
  },
  {
    title: "Define",
    copy: "Translate the need into outcomes, evidence and a usable success profile.",
    x: "17%",
    y: "25%",
    icon: Crosshair,
  },
  {
    title: "Map",
    copy: "Build a realistic talent universe from market evidence—not assumptions.",
    x: "34%",
    y: "13%",
    icon: Map,
  },
  {
    title: "Engage",
    copy: "Choose attraction and conversation routes that match the hiring situation.",
    x: "50%",
    y: "24%",
    icon: MessagesSquare,
  },
  {
    title: "Assess",
    copy: "Collect comparable evidence with scorecards and structured interviews.",
    x: "68%",
    y: "14%",
    icon: ClipboardCheck,
  },
  {
    title: "Recommend",
    copy: "Turn evidence into a judgment leaders can challenge, understand and trust.",
    x: "85%",
    y: "30%",
    icon: BadgeCheck,
  },
  {
    title: "Close",
    copy: "Align decision, offer and feedback so the loop strengthens the next hire.",
    x: "90%",
    y: "73%",
    icon: CheckCircle2,
  },
];

export function WorkshopSystemMap() {
  const [activeIndex, setActiveIndex] = useState(3);
  const active = stages[activeIndex];

  return (
    <div
      className="hg-system-map"
      aria-label="Interactive seven-stage evidence-to-recommendation system"
    >
      <svg
        className="hg-system-path"
        viewBox="0 0 1000 520"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M80 370 C105 230 110 165 170 130 S285 55 340 65 S445 118 500 125 S620 62 680 70 S790 112 850 160 S900 290 900 380" />
        <path d="M82 384 C210 485 350 450 500 470 S770 500 900 392" />
      </svg>

      {stages.map((stage, index) => {
        const Icon = stage.icon;
        const isActive = index === activeIndex;
        const style = { "--x": stage.x, "--y": stage.y } as CSSProperties;

        return (
          <button
            key={stage.title}
            type="button"
            className={`hg-system-node${isActive ? " is-active" : ""}`}
            style={style}
            aria-pressed={isActive}
            onClick={() => setActiveIndex(index)}
          >
            <span className="hg-system-bubble">
              <b>{String(index + 1).padStart(2, "0")}</b>
              <Icon aria-hidden="true" />
            </span>
            <strong>{stage.title}</strong>
          </button>
        );
      })}

      <div className="hg-system-core" aria-live="polite">
        <span>
          {String(activeIndex + 1).padStart(2, "0")} / 07 · Build the system
        </span>
        <strong>{active.title}</strong>
        <p>{active.copy}</p>
        <div className="hg-system-meter" aria-hidden="true">
          <span
            style={
              {
                "--progress": `${((activeIndex + 1) / stages.length) * 100}%`,
              } as CSSProperties
            }
          />
        </div>
      </div>
    </div>
  );
}
