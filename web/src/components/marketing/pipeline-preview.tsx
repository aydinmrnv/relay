'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import {
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  FileCode2,
  GitBranch,
  GitPullRequestDraft,
  ShieldCheck,
  Terminal,
  Workflow,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AppMark, useCalmMotion } from './primitives';

const STAGES = [
  {
    id: 'issue',
    label: 'Issue',
    agent: 'GitHub',
    connector: 'github',
    heading: 'Start with the ticket.',
    description:
      'A labeled issue brings the task and repository into the workflow. Author permissions and budget limits are checked before the agents start.',
    file: 'issue #142',
    kind: 'input',
    lines: [
      'Fix the flaky retry test',
      '',
      'Repository   acme/api',
      'Label        agent-ready',
      'Expected     Deterministic retries in CI',
    ],
    output: 'Task and repository context',
  },
  {
    id: 'plan',
    label: 'Plan',
    agent: 'Claude Code',
    connector: 'claude-code',
    heading: 'A plan, with a second opinion.',
    description:
      'Claude reads the repository and proposes a change. Codex checks the plan against the code before implementation begins.',
    file: 'plan.md',
    kind: 'plan',
    lines: [
      '01  Inspect the retry test and timer setup',
      '02  Replace real delays with a fake clock',
      '03  Advance the clock before assertions',
      '04  Run the focused test, then the suite',
      '',
      'Codex → plan reviewed',
    ],
    output: 'Reviewed implementation plan',
  },
  {
    id: 'build',
    label: 'Build',
    agent: 'Codex',
    connector: 'codex-cli',
    heading: 'The change gets its own worktree.',
    description:
      'Codex implements the reviewed plan in an isolated git worktree. Your working directory stays available while the agent works.',
    file: 'test/retry.test.ts',
    kind: 'diff',
    lines: [
      '  test("retries a failed request", async () => {',
      '+   vi.useFakeTimers();',
      '    const result = retry(request);',
      '-   await sleep(1000);',
      '+   await vi.advanceTimersByTimeAsync(1000);',
      '    expect(await result).toEqual(response);',
      '+   vi.useRealTimers();',
      '  });',
    ],
    output: 'A diff ready for independent review',
  },
  {
    id: 'review',
    label: 'Review',
    agent: 'Claude Code',
    connector: 'claude-code',
    heading: 'Fresh eyes on the actual diff.',
    description:
      'Claude reviews the implementation against the plan and the repository. Blocking findings go back for a fix, with a cap on review rounds.',
    file: 'review.md',
    kind: 'review',
    lines: [
      '✓  Change matches the reviewed plan',
      '✓  Retry assertions remain intact',
      '✓  Timer state restored after the test',
      '',
      'Blocking findings    0',
      'Review outcome       Approved',
    ],
    output: 'Reviewed code and recorded findings',
  },
  {
    id: 'test',
    label: 'Test',
    agent: 'Your test suite',
    connector: null,
    heading: 'Let the repository prove it.',
    description:
      'Run your configured test command and scan the change for secrets. A failed check stops delivery and preserves the result for inspection.',
    file: 'terminal',
    kind: 'test',
    lines: [
      '$ npm test -- retry.test.ts',
      '',
      '✓ retries a failed request',
      '✓ stops after the retry limit',
      '',
      'Tests        2 passed',
      'Secret scan  passed',
    ],
    output: 'Test results and secret-scan checks',
  },
  {
    id: 'delivery',
    label: 'Draft PR',
    agent: 'GitHub',
    connector: 'github',
    heading: 'Ready for your review.',
    description:
      'The diff, review, and test results arrive in a draft pull request. You inspect the change and decide when it is ready to merge.',
    file: 'pull request',
    kind: 'delivery',
    lines: [
      'DRAFT  Fix the flaky retry test',
      '',
      'acme/api ← agent/issue-142',
      '',
      '✓ Independent review',
      '✓ Tests and secret scan',
      '○ Awaiting your review',
    ],
    output: 'Draft pull request · merge stays with you',
  },
] as const;

