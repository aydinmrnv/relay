'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { BrandMark } from '@/components/app/brand-mark';
import { AppMark } from '@/components/marketing/primitives';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { InstallGuide } from '@/components/projects/install-guide';
import { DescribeWorkflowComposer } from '@/components/workflows/describe-workflow';
import { useBrand } from '@/hooks/use-brand';
import { projectActions, useProjects } from '@/hooks/use-projects';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { api, importableGuestWorkflows, importGuestWorkflows, readGuestBackup } from '@/lib/cloud/sync';
import type { OnboardingAnswers } from '@/lib/cloud/types';
import { listPublicRepositories, lookupRepository, type PublicRepository, type RepositoryLookup } from '@/lib/github-public';
import { parseRepository, projectId, workflowsOf } from '@/lib/projects';
import { clearSetupDraft, markSetupLeft, readSetupDraft, writeSetupDraft } from '@/lib/setup-draft';
import { useStudio } from '@/lib/store';
import type { SetupMode } from '@/lib/setup-draft';
import type { ProjectRunner, Workflow } from '@/lib/workflow/schema';
import { asksOf, buildStarter, fitWorkflow, getStarter, STARTERS, startsOn, type AgentChoice, type ReviewLevel, type StarterId, type StarterOptions } from '@/lib/workflow/starters';
import { workflowFromDescription } from '@/lib/workflow/from-description';
import { blankWorkflow } from '@/lib/workflow/templates';
import { isPlaceholderLogin } from '@/lib/workflow/validate';
import { cn } from '@/lib/utils';

type Choice = StarterId | 'describe' | 'blank';

const STEPS = ['Repository', 'Where it runs', 'Workflow', 'Rules', 'Install'] as const;
/** The last step with questions on it. The one after is the result, and has no way back. */
const LAST_QUESTION = 3;
const INSTALL = 4;

const AGENTS: Array<{ id: AgentChoice; name: string; long: string }> = [
  { id: 'both', name: 'Both', long: 'Claude Code and Codex, each reviewing the other' },
  { id: 'claude', name: 'Claude Code', long: 'Claude Code only' },
  { id: 'codex', name: 'Codex', long: 'Codex only' },
];

const REVIEWS: Array<{ id: ReviewLevel; name: string }> = [
  { id: 'light', name: 'Light' },
  { id: 'standard', name: 'Standard' },
  { id: 'thorough', name: 'Thorough' },
];

/** The two to choose between at a glance. The rest are a click away, so the first screen of choices is a short one. */
const FIRST_CHOICES: readonly Choice[] = ['issue-to-pr', 'quick-fix'];

/** The answers so far. `null` means "not touched": the value follows the workflow, or the project, that was picked. */
interface Draft {
  step: number;
  repo: string;
  runner: ProjectRunner | null;
  choice: Choice;
  describeText: string;
  label: string | null;
  authors: string | null;
  maxRun: number | null;
  maxDaily: number | null;
  agents: AgentChoice;
  review: ReviewLevel | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const amount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T | null => (options.includes(value as T) ? (value as T) : null);

/** What this tab kept, read as the answers it claims to be: a draft is whatever was in storage, and an old one may name a workflow that is gone. */
function readDraft(mode: SetupMode): Draft {
  const saved = readSetupDraft(mode);
  const repo = text(saved['repo']) ?? '';
  const step = typeof saved['step'] === 'number' && Number.isInteger(saved['step']) ? Math.min(LAST_QUESTION, Math.max(0, saved['step'])) : 0;
  return {
    // Every later step is about a repository: without one there is only the first.
    step: parseRepository(repo) === null ? 0 : step,
    repo,
    runner: oneOf(saved['runner'], ['actions', 'machine', 'cloud'] as const),
    choice: oneOf<Choice>(saved['choice'], [...STARTERS.map((starter) => starter.id), 'describe', 'blank']) ?? 'issue-to-pr',
    describeText: text(saved['describeText']) ?? '',
    label: text(saved['label']),
    authors: text(saved['authors']),
    maxRun: amount(saved['maxRun']),
    maxDaily: amount(saved['maxDaily']),
    agents: oneOf(saved['agents'], ['both', 'claude', 'codex'] as const) ?? 'both',
    review: oneOf(saved['review'], ['light', 'standard', 'thorough'] as const),
  };
}

/**
 * A GitHub login, loosely: letters, digits, hyphens, and the underscore that
 * an organisation's managed accounts carry (`jdoe_acme`), with `[bot]` for an
 * app. This catches a slip of the keyboard, not every name GitHub would refuse.
 */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}(?:\[bot\])?$/;

