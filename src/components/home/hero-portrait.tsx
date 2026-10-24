"use client";

import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";

type HeroPortraitProps = {
  alt: string;
  signal: string;
};

export function HeroPortrait({ alt, signal }: HeroPortraitProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className="hero-portrait"
      initial={reduceMotion ? false : { opacity: 0, y: 24 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <motion.span
        className="hero-orbit hero-orbit--blue"
        aria-hidden="true"
        animate={reduceMotion ? undefined : { rotate: 360 }}
        transition={{ duration: 28, ease: "linear", repeat: Infinity }}
      />
      <motion.span
        className="hero-orbit hero-orbit--coral"
        aria-hidden="true"
        animate={reduceMotion ? undefined : { rotate: -360 }}
        transition={{ duration: 36, ease: "linear", repeat: Infinity }}
      />
      <div className="hero-portrait__frame">
        <Image
          src="/images/ahmed-awad-studio-source.webp"
          alt={alt}
          fill
          priority
          sizes="(max-width: 860px) 88vw, 42vw"
          className="hero-portrait__image"
        />
      </div>
      <motion.p
        className="hero-signal"
        animate={reduceMotion ? undefined : { y: [0, -6, 0] }}
        transition={{ duration: 4, ease: "easeInOut", repeat: Infinity }}
      >
        {signal}
      </motion.p>
    </motion.div>
  );
}
