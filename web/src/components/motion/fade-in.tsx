'use client';

import { motion, useReducedMotionConfig, type HTMLMotionProps, type Variants } from 'motion/react';

/**
 * The studio's two entrance animations, built on motion.dev. Kept small and
 * shared so every screen moves the same way: content rises a few pixels and
 * fades in, and lists arrive one item after another. Both respect the user's
 * reduced-motion setting by skipping the movement entirely.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

export function FadeIn({ delay = 0, y = 8, children, ...props }: HTMLMotionProps<'div'> & { delay?: number; y?: number }) {
  const reduce = useReducedMotionConfig();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE, delay }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.04 } },
};

const item: Variants = {
  hidden: { opacity: 0, y: 10, scale: 0.985 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.35, ease: EASE } },
};

export function Stagger({ children, ...props }: HTMLMotionProps<'div'>) {
  const reduce = useReducedMotionConfig();
  return (
    <motion.div variants={container} initial={reduce ? false : 'hidden'} animate="show" {...props}>
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, ...props }: HTMLMotionProps<'div'>) {
  return (
    <motion.div variants={item} {...props}>
      {children}
    </motion.div>
  );
}
