'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AlertTriangle, CircleAlert, Laptop, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { HelpTip } from '@/components/app/help-tip';
import { useAgentsStore } from '@/hooks/use-agent-accounts';
import { useCompanion } from '@/lib/companion/client';
import { machineRunNodes } from '@/lib/companion/machine-run';
import { repositoryLabel, type RunTask } from '@/lib/companion/types';
import { compiledConfig } from '@/lib/run-launcher';
import type { Workflow } from '@/lib/workflow/schema';

interface Props {
  workflow: Workflow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: (task: RunTask) => void;
}

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', aider: 'Aider' };

/**
 * "Run on this machine": the one place in the studio that spends real money,
 * so it says exactly what will happen before it does — where, on what, with
 * which agents, how far delivery goes and what stops it.
 */
export function MachineRunDialog({ workflow, open, onOpenChange, onRun }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">{open ? <MachineRunForm workflow={workflow} onCancel={() => onOpenChange(false)} onRun={onRun} /> : null}</DialogContent>
    </Dialog>
  );
}

function MachineRunForm({ workflow, onCancel, onRun }: { workflow: Workflow; onCancel: () => void; onRun: (task: RunTask) => void }) {
  const hello = useCompanion((state) => state.hello);
  const agents = useAgentsStore((state) => state.status);
  const [kind, setKind] = useState<RunTask['kind']>('issue');
  const [ref, setRef] = useState('');
  const [text, setText] = useState('');

  const host = hello?.machine ?? 'your machine';
  const repo = repositoryLabel(hello?.repository);
  const nodes = machineRunNodes(workflow);
  const config = useMemo(() => {
    try {
      return compiledConfig(workflow);
    } catch {
      return null;
    }
  }, [workflow]);

  const roles = (config?.['agents'] ?? {}) as Record<string, string>;
  const shape = (config?.['workflow'] ?? {}) as Record<string, unknown>;
  const used = [...new Set(Object.values(roles))];
  const signedOut = agents === null ? [] : used.filter((id) => (id === 'claude' || id === 'codex') && !agents.agents[id].loggedIn);
  const deliver = String(shape['deliver'] ?? 'pr');
  const cap = typeof shape['maxCostUsd'] === 'number' ? shape['maxCostUsd'] : null;
  const fast = shape['plan'] === 'inline' && shape['reviewCode'] === false;
  const mismatch = workflow.repository !== undefined && workflow.repository !== '' && repo !== null && workflow.repository !== repo;

  const task: RunTask | null = kind === 'issue' ? (ref.trim().length > 0 ? { kind: 'issue', ref: ref.trim() } : null) : text.trim().length > 0 ? { kind: 'prompt', text: text.trim() } : null;
  const blocked = nodes.pipeline === undefined || hello?.repository === null || hello?.repository === undefined || config === null;

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (task !== null && !blocked) onRun(task);
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Laptop className="size-4" /> Run “{workflow.name}” on {host}
          <HelpTip term="companion" />
        </DialogTitle>
        <DialogDescription className="text-pretty">
          The agent pipeline runs for real in {repo === null ? 'the repository relay connect was started in' : <span className="font-medium text-foreground">{repo}</span>}, with your own sign-ins, and streams back here. It spends your plans’ usage — a test run is the free way to check the graph.
        </DialogDescription>
      </DialogHeader>

      {nodes.pipeline === undefined ? (
        <Notice tone="error">This workflow has no Agent pipeline node, so there is nothing to run. Add one from the palette.</Notice>
      ) : hello?.repository === null || hello?.repository === undefined ? (
        <Notice tone="error">
          relay connect was started outside a repository, so there is nowhere to run. Stop it and start it again inside the repository this workflow works on.
        </Notice>
      ) : null}
      {mismatch ? (
        <Notice tone="warn">
          This workflow is attached to <span className="font-mono">{workflow.repository}</span>, but your machine is in <span className="font-mono">{repo}</span>. The run happens in {repo}.
        </Notice>
      ) : null}
      {signedOut.length > 0 ? (
        <Notice tone="warn">
          {signedOut.map((id) => AGENT_NAMES[id] ?? id).join(' and ')} {signedOut.length === 1 ? 'is' : 'are'} not signed in on {host}, so the run would stop at its first turn.{' '}
          <Link href="/settings#agents" className="underline underline-offset-2">
            Sign in
          </Link>
        </Notice>
      ) : null}

      <Tabs value={kind} onValueChange={(value) => setKind(value as RunTask['kind'])}>
        <TabsList className="w-full">
          <TabsTrigger value="issue">An issue</TabsTrigger>
          <TabsTrigger value="prompt">A description</TabsTrigger>
        </TabsList>
        <TabsContent value="issue" className="grid gap-1.5">
          <Label htmlFor="machine-run-issue">Issue to work on</Label>
          <Input id="machine-run-issue" value={ref} onChange={(event) => setRef(event.target.value)} placeholder="142, acme/api#142, ENG-142 or an issue URL" autoComplete="off" spellCheck={false} className="font-mono" autoFocus />
          <p className="text-xs text-muted-foreground">Read through the tracker the repository uses — GitHub, or Linear when its config says so.</p>
        </TabsContent>
        <TabsContent value="prompt" className="grid gap-1.5">
          <Label htmlFor="machine-run-prompt">What should change</Label>
          <Textarea id="machine-run-prompt" value={text} onChange={(event) => setText(event.target.value)} placeholder="Fix the flaky timeout in the retry test…" className="min-h-28" />
          <p className="text-xs text-muted-foreground">Work with no ticket, the way relay run --prompt does it.</p>
        </TabsContent>
      </Tabs>

      <div className="grid gap-1.5 rounded-lg border bg-muted/30 p-3 text-xs">
        <p className="font-medium text-foreground">What will happen</p>
        <ul className="grid gap-1 text-muted-foreground">
          <li>
            {fast ? (
              <>Fast run: {AGENT_NAMES[roles['implementer'] ?? ''] ?? roles['implementer']} plans and implements, unreviewed.</>
            ) : (
              <>
                {AGENT_NAMES[roles['planner'] ?? ''] ?? roles['planner']} plans, {AGENT_NAMES[roles['planReviewer'] ?? ''] ?? roles['planReviewer']} attacks the plan, {AGENT_NAMES[roles['implementer'] ?? ''] ?? roles['implementer']} implements and{' '}
                {AGENT_NAMES[roles['codeReviewer'] ?? ''] ?? roles['codeReviewer']} reviews the diff ({String(shape['review'] ?? 'standard')} review), in a worktree of its own.
              </>
            )}
          </li>
          <li>
            Delivery: {deliver === 'none' ? 'nothing is committed' : deliver === 'branch' ? 'committed to a run branch, published nowhere' : deliver === 'push' ? 'committed and pushed' : 'committed, pushed and opened as a pull request'}. A run started here never merges — that is yours to do.
          </li>
          <li>{cap === null ? 'No per-run cap: set Max cost on the pipeline node to have the run stop itself.' : `Stops itself once it has cost more than $${cap.toFixed(2)}.`}</li>
          <li>Guardrails decide whether an event may start a run, so a person pressing this passes over them; actions after delivery run in the exported workflow.</li>
        </ul>
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={task === null || blocked}>
          <Play data-icon="inline-start" className="fill-current" /> Start the run
        </Button>
      </DialogFooter>
    </form>
  );
}

function Notice({ tone, children }: { tone: 'warn' | 'error'; children: React.ReactNode }) {
  const Icon = tone === 'error' ? CircleAlert : AlertTriangle;
  return (
    <p className={tone === 'error' ? 'flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/8 p-2.5 text-xs text-destructive' : 'flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs text-amber-800 dark:text-warning'}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="text-pretty">{children}</span>
    </p>
  );
}
