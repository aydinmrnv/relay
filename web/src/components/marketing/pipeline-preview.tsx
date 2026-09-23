'use client';

import { useRef, type ReactNode, type Ref } from 'react';
import { CheckCircle2, GitPullRequestDraft, ShieldCheck, Workflow } from 'lucide-react';
import { AnimatedBeam } from '@/components/21st/animated-beam';
import { BorderBeam } from '@/components/21st/border-beam';
import { useBrand } from '@/hooks/use-brand';
import { cn } from '@/lib/utils';
import { AppMark, AppTile, useCalmMotion } from './primitives';

const SOURCES = [
  { id: 'linear', name: 'Linear', event: 'Issue assigned' },
  { id: 'github', name: 'GitHub', event: 'Label added' },
  { id: 'sentry', name: 'Sentry', event: 'New error' },
] as const;

/** The five pipeline phases, each owned by the agent the default config gives it. */
const PHASES: Array<{ agent: 'claude-code' | 'codex-cli' | null; label: string; meta: string }> = [
  { agent: 'claude-code', label: 'Plan', meta: 'plan.md' },
  { agent: 'codex-cli', label: 'Review the plan', meta: '3 findings' },
  { agent: 'codex-cli', label: 'Implement', meta: '+84 −12' },
  { agent: 'claude-code', label: 'Review the diff', meta: 'approved' },
  { agent: null, label: 'Run your tests', meta: 'exit 0' },
];

// Violet into sky reads on both backgrounds; the resting path uses currentColor.
const BEAM = { gradientStartColor: '#8b5cf6', gradientStopColor: '#38bdf8', pathColor: 'currentColor', pathOpacity: 0.45, pathWidth: 1.5, duration: 4 };

/**
 * The default workflow as the hero shows it: where a ticket comes from, what
 * stands in front of the agents, what the agents do, and where the result
 * goes. Beams are drawn between the boxes' centres and recomputed on resize,
 * so the same markup lays out as a row on desktop and a column on phones.
 * With reduced motion the beams rest as plain lines and nothing is hidden.
 */
export function PipelinePreview() {
  const brand = useBrand();
  const reduce = useCalmMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const linearRef = useRef<HTMLDivElement>(null);
  const githubRef = useRef<HTMLDivElement>(null);
  const sentryRef = useRef<HTMLDivElement>(null);
  const gateRef = useRef<HTMLDivElement>(null);
  const pipelineRef = useRef<HTMLDivElement>(null);
  const prRef = useRef<HTMLDivElement>(null);
  const slackRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      className="relative mx-auto flex w-full max-w-5xl flex-col items-center gap-9 text-muted-foreground lg:flex-row lg:items-center lg:justify-between lg:gap-4"
    >
      {/* Where the work comes from */}
      <div className="grid w-full max-w-md grid-cols-3 gap-2 lg:flex lg:w-44 lg:max-w-none lg:flex-col lg:gap-3">
        <SourceNode ref={linearRef} source={SOURCES[0]} />
        <SourceNode ref={githubRef} source={SOURCES[1]} />
        <SourceNode ref={sentryRef} source={SOURCES[2]} />
      </div>

      {/* What stands in front of the agents */}
      <Box ref={gateRef} className="w-full max-w-72 flex-col items-stretch gap-2 p-3 lg:w-44">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-success/12 text-success">
            <ShieldCheck className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-foreground">Guardrails</p>
            <p className="text-[11px] text-muted-foreground">refuse by default</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {['$6 / run', 'Allowlist', 'Kill switch'].map((gate) => (
            <span key={gate} className="rounded-md border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80">
              {gate}
            </span>
          ))}
        </div>
      </Box>

      {/* What the agents do */}
      <Box ref={pipelineRef} className="w-full max-w-80 flex-col items-stretch gap-0 overflow-hidden p-0 shadow-lg shadow-primary/5 lg:w-72">
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2.5">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <Workflow className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-foreground">Agent pipeline</p>
            <p className="truncate text-[11px] text-muted-foreground">isolated worktree · {brand.slug}/eng-142</p>
          </div>
        </div>
        <ol className="flex flex-col gap-0.5 p-2">
          {PHASES.map((phase, index) => (
            <li key={phase.label} className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5">
              <span className="inline-flex size-5 shrink-0 items-center justify-center">
                {phase.agent === null ? <CheckCircle2 className="size-4 text-success" /> : <AppMark connector={phase.agent} size={15} />}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                <span className="mr-1.5 text-muted-foreground tabular-nums">{index + 1}</span>
                {phase.label}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{phase.meta}</span>
            </li>
          ))}
        </ol>
        {reduce ? null : <BorderBeam size={90} duration={7} colorFrom="#8b5cf6" colorTo="#38bdf8" />}
      </Box>

      {/* Where the result goes */}
      <div className="grid w-full max-w-80 grid-cols-2 gap-2 lg:flex lg:w-44 lg:flex-col lg:gap-3">
        <Box ref={prRef} className="gap-2 p-2.5">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-info/12 text-info">
            <GitPullRequestDraft className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-foreground">Draft PR</p>
            <p className="truncate text-[11px] text-muted-foreground">never merges itself</p>
          </div>
        </Box>
        <Box ref={slackRef} className="gap-2 p-2.5">
          <AppTile connector="slack" size={15} />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-foreground">Slack</p>
            <p className="truncate text-[11px] text-muted-foreground">#eng-agents</p>
          </div>
        </Box>
      </div>

      <AnimatedBeam containerRef={containerRef} fromRef={linearRef} toRef={gateRef} {...BEAM} delay={0} />
      <AnimatedBeam containerRef={containerRef} fromRef={githubRef} toRef={gateRef} {...BEAM} delay={0.2} />
      <AnimatedBeam containerRef={containerRef} fromRef={sentryRef} toRef={gateRef} {...BEAM} delay={0.4} />
      <AnimatedBeam containerRef={containerRef} fromRef={gateRef} toRef={pipelineRef} {...BEAM} delay={0.8} />
      <AnimatedBeam containerRef={containerRef} fromRef={pipelineRef} toRef={prRef} {...BEAM} delay={1.6} />
      <AnimatedBeam containerRef={containerRef} fromRef={pipelineRef} toRef={slackRef} {...BEAM} delay={1.8} />
    </div>
  );
}

function SourceNode({ ref, source }: { ref: Ref<HTMLDivElement>; source: (typeof SOURCES)[number] }) {
  return (
    <Box ref={ref} className="flex-col gap-1.5 px-2 py-2.5 text-center lg:flex-row lg:gap-2.5 lg:p-2.5 lg:text-left">
      <AppTile connector={source.id} size={15} />
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold text-foreground lg:text-[13px]">{source.name}</p>
        <p className="truncate text-[11px] text-muted-foreground">{source.event}</p>
      </div>
    </Box>
  );
}

/** A node-shaped card that sits above the beams. */
function Box({ ref, className, children }: { ref: Ref<HTMLDivElement>; className?: string; children: ReactNode }) {
  return (
    <div ref={ref} className={cn('relative z-10 flex items-center rounded-xl border bg-card text-left shadow-sm', className)}>
      {children}
    </div>
  );
}
