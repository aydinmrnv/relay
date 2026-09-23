import { Eye, GitBranch, Repeat2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * The phases inside the Agent pipeline node, in the order a run goes through
 * them. Mirrors PHASES in src/lib/workflow/simulate.ts (labels and roles), with
 * a sentence each on what actually happens.
 */

type Role = 'planner' | 'planReviewer' | 'implementer' | 'codeReviewer';

const ROLES: Record<Role, { label: string; agent: string; reviewer: boolean; why: string }> = {
  planner: { label: 'Planner', agent: 'Claude Code', reviewer: false, why: 'Reads the code and decides what to change.' },
  planReviewer: { label: 'Plan reviewer', agent: 'Codex', reviewer: true, why: 'Attacks the plan before any code is written, when changing course is cheap.' },
  implementer: { label: 'Implementer', agent: 'Codex', reviewer: false, why: 'Writes the change, and answers the code review.' },
  codeReviewer: { label: 'Code reviewer', agent: 'Claude Code', reviewer: true, why: 'Reads the diff with fresh eyes: a different model from the one that wrote it.' },
};

interface Phase {
  label: string;
  role?: Role;
  /** Review and revision phases repeat, up to the review level's rounds. */
  repeats?: boolean;
  what: string;
}

const GROUPS: Array<{ title: string; phases: Phase[] }> = [
  {
    title: 'Prepare',
    phases: [
      { label: 'Fetching issue', what: 'Reads the ticket the trigger handed over: title, body, labels and links.' },
      { label: 'Creating workspace', what: 'Creates an isolated git worktree on a fresh branch, named from the branch prefix and the ticket, so your own checkout is never touched.' },
    ],
  },
  {
    title: 'Plan',
    phases: [
      { label: 'Planning', role: 'planner', what: 'Reads the code and writes plan.md: what will change, where, and how it will be tested.' },
      { label: 'Plan review', role: 'planReviewer', repeats: true, what: 'A different agent checks the plan against the real code, read-only, and lists what is wrong or missing.' },
      { label: 'Plan revision', role: 'planner', repeats: true, what: 'The planner answers the review. Review and revision repeat until the reviewer has nothing left to raise or the round limit is reached.' },
    ],
  },
  {
    title: 'Build',
    phases: [
      { label: 'Implementation', role: 'implementer', what: 'Makes the change in the worktree. The diff you see afterwards is computed from git, not from what the agent says it did.' },
      { label: 'Code review', role: 'codeReviewer', repeats: true, what: 'The other agent reviews the diff, read-only. The test suite can run at the same time, since neither needs the other’s verdict.' },
      { label: 'Code revision', role: 'implementer', repeats: true, what: 'The implementer fixes what the review found, again up to the round limit.' },
    ],
  },
  {
    title: 'Verify',
    phases: [{ label: 'Tests', what: 'Runs the project’s own test suite, detected automatically or the command you set. The suite has the last word: if it fails, so does the run.' }],
  },
];

/** Each phase's position in the whole run, counted across groups. */
const NUMBER = new Map(GROUPS.flatMap((group) => group.phases).map((phase, index) => [phase.label, index + 1]));

const LEVELS: Array<{ name: string; rounds: string; when: string }> = [
  { name: 'Light', rounds: '1 round', when: 'Small, well-described tickets.' },
  { name: 'Standard', rounds: '2 rounds each', when: 'The default.' },
  { name: 'Thorough', rounds: '3 rounds each', when: 'Anything you would not want to review twice yourself.' },
];

export function PipelineStepper() {
  return (
    <div className="@container">
      <div className="grid gap-8 @3xl:grid-cols-[minmax(0,1fr)_17rem]">
        <ol className="grid gap-6" aria-label="Pipeline phases, in order">
          {GROUPS.map((group) => (
            <li key={group.title}>
              <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.title}</p>
              <ol className="grid">
                {group.phases.map((phase) => {
                  const role = phase.role === undefined ? undefined : ROLES[phase.role];
                  return (
                    <li key={phase.label} className="group/phase relative flex gap-3.5 pb-5 last:pb-0">
                      {/* The rail: a line from this step's dot down to the next one. */}
                      <span aria-hidden className="absolute top-7 bottom-1 left-3.5 w-px -translate-x-1/2 bg-border group-last/phase:hidden" />
                      <span
                        className={cn(
                          'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums',
                          role === undefined ? 'bg-muted text-muted-foreground' : role.reviewer ? 'border-info/40 bg-info/10 text-info' : 'border-primary/40 bg-primary/10 text-primary',
                        )}
                      >
                        {NUMBER.get(phase.label)}
                      </span>
                      <div className="min-w-0 pt-0.5">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                          {phase.label}
                          {role === undefined ? null : (
                            <Badge variant="outline" className="h-5 gap-1 text-[11px] font-normal">
                              {role.reviewer ? <Eye className="size-3" aria-hidden /> : null}
                              {role.label} · {role.agent}
                            </Badge>
                          )}
                          {phase.repeats === true ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
                              <Repeat2 className="size-3" aria-hidden /> repeats
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{phase.what}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
          <li className="flex gap-3.5 rounded-xl border border-dashed p-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <GitBranch className="size-3.5" aria-hidden />
            </span>
            <p className="text-sm text-pretty text-muted-foreground">
              <span className="font-medium text-foreground">Then delivery.</span> The pipeline hands its run to the Deliver node, which commits, pushes, opens a pull request or merges, as far as its policy and the unattended rules allow. A secret scan runs before anything is pushed.
            </p>
          </li>
        </ol>

        <aside className="grid content-start gap-4">
          <div className="rounded-xl border p-4">
            <p className="text-sm font-medium">Roles and their defaults</p>
            <ul className="mt-3 grid gap-3">
              {(Object.keys(ROLES) as Role[]).map((key) => {
                const role = ROLES[key];
                return (
                  <li key={key} className="grid gap-0.5 text-sm">
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 font-medium">
                        <span className={cn('size-2 rounded-full', role.reviewer ? 'bg-info' : 'bg-primary')} aria-hidden />
                        {role.label}
                      </span>
                      <span className="text-xs text-muted-foreground">{role.agent}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">{role.why}</span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 border-t pt-3 text-xs text-pretty text-muted-foreground">
              Change them on the pipeline node. Reviewers always run read-only, which is why Aider can implement but never review.
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-sm font-medium">Review levels</p>
            <ul className="mt-3 grid gap-2.5">
              {LEVELS.map((level) => (
                <li key={level.name} className="grid gap-0.5 text-sm">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{level.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{level.rounds}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{level.when}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t pt-3 text-xs text-pretty text-muted-foreground">The Fast run node skips both reviews: one agent plans and implements in a single session, and only the tests check the work.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