function splitLogins(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((login) => login.trim().replace(/^@/, '')).filter((login) => login.length > 0))];
}

/** What a workflow already says about the things setup asks, so a described one keeps what its sentence said. */
function answersIn(workflow: Workflow | null): { label?: string; authors?: string; maxRun?: number; maxDaily?: number; review?: ReviewLevel } {
  const found: ReturnType<typeof answersIn> = {};
  for (const node of workflow?.nodes ?? []) {
    const config = node.data.config;
    if (node.data.typeId === 'github-issues.trigger.issue-labelled' && typeof config['label'] === 'string') found.label = config['label'];
    if (node.data.typeId === 'gates.action.allowlist') {
      // A template's example names are not anybody's answer.
      const named = splitLogins(String(config['authors'] ?? '')).filter((entry) => !isPlaceholderLogin(entry));
      if (named.length > 0) found.authors = named.join(', ');
    }
    if (node.data.typeId === 'gates.action.budget') {
      if (typeof config['maxRunCostUsd'] === 'number') found.maxRun = config['maxRunCostUsd'];
      if (typeof config['maxDailyCostUsd'] === 'number') found.maxDaily = config['maxDailyCostUsd'];
    }
    if (node.data.typeId === 'pipeline.action.run' && (config['review'] === 'light' || config['review'] === 'standard' || config['review'] === 'thorough')) found.review = config['review'];
  }
  return found;
}

/**
 * Setting a project up: the repository, where it runs, what it does, the
 * rules it runs under, and then the steps that put it in the repository.
 *
 * `first` is the one after signing up, which also records that onboarding is
 * done. `add` is the same questions for another repository, from Projects.
 */
