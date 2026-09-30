'use client';

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { Stagger, StaggerItem } from '@/components/motion/fade-in';
import { TemplateCard } from '@/components/templates/template-card';
import { buildTemplateEntries, templateJobs } from '@/components/templates/template-entry';
import { TemplatePreview } from '@/components/templates/template-preview';
import { useBrand } from '@/hooks/use-brand';
import { useCreateWorkflow } from '@/hooks/use-create-workflow';
import type { TemplateJob } from '@/lib/workflow/templates';
import { cn } from '@/lib/utils';

export default function TemplatesPage() {
  const brand = useBrand();
  const create = useCreateWorkflow();
  const [job, setJob] = useState<TemplateJob | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // One sample copy of each template, only to draw and describe it. "Use this
  // template" builds a fresh one with new ids through useCreateWorkflow.
  const entries = useMemo(() => buildTemplateEntries(brand), [brand]);
  const jobs = useMemo(() => templateJobs(entries), [entries]);
  // "All" reads job by job, so related templates sit next to each other.
  const visible = job === null ? jobs.flatMap((group) => entries.filter((entry) => entry.meta.job === group.job)) : entries.filter((entry) => entry.meta.job === job);
  const previewing = entries.find((entry) => entry.meta.id === previewId);

  const preview = (id: string) => {
    setPreviewId(id);
    setPreviewOpen(true);
  };

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Templates"
        term="template"
        description="Complete workflows for the jobs teams actually hand to coding agents: tickets nobody picks up, a red main, new errors, security alerts, dependency and flag upkeep, bugs reported by customers. Each has its guardrails in place. Using one copies it into your workflows, ready to change."
        actions={
          <Button variant="outline" onClick={() => create.blank()}>
            <Plus data-icon="inline-start" /> Start blank instead
          </Button>
        }
      />

      {/* One scrolling row on phones instead of five wrapped ones. */}
      <div role="group" aria-label="Filter by job" className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        <TagChip label="All" count={entries.length} active={job === null} onClick={() => setJob(null)} />
        {jobs.map((entry) => (
          <TagChip key={entry.job} label={entry.label} count={entry.count} active={job === entry.job} onClick={() => setJob(job === entry.job ? null : entry.job)} />
        ))}
      </div>

      {/* Keyed by job so a new filter replays the entrance instead of popping in.
          Columns follow the width the grid has, not the window, so the sidebar never squeezes a card. */}
      <div className="@container">
        <Stagger key={job ?? 'all'} className="grid gap-4 @[44rem]:grid-cols-2 @[66rem]:grid-cols-3">
          {visible.map((entry) => (
            <StaggerItem key={entry.meta.id} className="h-full">
              <TemplateCard entry={entry} onPreview={() => preview(entry.meta.id)} onUse={() => create.fromTemplate(entry.meta.id)} />
            </StaggerItem>
          ))}
        </Stagger>
      </div>

      <TemplatePreview entry={previewing} open={previewOpen} onOpenChange={setPreviewOpen} onUse={(id) => create.fromTemplate(id)} />
    </div>
  );
}

function TagChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
        active ? 'border-primary/30 bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {label}
      <span className={cn('tabular-nums', active ? 'text-primary/70' : 'text-muted-foreground/70')}>{count}</span>
    </button>
  );
}