export function PipelinePreview() {
  const [active, setActive] = useState(2);
  const id = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const reduce = useCalmMotion();
  const stage = STAGES[active];

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % STAGES.length;
    else if (event.key === 'ArrowLeft') next = (index + STAGES.length - 1) % STAGES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = STAGES.length - 1;
    else return;
    event.preventDefault();
    setActive(next);
    tabs.current[next]?.focus({ preventScroll: true });
    tabs.current[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card text-left" aria-label="Interactive workflow example">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <Workflow className="size-4 text-muted-foreground" />
          <h2 className="text-xs font-medium sm:text-sm">Issue to pull request</h2>
          <span className="rounded border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground uppercase">
            Example
          </span>
        </div>
        <Link
          href="/templates"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Explore templates <ArrowUpRight className="size-3.5" />
        </Link>
      </div>

      <div className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5 text-[11px] sm:px-6">
          <span className="text-muted-foreground">
            <span className="mr-2 font-mono">#142</span> Fix the flaky retry test
          </span>
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <GitBranch className="size-3" /> acme/api
          </span>
        </div>
        <div className="px-4 pt-6 pb-6 sm:px-6" role="tablist" aria-label="Workflow stages">
          <div className="grid grid-cols-3 items-center gap-x-4 gap-y-4 lg:flex lg:gap-0">
            {STAGES.map((item, index) => (
              <div key={item.id} className="relative flex min-w-0 flex-1 items-center lg:mr-7 lg:last:mr-0">
                <button
                  ref={(element) => {
                    tabs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`${id}-${item.id}`}
                  aria-selected={index === active}
                  aria-controls={`${id}-detail`}
                  tabIndex={index === active ? 0 : -1}
                  onClick={() => setActive(index)}
                  onKeyDown={(event) => navigate(event, index)}
                  className={cn(
                    'relative flex min-w-0 flex-1 flex-col gap-3 rounded-md border bg-card p-2.5 text-left sm:p-3 transition-colors hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    index === active && 'border-foreground bg-background',
                  )}
                >
                  <span className="flex w-full items-center justify-between">
                    <span className="flex size-7 items-center justify-center rounded-md border">
                      {item.id === 'delivery' ? (
                        <GitPullRequestDraft className="size-3.5" />
                      ) : item.connector ? (
                        <AppMark connector={item.connector} size={14} />
                      ) : (
                        <Terminal className="size-3.5" />
                      )}
                    </span>
                    <span className="font-mono text-[9px] text-muted-foreground">0{index + 1}</span>
                  </span>
                  <span className="block w-full text-xs font-medium">
                    {item.label}
                    <span className="mt-1 block truncate text-[9px] sm:text-[10px] font-normal text-muted-foreground">
                      {item.agent}
                    </span>
                  </span>
                </button>
                {index < STAGES.length - 1 && (
                  <span
                    aria-hidden
                    className={cn(
                      'absolute top-1/2 -right-4 h-px w-4 bg-border lg:-right-7 lg:w-7',
                      index === 2 && 'hidden lg:block',
                    )}
                  >
                    <ChevronRight className="absolute -top-[5.5px] right-0 size-3 text-muted-foreground" />
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div
        role="tabpanel"
        id={`${id}-detail`}
        aria-labelledby={`${id}-${stage.id}`}
        tabIndex={0}
        className="focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <motion.div
          key={stage.id}
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduce ? 0 : 0.16 }}
          className="grid md:min-h-[290px] md:grid-cols-[0.9fr_1.1fr]"
        >
          <div className="flex flex-col items-start p-5 sm:p-6 lg:p-7">
            <p className="font-mono text-xs text-muted-foreground">
              0{active + 1} / {stage.label}
            </p>
            <h3 className="mt-3 text-xl leading-snug font-medium tracking-tight sm:text-2xl">{stage.heading}</h3>
            <p className="mt-3 max-w-md text-[13px] leading-relaxed text-muted-foreground">{stage.description}</p>
            <p className="mt-6 flex items-center gap-2 pt-3 text-[11px] text-muted-foreground md:mt-auto">
              <ArrowRight className="size-3.5 shrink-0" />
              {stage.output}
            </p>
          </div>
          <div className="min-w-0 border-t bg-muted/20 md:border-t-0 md:border-l">
            <div className="flex items-center justify-between gap-2 border-b px-5 py-3 font-mono text-[10px] text-muted-foreground">
              <span className="flex items-center gap-2">
                <FileCode2 className="size-3.5" />
                {stage.file}
              </span>
              <span>sample output</span>
            </div>
            <pre
              tabIndex={0}
              aria-label={`${stage.label} sample output`}
              className="min-h-[220px] overflow-x-auto py-4 font-mono text-[11px] leading-6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <code>
                {stage.lines.map((line, index) => (
                  <span
                    key={index}
                    className={cn(
                      'block min-w-max px-5',
                      // Added and removed lines in git's own colours: the only colour in the sample.
                      stage.kind === 'diff' &&
                        line.startsWith('+') &&
                        'bg-success/[0.07] text-[color-mix(in_oklch,var(--success)_80%,var(--foreground))]',
                      stage.kind === 'diff' &&
                        line.startsWith('-') &&
                        'bg-destructive/[0.06] text-[color-mix(in_oklch,var(--destructive)_85%,var(--foreground))]',
                    )}
                  >
                    <span aria-hidden className="mr-5 inline-block w-3 select-none text-right text-muted-foreground/70">
                      {index + 1}
                    </span>
                    {line || ' '}
                    {'\n'}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        </motion.div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-[10px] text-muted-foreground sm:px-6">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="size-3.5" /> Your machine. Your keys. Your approval.
        </span>
        <button
          type="button"
          onClick={() => setActive((active + 1) % STAGES.length)}
          className="inline-flex items-center gap-1.5 rounded-sm py-1 text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {active === STAGES.length - 1 ? 'Back to the issue' : 'Next step'} <ArrowRight className="size-3" />
        </button>
      </div>
    </div>
  );
}
