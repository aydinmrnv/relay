'use client';

import { motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { getConnector } from '@/lib/connectors';

const STEPS: Array<{ connectorId: string; title: string; caption: string; accent?: boolean }> = [
  { connectorId: 'linear', title: 'Issue assigned', caption: 'ENG-142 → @bot' },
  { connectorId: 'gates', title: 'Budget gate', caption: '$6 / run · $40 / day' },
  { connectorId: 'pipeline', title: 'Plan → review → implement → review → test', caption: 'Claude plans, Codex implements, each reviews the other', accent: true },
  { connectorId: 'delivery', title: 'Draft pull request', caption: 'never merges unattended' },
  { connectorId: 'slack', title: 'Tell #eng-agents', caption: '{{run.prUrl}} · {{run.cost}}' },
];

/** A static, animated rendition of the canonical flow, for the landing page. */
export function PipelinePreview() {
  return (
    <Card className="overflow-hidden border-dashed bg-muted/30 p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm font-medium">The default flow, as nodes</p>
        <p className="text-xs text-muted-foreground">Every box is draggable in the builder</p>
      </div>
      <div className="flex flex-col items-stretch gap-2 lg:flex-row lg:items-center">
        {STEPS.map((step, index) => {
          const connector = getConnector(step.connectorId);
          return (
            <div key={step.connectorId} className="flex min-w-0 flex-1 items-center gap-2">
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.08, type: 'spring', stiffness: 260, damping: 24 }}
                className={cn(
                  'wf-node flex w-full min-w-0 items-center gap-3 rounded-xl border bg-card p-3 shadow-sm',
                  step.accent ? 'border-violet-500/40 ring-2 ring-violet-500/15' : '',
                )}
              >
                {connector === undefined ? null : <ConnectorIcon connector={connector} size={18} />}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{step.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{step.caption}</p>
                </div>
              </motion.div>
              {index < STEPS.length - 1 ? <ArrowRight className="hidden size-4 shrink-0 text-muted-foreground lg:block" /> : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
