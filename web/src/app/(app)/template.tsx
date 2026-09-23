'use client';

import { motion, useReducedMotionConfig } from 'motion/react';

/** A short fade between screens. Next remounts a template on every navigation, which is what makes this run. */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotionConfig();
  return (
    <motion.div
      className="flex min-h-0 flex-1 flex-col"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}
