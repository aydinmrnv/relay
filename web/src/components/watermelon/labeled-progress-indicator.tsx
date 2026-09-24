'use client';

import { motion, AnimatePresence } from 'motion/react';

import { useState, useEffect, type FC } from 'react';

export interface LabeledProgressIndicatorProps {
  labels: string[];
  progress?: string;
  intervalMs?: number;
  showThemeToggle?: boolean;
  /**
   * Adapted for the studio: when set, the label follows this value instead of
   * cycling on a timer, so the indicator can report real progress.
   */
  label?: string;
  size?: 'default' | 'sm';
  className?: string;
}

export const LabeledProgressIndicator: FC<LabeledProgressIndicatorProps> = ({
  labels,
  progress = '55%',
  intervalMs = 2000,
  label,
  size = 'default',
  className = '',
}) => {
  const [labelIndex, setLabelIndex] = useState(0);
  const small = size === 'sm';

  useEffect(() => {
    if (label !== undefined) return;
    const interval = setInterval(() => {
      setLabelIndex((prev) => (prev + 1) % labels.length);
    }, intervalMs);

    return () => clearInterval(interval);
  }, [labels.length, intervalMs, label]);

  const shown = label ?? labels[labelIndex];

  return (
    <div className={`flex flex-col items-center ${small ? 'gap-2.5' : 'gap-5'} ${className}`}>
      <div className="relative flex w-full items-center justify-center perspective-[800px] transform-3d">
        <AnimatePresence mode="popLayout">
          <motion.span
            key={label ?? labelIndex}
            initial={{
              opacity: 0,
              y: 10,
              scale: 2,
              filter: 'blur(4px)',
              rotateX: -60,
            }}
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
              filter: 'blur(0px)',
              rotateX: 0,
            }}
            exit={{
              opacity: 0,
              filter: 'blur(4px)',
              rotateX: 90,
              scale: 0.9,
            }}
            transition={{
              type: 'spring',
              stiffness: 600,
              damping: 100,
              mass: 10,
            }}
            className={`flex w-full origin-bottom items-center justify-center font-bold text-muted-foreground will-change-transform transform-3d ${small ? 'text-lg' : 'text-3xl'}`}
          >
            {shown}
          </motion.span>
        </AnimatePresence>
      </div>

      <div className={`overflow-hidden rounded-full border border-black/5 bg-muted shadow-inner dark:border-white/5 ${small ? 'h-2.5 w-full max-w-[320px]' : 'h-4 w-[320px]'}`}>
        <motion.div
          initial={{ width: '0%' }}
          animate={{ width: progress }}
          transition={{ duration: 1, ease: 'easeOut' }}
          className="relative h-full overflow-hidden rounded-full bg-primary"
        >
          <motion.div
            initial={{ x: '-100%' }}
            animate={{ x: '200%' }}
            transition={{
              duration: intervalMs / 1000,
              repeat: Infinity,
              ease: 'linear',
            }}
            className="absolute inset-y-0 w-full bg-linear-to-r from-transparent via-white/50 to-transparent"
          />
        </motion.div>
      </div>
    </div>
  );
};
