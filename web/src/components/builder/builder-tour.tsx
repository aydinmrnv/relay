'use client';

import { AnimatePresence, motion } from 'motion/react';
import { Blocks, FileCode2, MousePointerClick, Play, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { FeatureTour, type TourStep } from '@/components/watermelon/feature-tour';
import { useBrand } from '@/hooks/use-brand';

/** The first-visit tour of the builder, from Watermelon UI's feature tour. Replayable from the help menu. */
export function BuilderTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const brand = useBrand();
  const steps: TourStep[] = [
    {
      id: 'canvas',
      title: 'A workflow is a diagram',
      description: 'Read it left to right: a trigger starts it, gates check it, the agent pipeline writes the code, and delivery decides where the result goes. Drag nodes to arrange them; drag from a dot on the right of a node to connect it.',
      icon: <MousePointerClick className="size-10" strokeWidth={1.6} />,
    },
    {
      id: 'palette',
      title: 'Add nodes from the left',
      description: 'Building blocks first — triggers, guardrails, the pipeline, delivery — then every app. Drag one onto the canvas, click it, or press A to search. Drop a connection on empty canvas and you get only the nodes that fit.',
      icon: <Blocks className="size-10" strokeWidth={1.6} />,
    },
    {
      id: 'inspector',
      title: 'Settings on the right',
      description: 'Select a node to configure it; “How it works” explains what it will do with those settings. With nothing selected, the panel reads the whole workflow back to you in plain English.',
      icon: <SlidersHorizontal className="size-10" strokeWidth={1.6} />,
    },
    {
      id: 'checks',
      title: 'Checks as you go',
      description: `The badge in the toolbar runs the same rules the ${brand.name} CLI enforces: unattended runs never merge, reviewers must be read-only, and missing budgets or allowlists are called out.`,
      icon: <ShieldCheck className="size-10" strokeWidth={1.6} />,
    },
    {
      id: 'run',
      title: 'Test run for free',
      description: 'Plays the workflow with a sample ticket — phases, review rounds, costs, refusals — right on the canvas. Nothing is called and nothing is billed. Use the arrow next to it to run with your own payload.',
      icon: <Play className="size-10" strokeWidth={1.6} />,
    },
    {
      id: 'export',
      title: 'Export when it’s right',
      description: 'Export compiles the diagram into the config the CLI reads and a GitHub Actions workflow, so it runs on your repository with your own subscriptions.',
      icon: <FileCode2 className="size-10" strokeWidth={1.6} />,
    },
  ];

  return (
    <AnimatePresence>
      {open ? (
        <motion.div key="tour" className="fixed inset-0 z-50 flex items-center justify-center bg-background/40 p-4 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="w-full max-w-[400px]">
            <FeatureTour steps={steps} onClose={onClose} closeOnBackdrop />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
