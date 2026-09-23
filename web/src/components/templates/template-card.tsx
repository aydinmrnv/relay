'use client';

import { ArrowRight, Eye } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { GraphThumbnail } from './graph-thumbnail';
import type { TemplateEntry } from './template-entry';

interface Props {
  entry: TemplateEntry;
  onPreview: () => void;
  onUse: () => void;
}

export function TemplateCard({ entry, onPreview, onUse }: Props) {
  const { meta, workflow, description, connectors } = entry;
  const steps = description.steps.length;
  const apps = description.apps.length;
  return (
    <article className="group/card flex h-full flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-[translate,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-foreground/5 hover:ring-foreground/20 motion-reduce:hover:translate-y-0">
      <button
        type="button"
        onClick={onPreview}
        aria-label={`Preview “${meta.name}”`}
        className="relative block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <GraphThumbnail workflow={workflow} className="h-28 transition-colors group-hover/card:bg-muted/50" />
        <span className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-md border bg-card/90 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground opacity-0 shadow-xs backdrop-blur transition-opacity group-hover/card:opacity-100">
          <Eye className="size-3" aria-hidden /> Preview
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {connectors.map((connector) => (
            <span key={connector.id} title={connector.name} className={connector.category === 'core' ? 'opacity-70' : ''}>
              <ConnectorIcon connector={connector} size={12} />
            </span>
          ))}
        </div>
        <h2 className="text-base leading-snug font-semibold tracking-tight">{meta.name}</h2>
        <p className="text-[13px] leading-relaxed text-pretty text-muted-foreground">{meta.description}</p>
        <div className="mt-auto flex flex-wrap gap-1 pt-1">
          {meta.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="font-normal">
              {tag}
            </Badge>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border/60 pt-3">
        <p className="text-xs text-muted-foreground">
          {steps} steps · {apps === 0 ? 'no apps to connect' : `${apps} ${apps === 1 ? 'app' : 'apps'} to connect`}
          {description.agents.length > 0 ? ` · ${description.agents.length} coding ${description.agents.length === 1 ? 'agent' : 'agents'}` : ''}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onPreview}>
            <Eye data-icon="inline-start" /> Preview
          </Button>
          <Button className="flex-1" onClick={onUse}>
            Use this template <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </article>
  );
}