export function SetupWizard({ mode }: { mode: SetupMode }) {
  const router = useRouter();
  const brand = useBrand();
  const reduce = useCalmMotion();
  const status = useAccount((state) => state.status);
  const user = useAccount((state) => state.user);
  const capabilities = useCapabilities();
  const cloudOffered = capabilities.cloudHub != null;
  const hydrated = useStudio((state) => state.hydrated);
  const projects = useProjects();
  const inAccount = useStudio((state) => state.workflows);

  // Kept for this tab: the browser's Back button, a reload or a detour to the docs must not throw the answers away.
  const [draft] = useState(() => readDraft(mode));
  const [wanted, setStep] = useState(draft.step);
  const [direction, setDirection] = useState(1);
  const [repoInput, setRepoInput] = useState(draft.repo);
  const [runnerChoice, setRunner] = useState<ProjectRunner | null>(draft.runner);
  const [choice, setChoice] = useState<Choice>(draft.choice);
  // The sentence is what was kept; the workflow it describes is read from it again, as the composer would.
  const [described, setDescribed] = useState<{ text: string; workflow: Workflow | null }>(() => ({
    text: draft.describeText,
    workflow: draft.describeText.trim() === '' ? null : workflowFromDescription(draft.describeText, brand, parseRepository(draft.repo) ?? '').workflow,
  }));
  const [label, setLabel] = useState<string | null>(draft.label);
  const [authors, setAuthors] = useState<string | null>(draft.authors);
  const [maxRun, setMaxRun] = useState<number | null>(draft.maxRun);
  const [maxDaily, setMaxDaily] = useState<number | null>(draft.maxDaily);
  const [agents, setAgents] = useState<AgentChoice>(draft.agents);
  const [review, setReview] = useState<ReviewLevel | null>(draft.review);
  const [importIds, setImportIds] = useState<Set<string> | null>(null);
  // Folded away until asked for: the other workflows, and the settings that already have sensible answers.
  const [moreChoices, setMoreChoices] = useState(() => !FIRST_CHOICES.includes(draft.choice));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ workflowId: string; projectId: string } | null>(null);

  const [lookup, setLookup] = useState<{ repository: string; result: RepositoryLookup } | null>(null);
  const [mine, setMine] = useState<PublicRepository[]>([]);

  useEffect(() => {
    // The install step is the result, not an answer to come back to.
    if (wanted >= INSTALL) clearSetupDraft(mode);
    else writeSetupDraft(mode, { step: wanted, repo: repoInput, runner: runnerChoice, choice, describeText: described.text, label, authors, maxRun, maxDaily, agents, review } satisfies Draft);
  }, [mode, wanted, repoInput, runnerChoice, choice, described.text, label, authors, maxRun, maxDaily, agents, review]);

  // Each step is an entry in the tab's history, so Back goes to the step before, not out of setup.
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const target = typeof (event.state as { step?: unknown } | null)?.step === 'number' ? (event.state as { step: number }).step : 0;
      setStep((current) => {
        // The install step has no way back into the questions: the project exists by then.
        if (current >= INSTALL) return current;
        setDirection(target > current ? 1 : -1);
        return Math.max(0, Math.min(LAST_QUESTION, target));
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const parsed = useMemo(() => parseRepository(repoInput), [repoInput]);

  // Ask GitHub about the repository once the typing pauses. A private one answers like one that is not there, and that is fine.
  useEffect(() => {
    if (parsed === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void lookupRepository(parsed, controller.signal).then((result) => {
        if (!controller.signal.aborted) setLookup({ repository: parsed, result });
      });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [parsed]);

  const login = user?.github ?? null;
  useEffect(() => {
    if (login === null) return;
    const controller = new AbortController();
    void listPublicRepositories(login, controller.signal).then((list) => {
      if (!controller.signal.aborted) setMine(list);
    });
    return () => controller.abort();
  }, [login]);

  const seen = parsed !== null && lookup !== null && lookup.repository === parsed ? lookup.result : null;
  const publicRepo = seen?.state === 'public' ? seen.repository : null;
  // GitHub's own capitalisation when it could be read, else what was typed.
  const repo = publicRepo?.repository ?? parsed ?? '';
  const existing = parsed === null ? undefined : projects.find((project) => project.id === projectId(parsed));
  // A repository that is already a project runs where it already runs, until somebody picks otherwise here.
  const runner: ProjectRunner = runnerChoice ?? (existing !== undefined && existing.implied !== true ? existing.runner : 'actions');
  // On GitHub Actions a repository holds one set of rules, so a second workflow there replaces the first one's.
  const sharing = useMemo(() => (existing === undefined ? [] : workflowsOf(existing, Object.values(inAccount))), [existing, inAccount]);

  // The workflow that was picked, as it stands before the rules are written into it: what the rules step reads its defaults from.
  const base = useMemo<Workflow | null>(() => {
    if (choice === 'blank') return blankWorkflow(brand, repo);
    if (choice === 'describe') return described.workflow;
    const starter = getStarter(choice)!;
    return buildStarter(choice, brand, { repository: repo, label: starter.defaults.label(brand), authors: [], maxRunCostUsd: starter.defaults.maxRunCostUsd, maxDailyCostUsd: starter.defaults.maxDailyCostUsd, agents: 'both', review: starter.defaults.review }) ?? null;
  }, [choice, brand, repo, described.workflow]);
  const asks = useMemo(() => (base === null ? null : asksOf(base)), [base]);
  const said = useMemo(() => answersIn(base), [base]);

  // Whoever is setting this up may start runs, when GitHub says who they are: their own login, or the repository's owner if that is a person.
  const defaultAuthors = login ?? (publicRepo?.ownerIsUser === true ? publicRepo.owner : '');
  const authorsText = authors ?? said.authors ?? defaultAuthors;
  const authorList = useMemo(() => splitLogins(authorsText), [authorsText]);
  const badLogins = authorList.filter((entry) => !LOGIN.test(entry));
  const options: StarterOptions = useMemo(
    () => ({
      repository: repo,
      label: (label ?? said.label ?? `${brand.slug}:go`).trim().replace(/\s+/g, ' '),
      authors: authorList,
      maxRunCostUsd: maxRun ?? said.maxRun ?? 8,
      maxDailyCostUsd: maxDaily ?? said.maxDaily ?? 40,
      agents,
      review: review ?? said.review ?? 'standard',
    }),
    [repo, label, said, brand.slug, authorList, maxRun, maxDaily, agents, review],
  );
  const workflow = useMemo(() => (base === null ? null : fitWorkflow(base, options)), [base, options]);
  const starts = useMemo(() => (workflow === null ? null : startsOn(workflow, runner, brand)), [workflow, runner, brand]);
  // The step on screen. The browser's Forward button can ask for one whose answer is gone: no repository, or no workflow to set rules for.
  const step = wanted >= INSTALL ? wanted : parsed === null ? 0 : wanted === LAST_QUESTION && workflow === null ? 2 : wanted;

  // How each starter starts on the runner that was picked, worked out from the workflow itself rather than written on the card.
  const starterStarts = useMemo(
    () =>
      Object.fromEntries(
        STARTERS.map((starter) => {
          const built = buildStarter(starter.id, brand, { repository: repo, label: starter.defaults.label(brand), authors: [], maxRunCostUsd: starter.defaults.maxRunCostUsd, maxDailyCostUsd: starter.defaults.maxDailyCostUsd, agents: 'both', review: starter.defaults.review });
          return [starter.id, built === undefined ? null : startsOn(built, runner, brand)];
        }),
      ),
    [brand, repo, runner],
  );

  // Read once the account has loaded: signing in sets the guest's work aside first.
  const guestWork = useMemo(() => (status !== 'signed-in' || typeof window === 'undefined' ? [] : importableGuestWorkflows(readGuestBackup(), inAccount)), [status, inAccount]);
  const chosenImports = importIds ?? new Set(guestWork.map((entry) => entry.id));

  const createdWorkflow = useStudio((state) => (created === null ? null : (state.workflows[created.workflowId] ?? null)));
  const createdProject = created === null ? null : (projects.find((project) => project.id === created.projectId) ?? null);

  // The studio without an account, on a development copy, works from this browser alone.
  const ready = hydrated && (status === 'signed-in' || status === 'disabled');
  if (!ready) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading your account" />
        {status === 'guest' ? (
          <Link href="/sign-in?next=/onboarding" className="text-sm font-medium underline underline-offset-4">
            Sign in to set up a project
          </Link>
        ) : null}
      </div>
    );
  }

  const go = (next: number) => {
    setDirection(next > step ? 1 : -1);
    setStep(next);
    if (next > step) window.history.pushState({ step: next }, '');
    window.scrollTo({ top: 0 });
  };

  const rulesValid = asks === null || ((!asks.label || options.label.length > 0) && (!asks.allowlist || badLogins.length === 0) && (!asks.budget || (options.maxRunCostUsd > 0 && options.maxDailyCostUsd >= options.maxRunCostUsd)));
  const canContinue = step === 0 ? parsed !== null : step === 2 ? workflow !== null : step === 3 ? workflow !== null && rulesValid : true;

  const recordOnboarded = async (answers: OnboardingAnswers) => {
    if (mode !== 'first' || status !== 'signed-in') return;
    const result = await api<{ onboardedAt: string }>('/api/workspace/onboarding', { method: 'POST', body: answers });
    useAccount.setState({ onboardedAt: result.onboardedAt, onboarding: answers });
  };

  const create = async () => {
    if (workflow === null || parsed === null) return;
    setSaving(true);
    try {
      projectActions.add({ repository: repo, runner, ...(publicRepo === null ? {} : { defaultBranch: publicRepo.defaultBranch, private: false }) });
      const now = new Date().toISOString();
      // On GitHub Actions the files say whether a label may start anything, and somebody who has just set its
      // allowlist and its budget means it to. Elsewhere it starts paused, like every other workflow made here.
      const saved: Workflow = { ...workflow, repository: repo, createdAt: now, updatedAt: now, demo: undefined, enabled: runner === 'actions' && choice !== 'blank' };
      useStudio.getState().upsertWorkflow(saved);
      if (chosenImports.size > 0) {
        try {
          await importGuestWorkflows([...chosenImports]);
        } catch (error) {
          toast.error('Could not bring your browser workflows along', { description: `${error instanceof Error ? error.message : ''} You can retry from Settings → Account.` });
        }
      }
      // There is a project now, so the dashboard has something to show whether or not the server hears about it.
      markSetupLeft();
      setCreated({ workflowId: saved.id, projectId: projectId(repo) });
      go(INSTALL);
      try {
        await recordOnboarded({ repository: repo, runner, agents, review: options.review, firstWorkflow: choice });
      } catch {
        // The project and its workflow are saved and will sync; only the note that setup was done is missing, and the dashboard does not need it.
      }
    } catch (error) {
      toast.error('Could not finish setting up', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const leave = async () => {
    clearSetupDraft(mode);
    if (mode === 'add') {
      router.push('/projects');
      return;
    }
    // Remembered in this tab first, so the dashboard does not send them straight back if the server cannot be told.
    markSetupLeft();
    try {
      await recordOnboarded({});
    } catch {
      // Skipping should never trap anyone here.
    }
    router.push('/dashboard');
  };

  const budgetError = asks?.budget !== true ? null : options.maxRunCostUsd <= 0 ? 'A run needs something to spend.' : options.maxDailyCostUsd < options.maxRunCostUsd ? 'The day’s budget has to cover at least one run.' : null;
  const labelError = asks?.label === true && options.label.length === 0 ? 'It needs a label to start on.' : null;
  // A default that is no longer valid is shown open, with what is wrong with it, not hidden behind "Change".
  const showEditors = editing || budgetError !== null || labelError !== null;
  const hasDefaults = asks !== null && (asks.label || asks.budget || asks.agents || asks.review);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 sm:px-6">
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <BrandMark className="size-6" />
          {brand.name}
        </span>
        <ol className="flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
          {STEPS.map((name, index) => (
            <li key={name} aria-current={index === step ? 'step' : undefined} className={cn('h-1 w-7 rounded-full transition-colors sm:w-9', index <= step ? 'bg-foreground' : 'bg-border')}>
              <span className="sr-only">{name}</span>
            </li>
          ))}
        </ol>
        <span className="flex justify-end">
          {step < INSTALL ? (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void leave()}>
              {mode === 'add' ? 'Cancel' : 'Skip for now'}
            </Button>
          ) : null}
        </span>
      </header>

      <main className="flex flex-1 justify-center px-4 pt-8 pb-20 sm:pt-16">
        <div className="w-full max-w-xl">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              initial={reduce ? false : { opacity: 0, x: 16 * direction }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: -16 * direction }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col gap-6"
            >
              {step === 0 ? (
                <>
                  <Heading step={step} title="Connect your repository" body={`${brand.name} builds automations that live in your repository and run on its GitHub Actions.`} />
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="setup-repo" className="sr-only">
                      Repository
                    </Label>
                    <div className="relative">
                      <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
                        <AppMark connector="github" size={16} />
                      </span>
                      <Input
                        id="setup-repo"
                        value={repoInput}
                        onChange={(event) => setRepoInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && parsed !== null) go(1);
                        }}
                        placeholder="owner/name, or paste its GitHub link"
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus
                        aria-invalid={repoInput.trim().length > 0 && parsed === null}
                        aria-describedby="setup-repo-state"
                        className="h-12 pl-10 font-mono md:text-base"
                      />
                    </div>
                    <div id="setup-repo-state" aria-live="polite" className="min-h-5">
                      <RepoState input={repoInput} parsed={parsed} seen={seen} existing={existing !== undefined} />
                    </div>
                  </div>
                  {mine.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm text-muted-foreground">Or pick one of yours</p>
                      <Choices label="Your public repositories">
                        {mine.slice(0, 5).map((entry) => (
                          <Choice key={entry.repository} selected={parsed !== null && projectId(parsed) === projectId(entry.repository)} onSelect={() => setRepoInput(entry.repository)} title={<span className="font-mono text-[13px]">{entry.repository}</span>} />
                        ))}
                      </Choices>
                    </div>
                  ) : null}
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lock className="size-3 shrink-0" aria-hidden /> {brand.name} never asks for access to your code. You commit its files yourself.
                  </p>
                </>
              ) : null}

              {step === 1 ? (
                <>
                  <Heading step={step} title="Where should it run?" body="You can change this later." />
                  <Choices label="Where it runs">
                    <Choice selected={runner === 'actions'} onSelect={() => setRunner('actions')} title="GitHub Actions" tag="Recommended" body="In your repository, on its own minutes. Nothing to install or keep running." />
                    <Choice selected={runner === 'machine'} onSelect={() => setRunner('machine')} title="Your computer" body="Through the Relay CLI, with the agents already signed in there." />
                    {cloudOffered ? <Choice selected={runner === 'cloud'} onSelect={() => setRunner('cloud')} title="Relay Cloud" tag="Invite-only beta" body="A machine Relay runs for you and wakes when you need it." /> : null}
                  </Choices>
                  {runner === 'actions' && sharing.length > 0 ? (
                    <p className="text-xs text-pretty text-amber-700 dark:text-warning">
                      {repo} already has “{sharing[0]!.name}”. On GitHub Actions a repository starts one workflow by itself: the one installed last. To run several side by side, pick your computer.
                    </p>
                  ) : null}
                </>
              ) : null}

              {step === 2 ? (
                <>
                  <Heading step={step} title="What should it do?" body="Pick a first workflow. You can change every step of it afterwards." />
                  <Choices label="First workflow">
                    {STARTERS.filter((starter) => moreChoices || FIRST_CHOICES.includes(starter.id)).map((starter, index) => (
                      <Choice
                        key={starter.id}
                        selected={choice === starter.id}
                        onSelect={() => setChoice(starter.id)}
                        title={starter.title}
                        tag={index === 0 ? 'Recommended' : undefined}
                        // Said only when it is the exception: most start by themselves, and a label on every row is noise.
                        note={starterStarts[starter.id]?.itself === false ? 'Started by hand' : undefined}
                        body={starter.short}
                      />
                    ))}
                    {moreChoices ? (
                      <>
                        <Choice selected={choice === 'describe'} onSelect={() => setChoice('describe')} title="Describe your own" body="Say what should happen in a sentence." />
                        <Choice selected={choice === 'blank'} onSelect={() => setChoice('blank')} title="Blank canvas" body="Start empty and build it step by step." />
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setMoreChoices(true)}
                        className="flex w-full items-center gap-1.5 px-4 py-3 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50"
                      >
                        <ChevronDown className="size-4" aria-hidden /> More options
                      </button>
                    )}
                  </Choices>
                  {choice === 'describe' ? (
                    <DescribeWorkflowComposer value={described.text} onChange={(value, result) => setDescribed({ text: value, workflow: result?.workflow ?? null })} repository={repo} autoFocus showPreview={false} />
                  ) : null}
                  {starts !== null && !starts.itself && choice !== 'blank' && workflow !== null ? <p className="text-xs text-pretty text-muted-foreground">{starts.detail}</p> : null}
                </>
              ) : null}

              {step === 3 && workflow !== null && asks !== null ? (
                <>
                  <Heading
                    step={step}
                    title={asks.allowlist ? 'Who can start a run?' : 'Almost done'}
                    body={asks.allowlist ? 'Only these GitHub users can start one by labelling an issue.' : `“${workflow.name}” will be added to ${repo}.`}
                  />
                  {asks.allowlist ? (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="setup-authors" className="sr-only">
                        GitHub usernames
                      </Label>
                      <Input
                        id="setup-authors"
                        value={authorsText}
                        onChange={(event) => setAuthors(event.target.value)}
                        placeholder="your-github-username, a-teammate"
                        spellCheck={false}
                        autoComplete="off"
                        autoFocus
                        aria-invalid={badLogins.length > 0}
                        aria-describedby="setup-authors-hint"
                        className="h-12 font-mono md:text-base"
                      />
                      <p id="setup-authors-hint" className={cn('min-h-5 text-xs text-pretty', badLogins.length > 0 ? 'text-destructive' : authorList.length === 0 ? 'text-amber-700 dark:text-warning' : 'text-muted-foreground')}>
                        {badLogins.length > 0
                          ? `${badLogins.join(', ')} ${badLogins.length === 1 ? 'is not' : 'are not'} a GitHub username.`
                          : authorList.length === 0
                            ? 'With nobody listed, nobody can start a run. Add at least yourself.'
                            : 'GitHub usernames, separated by commas.'}
                      </p>
                    </div>
                  ) : null}

                  {hasDefaults ? (
                    <div className="overflow-hidden rounded-xl border bg-card">
                      <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
                        <p className="text-sm font-medium">Defaults</p>
                        <Button variant="ghost" size="sm" className="-mr-2 text-muted-foreground" onClick={() => setEditing(!showEditors)} disabled={showEditors && (budgetError !== null || labelError !== null)}>
                          {showEditors ? 'Done' : 'Change'}
                        </Button>
                      </div>
                      <dl className="divide-y text-sm">
                        {asks.label ? (
                          <Row term="Label" htmlFor="setup-label">
                            {showEditors ? (
                              // What was typed, spaces and all: the trimmed label is what gets saved.
                              <Input id="setup-label" value={label ?? options.label} onChange={(event) => setLabel(event.target.value)} spellCheck={false} autoComplete="off" maxLength={50} className="w-44 font-mono" aria-invalid={labelError !== null} />
                            ) : (
                              <span className="font-mono text-[13px]">{options.label}</span>
                            )}
                          </Row>
                        ) : null}
                        {asks.budget ? (
                          <Row term="Budget">
                            {showEditors ? (
                              <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 text-muted-foreground">
                                <Money id="setup-run" label="Per run, in dollars" value={options.maxRunCostUsd} onChange={setMaxRun} /> a run
                                <Money id="setup-day" label="Per day, in dollars" value={options.maxDailyCostUsd} onChange={setMaxDaily} /> a day
                              </span>
                            ) : (
                              <span>
                                ${options.maxRunCostUsd} a run · ${options.maxDailyCostUsd} a day
                              </span>
                            )}
                          </Row>
                        ) : null}
                        {asks.agents ? (
                          <Row term="Agents">
                            {showEditors ? (
                              <Segments label="Which agents do the work" value={agents} onChange={setAgents} options={AGENTS} />
                            ) : (
                              <span>{AGENTS.find((option) => option.id === agents)?.long}</span>
                            )}
                          </Row>
                        ) : null}
                        {asks.review ? (
                          <Row term="Review">
                            {showEditors ? <Segments label="How thoroughly they review" value={options.review} onChange={setReview} options={REVIEWS} /> : <span>{REVIEWS.find((option) => option.id === options.review)?.name}</span>}
                          </Row>
                        ) : null}
                      </dl>
                    </div>
                  ) : null}
                  {budgetError !== null || labelError !== null ? <p className="-mt-3 text-xs text-destructive">{labelError ?? budgetError}</p> : null}

                  {guestWork.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm text-muted-foreground">Also bring from this browser</p>
                      {guestWork.map((entry) => (
                        <label key={entry.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={chosenImports.has(entry.id)}
                            onCheckedChange={(checked) => {
                              const next = new Set(chosenImports);
                              if (checked === true) next.add(entry.id);
                              else next.delete(entry.id);
                              setImportIds(next);
                            }}
                          />
                          <span className="truncate">{entry.name}</span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}

              {step === INSTALL && createdWorkflow !== null && createdProject !== null ? (
                <>
                  <Heading
                    step={step}
                    title={createdProject.runner === 'actions' ? `Add it to ${createdProject.repository}` : createdProject.runner === 'machine' ? 'Connect your computer' : 'Set up Relay Cloud'}
                    body={
                      createdProject.runner === 'actions'
                        ? `“${createdWorkflow.name}” is saved. These last steps happen in your repository. Do them now, or later from Projects.`
                        : `“${createdWorkflow.name}” is saved. One more thing before it can run for real.`
                    }
                  />
                  <InstallGuide workflow={createdWorkflow} project={createdProject} />
                </>
              ) : null}
            </motion.div>
          </AnimatePresence>

          {step < INSTALL ? (
            <div className="mt-8 flex items-center justify-between gap-3">
              {step === 0 ? (
                <span />
              ) : (
                <Button variant="ghost" className="-ml-2.5 text-muted-foreground" onClick={() => go(step - 1)} disabled={saving}>
                  <ArrowLeft data-icon="inline-start" /> Back
                </Button>
              )}
              {step < LAST_QUESTION ? (
                <Button size="lg" onClick={() => go(step + 1)} disabled={!canContinue}>
                  Continue <ArrowRight data-icon="inline-end" />
                </Button>
              ) : (
                <Button size="lg" onClick={() => void create()} disabled={!canContinue || saving}>
                  {saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
                  Create project
                </Button>
              )}
            </div>
          ) : (
            <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
              {createdWorkflow === null ? (
                <span />
              ) : (
                <Button variant="ghost" className="-ml-2.5 text-muted-foreground" nativeButton={false} render={<Link href={`/workflows/${createdWorkflow.id}`} />}>
                  Open in the builder
                </Button>
              )}
              <Button size="lg" nativeButton={false} render={<Link href="/dashboard" />}>
                Go to the dashboard <ArrowRight data-icon="inline-end" />
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** What GitHub said about the repository being typed, in one line. */
function RepoState({ input, parsed, seen, existing }: { input: string; parsed: string | null; seen: RepositoryLookup | null; existing: boolean }) {
  if (input.trim().length === 0) return null;
  if (parsed === null) return <p className="text-xs text-destructive">That is not a GitHub repository. Use owner/name, like acme/api.</p>;
  if (seen === null) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden /> Looking it up on GitHub…
      </p>
    );
  }
  const also = existing ? ' Already one of your projects: this adds a workflow to it.' : '';
  if (seen.state === 'public') {
    const found = seen.repository;
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-pretty text-muted-foreground">
        <Check className="size-3.5 shrink-0 text-success" aria-hidden />
        <span>
          Found <span className="font-mono text-foreground">{found.repository}</span>, public, on <span className="font-mono">{found.defaultBranch}</span>.{also}
          {found.archived ? <span className="text-amber-700 dark:text-warning"> It is archived, so nothing can push to it until you unarchive it.</span> : null}
        </span>
      </p>
    );
  }
  if (seen.state === 'unseen') {
    return (
      <p className="flex items-start gap-1.5 text-xs text-pretty text-muted-foreground">
        <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span>Not visible publicly, which is fine if it is private. Check the spelling, then continue.{also}</span>
      </p>
    );
  }
  return <p className="text-xs text-pretty text-muted-foreground">{seen.reason === 'rate-limited' ? 'GitHub is not answering lookups right now.' : 'GitHub could not be reached to check.'} You can continue.</p>;
}

function Heading({ step, title, body }: { step: number; title: string; body: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Step {step + 1} of {STEPS.length}
      </p>
      <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h1>
      <p className="text-pretty text-muted-foreground">{body}</p>
    </div>
  );
}

/** One question's answers, as rows in a single frame: one thing to look at, not a wall of cards. */
function Choices({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="divide-y overflow-hidden rounded-xl border bg-card">
      {children}
    </div>
  );
}

function Choice({ selected, onSelect, title, body, tag, note }: { selected: boolean; onSelect: () => void; title: React.ReactNode; body?: string; tag?: string; note?: string }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn('flex w-full items-start gap-3 px-4 py-3.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50', selected && 'bg-muted/60 hover:bg-muted/60')}
    >
      <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors', selected ? 'border-foreground' : 'border-foreground/25')} aria-hidden>
        {selected ? <span className="size-2 rounded-full bg-foreground" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
          {title}
          {tag === undefined ? null : <span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{tag}</span>}
          {note === undefined ? null : <span className="text-xs font-normal text-amber-700 dark:text-warning">{note}</span>}
        </span>
        {body === undefined ? null : <span className="text-sm text-pretty text-muted-foreground">{body}</span>}
      </span>
    </button>
  );
}

function Row({ term, htmlFor, children }: { term: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-4 py-2">
      <dt className="shrink-0 text-muted-foreground">{htmlFor === undefined ? term : <label htmlFor={htmlFor}>{term}</label>}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/** A few named options side by side, exactly one of them pressed. */
function Segments<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (value: T) => void; options: ReadonlyArray<{ id: T; name: string }> }) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        // A toggle group lets you un-press the current item; one of them must stay chosen.
        const picked = next[0] as T | undefined;
        if (picked !== undefined && picked !== value) onChange(picked);
      }}
      variant="outline"
      size="sm"
      spacing={0}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.id} value={option.id} className="aria-pressed:bg-primary/10 aria-pressed:text-foreground">
          {option.name}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Money({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (value: number) => void }) {
  return (
    <span className="relative inline-block w-20">
      <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">$</span>
      <Input
        id={id}
        aria-label={label}
        type="number"
        inputMode="decimal"
        min={0}
        step={1}
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange(Number.isFinite(next) ? next : 0);
        }}
        className="pl-6 text-foreground tabular-nums"
      />
    </span>
  );
}
