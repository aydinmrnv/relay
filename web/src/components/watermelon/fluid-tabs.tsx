'use client';

import { useState, type ReactNode, type FC } from 'react';
import { motion } from 'motion/react';
import { BiSolidPieChartAlt2 } from 'react-icons/bi';
import { FaInbox, FaLandmark } from 'react-icons/fa';

export interface TabItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
}

interface FluidTabsProps {
  tabs?: TabItem[];
  defaultActive?: string;
  onChange?: (id: string) => void;
  /** Adapted for the studio: controlled selection, a compact size and a unique pill per instance. */
  value?: string;
  size?: 'default' | 'sm';
  layoutId?: string;
  className?: string;
  'aria-label'?: string;
}

const DEFAULT_TABS: TabItem[] = [
  { id: 'accounts', label: 'Accounts', icon: <FaLandmark size={22} /> },
  { id: 'deposits', label: 'Deposits', icon: <FaInbox size={22} /> },
  { id: 'funds', label: 'Funds', icon: <BiSolidPieChartAlt2 size={22} /> },
];

export const FluidTabs: FC<FluidTabsProps> = ({
  tabs = DEFAULT_TABS,
  defaultActive = tabs[0]?.id,
  onChange,
  value,
  size = 'default',
  layoutId = 'active-pill',
  className = '',
  'aria-label': ariaLabel,
}) => {
  const [uncontrolled, setActive] = useState<string>(defaultActive ?? '');
  const active = value ?? uncontrolled;
  const small = size === 'sm';

  const handleChange = (id: string) => {
    setActive(id);
    onChange?.(id);
  };

  return (
    <div role="tablist" aria-label={ariaLabel} className={`relative flex items-center gap-1 rounded-full border-[1.6px] border-border/60 bg-muted px-1 py-1 transition-colors ${small ? '' : 'sm:gap-2'} ${className}`}>
      {tabs.map((tab) => {
        const isActive = active === tab.id;

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => handleChange(tab.id)}
            className={`group relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${small ? 'px-3 py-1.5' : 'px-3 py-2.5 sm:px-4 sm:py-3.5'}`}
          >
            {isActive && (
              <motion.div
                layoutId={layoutId}
                transition={{
                  type: 'spring',
                  stiffness: 280,
                  damping: 25,
                  mass: 0.8,
                }}
                className="absolute inset-0 rounded-full border border-border/80 bg-gradient-to-b from-card to-card/90 shadow-xs"
              />
            )}

            <motion.div
              transition={{
                duration: 0.3,
                ease: 'easeOut',
              }}
              animate={{
                filter: isActive
                  ? ['blur(0px)', 'blur(4px)', 'blur(0px)']
                  : 'blur(0px)',
              }}
              className={`relative z-10 flex items-center gap-1.5 transition-colors duration-200 sm:gap-3 ${
                isActive
                  ? 'font-semibold text-foreground'
                  : 'font-medium text-muted-foreground group-hover:text-foreground'
              }`}
            >
              <motion.div
                animate={{ scale: isActive ? 1.03 : 1 }}
                transition={{
                  scale: { type: 'spring', stiffness: 300, damping: 15 },
                }}
                className="flex shrink-0 items-center justify-center"
              >
                {tab.icon}
              </motion.div>

              <span className={`tracking-tight whitespace-nowrap ${small ? 'text-xs' : 'text-sm sm:text-base'}`}>
                {tab.label}
              </span>
            </motion.div>
          </button>
        );
      })}
    </div>
  );
};
