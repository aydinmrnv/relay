'use client';

import { motion, type HTMLMotionProps } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Fades a block in the first time it scrolls into view. Opacity and transform
 * only, so the layout never moves and in-page anchors land where they should.
 * With reduced motion it renders in place from the start.
 */
export function Reveal({ children, delay = 0, ...props }: HTMLMotionProps<'div'> & { delay?: number }) {
  const reduce = useCalmMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ duration: 0.45, ease: EASE, delay }}
      {...props}
    >
      {children}
    </motion.div>
  );
}
