'use client';
import React, { useMemo } from 'react';
import { motion, useReducedMotionConfig } from 'motion/react';
import { cn } from '@/lib/utils';

export type TextShimmerProps = {
  children: string;
  as?: keyof typeof MOTION_TAGS;
  className?: string;
  duration?: number;
  spread?: number;
};

// Adapted from the 21st.dev original, which called motion.create() on every
// render: that remounts the element each time and React Compiler rejects it.
const MOTION_TAGS = { p: motion.p, span: motion.span, div: motion.div, h1: motion.h1, h2: motion.h2, h3: motion.h3 };

function TextShimmerComponent({
  children,
  as: Component = 'p',
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) {
  const MotionComponent = MOTION_TAGS[Component];
  const still = useReducedMotionConfig();

  const dynamicSpread = useMemo(() => {
    return children.length * spread;
  }, [children, spread]);

  // With reduced motion the words stay, in the colour the shimmer rests on.
  if (still) return <Component className={cn('relative inline-block text-muted-foreground', className)}>{children}</Component>;

  return (
    <MotionComponent
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text',
        // The theme's own colours, so the shimmer follows light and dark without a second set.
        'text-transparent [--base-color:var(--muted-foreground)] [--base-gradient-color:var(--foreground)]',
        '[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]',
        className
      )}
      initial={{ backgroundPosition: '100% center' }}
      animate={{ backgroundPosition: '0% center' }}
      transition={{
        repeat: Infinity,
        duration,
        ease: 'linear',
      }}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundImage: `var(--bg), linear-gradient(var(--base-color), var(--base-color))`,
        } as React.CSSProperties
      }
    >
      {children}
    </MotionComponent>
  );
}

export const TextShimmer = React.memo(TextShimmerComponent);
