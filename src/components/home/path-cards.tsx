"use client";

import { ArrowUpRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

type PathCard = {
  label: string;
  title: string;
  body: string;
  cta: string;
  href: string;
};

export function PathCards({ cards }: { cards: PathCard[] }) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="path-cards">
      {cards.map((card, index) => (
        <motion.article
          className={`path-card path-card--${index + 1}`}
          key={card.label}
          initial={reduceMotion ? false : { opacity: 0, y: 28 }}
          whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          whileHover={reduceMotion ? undefined : { y: -8 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.5, delay: index * 0.1 }}
        >
          <p className="eyebrow">{card.label}</p>
          <h3>{card.title}</h3>
          <p>{card.body}</p>
          <a className="path-card__cta" href={card.href}>
            {card.cta}
            <ArrowUpRight size={18} aria-hidden="true" />
          </a>
        </motion.article>
      ))}
    </div>
  );
}
