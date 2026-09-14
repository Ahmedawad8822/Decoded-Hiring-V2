"use client";

import {
  ChartNoAxesColumnIncreasing,
  Crosshair,
  SlidersHorizontal,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

type ProcessStep = {
  title: string;
  body: string;
};

type StrategyProcessProps = {
  steps: ProcessStep[];
};

const icons = [
  Crosshair,
  ChartNoAxesColumnIncreasing,
  SlidersHorizontal,
  UsersRound,
  TrendingUp,
];

export function StrategyProcess({ steps }: StrategyProcessProps) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="process" aria-label="Hiring strategy process">
      <motion.div
        className="process__line"
        aria-hidden="true"
        initial={reduceMotion ? false : { scaleX: 0 }}
        whileInView={reduceMotion ? undefined : { scaleX: 1 }}
        viewport={{ once: true, amount: 0.7 }}
        transition={{ duration: 1.1, ease: [0.2, 0.8, 0.2, 1] }}
      />
      {steps.map((step, index) => {
        const Icon = icons[index];

        return (
          <motion.article
            className="process__step"
            key={step.title}
            initial={reduceMotion ? false : { opacity: 0, y: 20 }}
            whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ duration: 0.45, delay: index * 0.12 }}
          >
            <motion.span
              className="process__icon"
              whileHover={reduceMotion ? undefined : { scale: 1.08, rotate: 4 }}
            >
              <Icon size={23} strokeWidth={1.6} aria-hidden="true" />
            </motion.span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </motion.article>
        );
      })}
    </div>
  );
}
