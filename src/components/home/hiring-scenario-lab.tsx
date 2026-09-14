"use client";

import {
  BadgeCheck,
  Building2,
  Crosshair,
  Globe2,
  Handshake,
  Landmark,
  Megaphone,
  MonitorCheck,
  PanelTop,
  RotateCcw,
  Search,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  UserRoundSearch,
  Users,
  UsersRound,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

const scenarios = {
  simple: {
    label: "Simple hiring",
    accent: "#8ed9bd",
    priority: "Efficiency & validity",
    objective: "SELECT · Efficient selection",
    capacity: "~50 illustrative hires / recruiter FTE",
    diagnostic:
      "High talent availability · Low strategic relevance · Good talent is sufficient",
    copy: "When candidates are available, the advantage comes from processing and selecting well—not overengineering attraction.",
    nodes: [
      [Users, "Available talent"],
      [BadgeCheck, "Light, general EVP"],
      [PanelTop, "Clear job ads"],
      [MonitorCheck, "Efficient ATS"],
      [ShieldCheck, "Valid selection"],
    ],
  },
  mass: {
    label: "Difficult mass hiring",
    accent: "#47c994",
    priority: "Scale & effectiveness",
    objective: "ATTRACT · Scalable attraction",
    capacity: "~20 illustrative hires / recruiter FTE",
    diagnostic:
      "Low talent availability · High recurring demand · Scale is the constraint",
    copy: "Scarcity plus volume changes the economics. The winning approaches are the ones that compound across many hires.",
    nodes: [
      [UserRoundSearch, "Scarce talent"],
      [Megaphone, "Strong general EVP"],
      [UsersRound, "Talent communities"],
      [Handshake, "Referrals + line support"],
      [Building2, "Scalable attraction"],
    ],
  },
  specialist: {
    label: "Specialist hiring",
    accent: "#efa06a",
    priority: "Effectiveness",
    objective: "ACCESS · Focused access",
    capacity: "~10 illustrative hires / recruiter FTE",
    diagnostic: "Low talent availability · Low demand · One difficult role",
    copy: "The role must be sold and the market approached directly. Waiting for applications is unlikely to create the supply you need.",
    nodes: [
      [UserRoundSearch, "One difficult role"],
      [BadgeCheck, "Role-specific EVP"],
      [Search, "Active sourcing"],
      [Handshake, "Pushed referrals"],
      [Crosshair, "Focused access"],
    ],
  },
  strategic: {
    label: "Strategic hiring",
    accent: "#ae9af4",
    priority: "Excellence",
    objective: "SEARCH · Search excellence",
    capacity: "~5 illustrative hires / recruiter FTE",
    diagnostic:
      "Low talent availability · High strategic relevance · The best possible person",
    copy: "When one hire can materially change the business, search quality outranks process efficiency and recruiting cost.",
    nodes: [
      [Landmark, "Strategic need"],
      [Globe2, "Global reach"],
      [SearchCheck, "Executive search"],
      [UsersRound, "Leadership involvement"],
      [Sparkles, "Decisive hire"],
    ],
  },
} as const;

type ScenarioKey = keyof typeof scenarios;

export function HiringScenarioLab() {
  const reduceMotion = useReducedMotion();
  const [scenarioKey, setScenarioKey] = useState<ScenarioKey>("simple");
  const [activeNode, setActiveNode] = useState(0);
  const [run, setRun] = useState(0);
  const scenario = scenarios[scenarioKey];

  useEffect(() => {
    if (reduceMotion) return;

    const timers = scenario.nodes
      .slice(1)
      .map((_, index) =>
        window.setTimeout(() => setActiveNode(index + 1), (index + 1) * 620),
      );
    return () => timers.forEach(window.clearTimeout);
  }, [reduceMotion, run, scenario.nodes]);

  function selectScenario(key: ScenarioKey) {
    setScenarioKey(key);
    setActiveNode(0);
    setRun((value) => value + 1);
  }

  function replay() {
    setActiveNode(0);
    setRun((value) => value + 1);
  }

  return (
    <section
      className="hg-section hg-lab"
      style={{ "--hg-lab-accent": scenario.accent } as React.CSSProperties}
    >
      <div className="hg-lab-layout">
        <div className="hg-lab-copy">
          <p className="hg-kicker">Hiring strategy laboratory</p>
          <h2 className="hg-title">
            Different hiring problems demand different systems.
          </h2>
          <div
            className="hg-lab-controls"
            role="group"
            aria-label="Hiring scenario"
          >
            {(Object.keys(scenarios) as ScenarioKey[]).map((key) => (
              <button
                className="hg-lab-toggle"
                type="button"
                aria-pressed={key === scenarioKey}
                onClick={() => selectScenario(key)}
                key={key}
              >
                {scenarios[key].label}
              </button>
            ))}
          </div>
          <p className="hg-lab-priority">{scenario.priority}</p>
          <p className="hg-body">{scenario.copy}</p>
        </div>

        <div className="hg-lab-map" aria-live="polite">
          <div className="hg-lab-map-head">
            <span>{scenario.objective}</span>
            <small>{scenario.capacity}</small>
          </div>
          <div className="hg-signal-flow">
            {scenario.nodes.map(([Icon, label], index) => (
              <div
                className={`hg-signal-node ${
                  index === activeNode
                    ? "is-live"
                    : index < activeNode
                      ? "is-passed"
                      : ""
                }`}
                key={label}
              >
                <span className="hg-signal-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <Icon aria-hidden="true" />
                <strong>{label}</strong>
              </div>
            ))}
          </div>
          <div className="hg-lab-map-foot">
            <span>{scenario.diagnostic}</span>
            <button className="hg-lab-replay" type="button" onClick={replay}>
              <RotateCcw aria-hidden="true" /> Replay stages
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
