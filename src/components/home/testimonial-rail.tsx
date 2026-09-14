"use client";

import { ArrowLeft, ArrowRight, Pause, Play } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

const testimonials = [
  {
    name: "Mohamed Youssef",
    role: "Sales & Training Leader",
    relation: "Worked with Ahmed across corporate training programmes",
    year: "2026",
    quote:
      "Ahmed brings a rare blend of deep subject-matter expertise, practical industry insight and an interactive facilitation style that keeps participants invested from start to finish.",
  },
  {
    name: "Seral Sofi",
    role: "Founder & CEO · Executive Search & Talent Advisory",
    relation: "Managed Ahmed directly",
    year: "2026",
    quote:
      "A consummate executive-search professional. His analytical comprehension of searches yields bull’s-eye talent matches, while his thirst for learning keeps new methods moving through the team.",
  },
  {
    name: "Mohamed Youssef",
    role: "Sales & Training Leader",
    relation: "Worked with Ahmed across multiple projects",
    year: "2026",
    quote: "His preparation, tools and delivery style are genuinely different.",
  },
  {
    name: "Nahla Hany",
    role: "Talent Advisor · Strategic Partner",
    relation: "Worked with Ahmed on the same team",
    year: "2026",
    quote:
      "Ahmed combines professionalism, dedication and technology-recruitment expertise with a consultative approach that earns stakeholder trust and creates a positive candidate experience.",
  },
  {
    name: "Ahmed Awni",
    role: "Head of Practice · Staffing & Recruitment",
    relation: "Worked with Ahmed on the same team",
    year: "2026",
    quote:
      "Beyond top-tier consultative skills, Ahmed is proactive, highly supportive and brings great energy and professionalism. Any executive-search or talent-acquisition team would be fortunate to have him.",
  },
  {
    name: "Mohye Al Baba",
    role: "VP of Consulting · Recruitment Advisor",
    relation: "Worked with Ahmed on the same team",
    year: "2026",
    quote:
      "He understands client needs, manages senior-level searches and identifies high-calibre talent with ownership. His collaborative mindset, reliability and willingness to go the extra mile stand out.",
  },
  {
    name: "Ayat Khalaf",
    role: "Technical Recruiter · HR Specialist",
    relation: "Worked with Ahmed on the same team",
    year: "2016",
    quote:
      "His ability to handle any project was impressive. He is talented, hardworking, collaborative and a reliable team player with great communication skills.",
  },
  {
    name: "Ahmed Ali Saad",
    role: "International Recruiter",
    relation: "Worked with Ahmed on different teams",
    year: "2016",
    quote:
      "Ahmed welcomed complex challenges and took the initiative to engage in wider business processes. Hard work and real insight combine to make him an outstanding professional.",
  },
  {
    name: "Mohamed El Baz",
    role: "Managing Director · Founder of Arab Recruiters",
    relation: "Managed Ahmed directly",
    year: "2016",
    quote:
      "Ahmed is a fast learner and a highly professional recruiter. He takes great responsibility for his work and consistently cooperates with his team.",
  },
  {
    name: "Yousra Yousry",
    role: "Talent Acquisition · Headhunter · HR Generalist",
    relation: "Worked with Ahmed on the same team",
    year: "2016",
    quote:
      "He understands how recruitment operates, delivers beyond what is asked and is organized, competent and always ready with new ideas to move things forward.",
  },
] as const;

const accents = ["#315fe8", "#168566", "#c85848", "#795fc2"];

export function TestimonialRail() {
  const reduceMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || reduceMotion) return;

    const timer = window.setTimeout(
      () => setActiveIndex((index) => (index + 1) % testimonials.length),
      7000,
    );
    return () => window.clearTimeout(timer);
  }, [activeIndex, paused, reduceMotion]);

  function move(direction: -1 | 1) {
    setActiveIndex(
      (index) =>
        (index + direction + testimonials.length) % testimonials.length,
    );
  }

  return (
    <section
      className={`hg-section hg-testimonial ${paused ? "is-paused" : ""}`}
      style={
        {
          "--hg-testimonial-accent": accents[activeIndex % accents.length],
        } as React.CSSProperties
      }
    >
      <div className="hg-testimonial-shell">
        <div className="hg-testimonial-head">
          <p className="hg-kicker">
            Evidence from people who worked with Ahmed
          </p>
          <span className="hg-testimonial-count">
            {String(activeIndex + 1).padStart(2, "0")} / {testimonials.length}
          </span>
        </div>
        <div className="hg-testimonial-stage" aria-live="polite">
          {testimonials.map((testimonial, index) => {
            const position =
              index === activeIndex
                ? "is-active"
                : index < activeIndex
                  ? "is-before"
                  : "is-after";
            const initials = testimonial.name
              .split(" ")
              .map((part) => part[0])
              .join("")
              .slice(0, 2);

            return (
              <article
                className={`hg-testimonial-slide ${position}`}
                aria-hidden={index !== activeIndex}
                key={`${testimonial.name}-${index}`}
              >
                <div className="hg-testimonial-proof">
                  <span>LinkedIn recommendation</span>
                  <span>{testimonial.year}</span>
                </div>
                <blockquote className="hg-testimonial-quote">
                  “{testimonial.quote}”
                </blockquote>
                <div className="hg-testimonial-person">
                  <span className="hg-testimonial-avatar" aria-hidden="true">
                    {initials}
                  </span>
                  <span>
                    <strong>{testimonial.name}</strong>
                    <small>{testimonial.role}</small>
                  </span>
                  <span className="hg-testimonial-source">
                    {testimonial.relation}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
        <div className="hg-testimonial-controls">
          <div className="hg-testimonial-arrows">
            <button
              className="hg-testimonial-control"
              type="button"
              onClick={() => move(-1)}
              aria-label="Previous recommendation"
            >
              <ArrowLeft aria-hidden="true" />
            </button>
            <button
              className="hg-testimonial-control"
              type="button"
              onClick={() => move(1)}
              aria-label="Next recommendation"
            >
              <ArrowRight aria-hidden="true" />
            </button>
          </div>
          <div
            className="hg-testimonial-dots"
            aria-label="Choose a recommendation"
          >
            {testimonials.map((testimonial, index) => (
              <button
                className="hg-testimonial-dot"
                type="button"
                onClick={() => setActiveIndex(index)}
                aria-current={index === activeIndex}
                aria-label={`Recommendation ${index + 1} from ${testimonial.name}`}
                key={`${testimonial.name}-dot-${index}`}
              >
                {String(index + 1).padStart(2, "0")}
              </button>
            ))}
          </div>
          <button
            className="hg-testimonial-pause"
            type="button"
            onClick={() => setPaused((value) => !value)}
            aria-pressed={paused}
          >
            {paused ? (
              <Play aria-hidden="true" />
            ) : (
              <Pause aria-hidden="true" />
            )}
            <span>{paused ? "Play" : "Pause"}</span>
          </button>
        </div>
        <div
          className={`hg-testimonial-timer ${!paused && !reduceMotion ? "is-running" : ""}`}
          key={`${activeIndex}-${paused}`}
          aria-hidden="true"
        >
          <span />
        </div>
      </div>
    </section>
  );
}
