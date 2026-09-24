'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarClock,
  Check,
  FilePlus2,
  GraduationCap,
  Hand,
  Laptop,
  LayoutDashboard,
  Loader2,
  PencilLine,
  Sparkles,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BrandMark } from '@/components/app/brand-mark';
import { AppMark } from '@/components/marketing/primitives';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { GraphThumbnail } from '@/components/templates/graph-thumbnail';
import { DescribeWorkflowComposer } from '@/components/workflows/describe-workflow';
import { CopyButton } from '@/components/runs/copy-button';
import { useBrand } from '@/hooks/use-brand';
import { authClient } from '@/lib/auth-client';
import { useAccount } from '@/lib/cloud/account';
import { api, importableGuestWorkflows, importGuestWorkflows, readGuestBackup } from '@/lib/cloud/sync';
import type { OnboardingAnswers } from '@/lib/cloud/types';
import { useStudio } from '@/lib/store';
import { workflowFromDescription } from '@/lib/workflow/from-description';
import type { Workflow } from '@/lib/workflow/schema';
import { blankWorkflow, instantiateTemplate, TEMPLATES } from '@/lib/workflow/templates';
import { cn } from '@/lib/utils';

type Role = 'solo' | 'team' | 'oss' | 'learning';
type AgentChoice = 'both' | 'claude' | 'codex';
type Review = 'light' | 'standard' | 'thorough';

const ROLES: Array<{ id: Role; icon: LucideIcon; title: string; body: string }> = [
  { id: 'solo', icon: User, title: 'Building on my own', body: 'Side projects, a startup, freelance work.' },
  { id: 'team', icon: Users, title: 'Part of a team', body: 'A shared repository and a tracker full of tickets.' },
  { id: 'oss', icon: BookOpen, title: 'Maintaining open source', body: 'Issues from strangers, and a budget to protect.' },
  { id: 'learning', icon: GraduationCap, title: 'Learning', body: 'Seeing how agent pipelines work, hands on.' },
];

/** Where a run can start. `app` is a catalog connector id, for its icon. */
const SOURCES: Array<{ id: string; app: string | null; icon?: LucideIcon; label: string; phrase: string }> = [
  { id: 'github-issues', app: 'github', label: 'GitHub Issues', phrase: 'When a GitHub issue is labelled relay' },
  { id: 'linear', app: 'linear', label: 'Linear', phrase: 'When a Linear issue is assigned to the bot' },
  { id: 'jira', app: 'jira', label: 'Jira', phrase: 'When a Jira issue is created' },
  { id: 'sentry', app: 'sentry', label: 'Sentry errors', phrase: 'When Sentry reports a new error' },
  { id: 'zendesk', app: 'zendesk', label: 'Support tickets', phrase: 'When a Zendesk ticket is tagged bug, after I approve' },
  { id: 'schedule', app: null, icon: CalendarClock, label: 'A schedule', phrase: 'Every weeknight at 2am' },
  { id: 'manual', app: null, icon: Hand, label: 'By hand', phrase: 'When I start it by hand' },
];

const DESTINATIONS: Array<{ id: string; app: string; label: string; phrase: string }> = [
  { id: 'slack', app: 'slack', label: 'Slack', phrase: 'tell Slack #eng' },
  { id: 'discord', app: 'discord', label: 'Discord', phrase: 'ping Discord' },
  { id: 'microsoft-teams', app: 'microsoft-teams', label: 'Teams', phrase: 'post to Microsoft Teams' },
  { id: 'comment', app: 'github', label: 'Comment on the issue', phrase: 'comment the summary on the issue' },
];

const AGENTS: Array<{ id: AgentChoice; title: string; body: string; badge?: string; marks: string[] }> = [
  { id: 'both', title: 'Claude Code and Codex', body: 'Each reviews the other’s plan and diff. Nothing grades its own homework.', badge: 'Recommended', marks: ['claude-code', 'codex-cli'] },
  { id: 'claude', title: 'Claude Code only', body: 'One Claude plan does everything. Reviews are by a fresh, read-only session.', marks: ['claude-code'] },
  { id: 'codex', title: 'Codex only', body: 'One ChatGPT plan does everything. Reviews are by a fresh, read-only session.', marks: ['codex-cli'] },
];

const REVIEWS: Array<{ id: Review; title: string; body: string }> = [
  { id: 'light', title: 'Light', body: 'One code-review round. Fastest, cheapest.' },
  { id: 'standard', title: 'Standard', body: 'Plan and code reviewed, two rounds each.' },
  { id: 'thorough', title: 'Thorough', body: 'Three rounds each; every finding goes back.' },
];

const STEPS = ['About you', 'Your tools', 'Your agents', 'First workflow', 'Ready'] as const;

type Pick = { kind: 'made'; workflow: Workflow } | { kind: 'template'; id: string; workflow: Workflow } | { kind: 'describe'; workflow: Workflow | null } | { kind: 'blank'; workflow: Workflow };

export function OnboardingWizard() {
  const router = useRouter();
  const brand = useBrand();
  const reduce = useCalmMotion();
  const status = useAccount((state) => state.status);
  const user = useAccount((state) => state.user);
  const savedRepository = useStudio((state) => state.settings.defaultRepository);

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [name, setName] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [destinations, setDestinations] = useState<string[]>(['slack']);
  const [agents, setAgents] = useState<AgentChoice>('both');
  const [review, setReview] = useState<Review>('standard');
  const [repository, setRepository] = useState<string | null>(null);
  const [choice, setChoice] = useState<'made' | 'describe' | 'blank' | string>('made');
  const [described, setDescribed] = useState<{ text: string; workflow: Workflow | null }>({ text: '', workflow: null });
  const [importIds, setImportIds] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<Workflow | null>(null);

  const displayName = name ?? user?.name ?? '';
  const repo = repository ?? (savedRepository === 'acme/api' ? '' : savedRepository);
  const repoValid = repo.trim().length === 0 || /^[\w.-]+\/[\w.-]+$/.test(repo.trim());
  const effectiveRepo = repo.trim().length > 0 ? repo.trim() : 'your-org/your-repo';

  const guestWork = useMemo(() => (typeof window === 'undefined' ? [] : importableGuestWorkflows(readGuestBackup())), []);
  const chosenImports = importIds ?? new Set(guestWork.map((workflow) => workflow.id));

  const sentence = useMemo(() => madeForYouSentence(sources, destinations, review, role), [sources, destinations, review, role]);
  const madeForYou = useMemo(() => withAgents(workflowFromDescription(sentence, brand, effectiveRepo).workflow, agents, review), [sentence, brand, effectiveRepo, agents, review]);
  const ranked = useMemo(() => rankTemplates(sources, destinations).slice(0, 3), [sources, destinations]);
  const templatePreviews = useMemo(
    () => Object.fromEntries(ranked.map((template) => [template.id, instantiateTemplate(template.id, brand, effectiveRepo)])) as Record<string, Workflow | undefined>,
    [ranked, brand, effectiveRepo],
  );

  const pick: Pick | null = useMemo(() => {
    if (choice === 'made') return { kind: 'made', workflow: madeForYou };
    if (choice === 'blank') return { kind: 'blank', workflow: blankWorkflow(brand, effectiveRepo) };
    if (choice === 'describe') return { kind: 'describe', workflow: described.workflow === null ? null : withAgents(described.workflow, agents, review) };
    const template = templatePreviews[choice];
    return template === undefined ? null : { kind: 'template', id: choice, workflow: withAgents(template, agents, review) };
  }, [choice, madeForYou, brand, effectiveRepo, described.workflow, agents, review, templatePreviews]);

  if (status !== 'signed-in' || user === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading your account" />
      </div>
    );
  }

  const go = (next: number) => {
    setDirection(next > step ? 1 : -1);
    setStep(next);
  };

  const canContinue = step === 0 ? displayName.trim().length > 0 : step === 2 ? repoValid : step === 3 ? pick !== null && pick.workflow !== null : true;

  const finish = async () => {
    if (pick === null || pick.workflow === null) return;
    setSaving(true);
    try {
      const studio = useStudio.getState();
      if (repo.trim().length > 0 && repo.trim() !== studio.settings.defaultRepository) studio.updateSettings({ defaultRepository: repo.trim() });
      if (displayName.trim() !== user.name) {
        const { error } = await authClient.updateUser({ name: displayName.trim() });
        if (!error) useAccount.setState({ user: { ...user, name: displayName.trim() } });
      }
      const now = new Date().toISOString();
      const workflow: Workflow = { ...pick.workflow, repository: effectiveRepo, createdAt: now, updatedAt: now, demo: undefined };
      studio.upsertWorkflow(workflow);
      if (chosenImports.size > 0) {
        try {
          await importGuestWorkflows([...chosenImports]);
        } catch (error) {
          toast.error('Could not bring your browser workflows along', { description: `${error instanceof Error ? error.message : ''} You can retry from Settings → Account.` });
        }
      }
      const answers: OnboardingAnswers = { role: role ?? undefined, sources, destinations, agents, review, repository: repo.trim() || undefined, firstWorkflow: pick.kind === 'template' ? pick.id : pick.kind };
      const result = await api<{ onboardedAt: string }>('/api/workspace/onboarding', { method: 'POST', body: answers });
      useAccount.setState({ onboardedAt: result.onboardedAt, onboarding: answers });
      setCreated(workflow);
      go(4);
    } catch (error) {
      toast.error('Could not finish setting up', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const skip = async () => {
    try {
      const result = await api<{ onboardedAt: string }>('/api/workspace/onboarding', { method: 'POST', body: { role: role ?? undefined } });
      useAccount.setState({ onboardedAt: result.onboardedAt });
    } catch {
      // Skipping should never trap anyone here.
    }
    router.push('/dashboard');
  };

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((value) => value !== id) : [...list, id]);

  return (
    <div className="flex min-h-dvh flex-col bg-muted/30">
      <header className="flex items-center gap-3 px-4 py-4 sm:px-8">
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <BrandMark className="size-7" />
          {brand.name}
        </span>
        <ol className="mx-auto hidden items-center gap-2 md:flex" aria-label="Setup steps">
          {STEPS.map((label, index) => (
            <li key={label} className="flex items-center gap-2 text-xs">
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold transition-colors',
                  index < step ? 'border-primary bg-primary text-primary-foreground' : index === step ? 'border-primary text-primary' : 'text-muted-foreground',
                )}
                aria-current={index === step ? 'step' : undefined}
              >
                {index < step ? <Check className="size-3" /> : index + 1}
              </span>
              <span className={cn(index === step ? 'font-medium text-foreground' : 'text-muted-foreground')}>{label}</span>
              {index < STEPS.length - 1 ? <span className="h-px w-6 bg-border" aria-hidden /> : null}
            </li>
          ))}
        </ol>
        {step < 4 ? (
          <Button variant="ghost" size="sm" className="ml-auto md:ml-0" onClick={() => void skip()}>
            Skip for now
          </Button>
        ) : (
          <span className="ml-auto w-16 md:ml-0" />
        )}
      </header>
      <div className="h-0.5 bg-border md:hidden">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
      </div>

      <main className="flex flex-1 items-start justify-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-3xl">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              initial={reduce ? false : { opacity: 0, x: 24 * direction }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: -24 * direction }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col gap-8"
            >
              {step === 0 ? (
                <>
                  <Title eyebrow="Welcome" title={`Hi${displayName.trim().length > 0 ? `, ${displayName.trim().split(' ')[0]}` : ''}. Let’s set up your studio.`} body="Four quick questions, then we build your first workflow from the answers. You can change everything later." />
                  <div className="flex max-w-sm flex-col gap-1.5">
                    <Label htmlFor="onboarding-name">What should we call you?</Label>
                    <Input id="onboarding-name" value={displayName} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus />
                  </div>
                  <div className="flex flex-col gap-3">
                    <p className="text-sm font-medium">What brings you here?</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {ROLES.map((option) => (
                        <Tile key={option.id} selected={role === option.id} onClick={() => setRole(option.id)} icon={<option.icon className="size-4" />} title={option.title} body={option.body} />
                      ))}
                    </div>
                  </div>
                </>
              ) : null}

              {step === 1 ? (
                <>
                  <Title eyebrow="Your tools" title="Where does the work start?" body="Pick the places tickets come from. The first one becomes your workflow’s trigger." />
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {SOURCES.map((source) => (
                      <SmallTile
                        key={source.id}
                        selected={sources.includes(source.id)}
                        onClick={() => setSources((list) => toggle(list, source.id))}
                        icon={source.app === null ? source.icon === undefined ? null : <source.icon className="size-4" /> : <AppMark connector={source.app} size={16} />}
                        label={source.label}
                        order={sources.indexOf(source.id)}
                      />
                    ))}
                  </div>
                  <div className="flex flex-col gap-3">
                    <p className="text-sm font-medium">Who should hear when a pull request is ready?</p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {DESTINATIONS.map((destination) => (
                        <SmallTile
                          key={destination.id}
                          selected={destinations.includes(destination.id)}
                          onClick={() => setDestinations((list) => toggle(list, destination.id))}
                          icon={<AppMark connector={destination.app} size={16} />}
                          label={destination.label}
                        />
                      ))}
                    </div>
                  </div>
                </>
              ) : null}

              {step === 2 ? (
                <>
                  <Title eyebrow="Your agents" title="Who does the work?" body={`${brand.name} runs the coding agents you already pay for, signed in on your own machine. No API keys.`} />
                  <div className="grid gap-3">
                    {AGENTS.map((option) => (
                      <Tile
                        key={option.id}
                        selected={agents === option.id}
                        onClick={() => setAgents(option.id)}
                        icon={
                          <span className="flex -space-x-1.5">
                            {option.marks.map((mark) => (
                              <span key={mark} className="flex size-6 items-center justify-center rounded-md border bg-background">
                                <AppMark connector={mark} size={13} />
                              </span>
                            ))}
                          </span>
                        }
                        title={option.title}
                        body={option.body}
                        badge={option.badge}
                      />
                    ))}
                  </div>
                  <div className="flex flex-col gap-3">
                    <p className="text-sm font-medium">How hard should they look?</p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      {REVIEWS.map((option) => (
                        <Tile key={option.id} selected={review === option.id} onClick={() => setReview(option.id)} title={option.title} body={option.body} compact />
                      ))}
                    </div>
                  </div>
                  <div className="flex max-w-sm flex-col gap-1.5">
                    <Label htmlFor="onboarding-repo">Which repository? (optional)</Label>
                    <Input id="onboarding-repo" value={repo} onChange={(event) => setRepository(event.target.value)} placeholder="your-org/your-repo" aria-invalid={!repoValid} />
                    <p className={cn('text-xs', repoValid ? 'text-muted-foreground' : 'text-destructive')}>{repoValid ? 'Owner and name, as on GitHub. New workflows attach to it.' : 'Use owner/name, like acme/api.'}</p>
                  </div>
                </>
              ) : null}

              {step === 3 ? (
                <>
                  <Title eyebrow="First workflow" title="Start with something that works" body="We drafted one from your answers. Pick it, a template, or describe your own in a sentence." />
                  <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
                    <div className="flex flex-col gap-3">
                      <Option selected={choice === 'made'} onClick={() => setChoice('made')} icon={<Sparkles className="size-4" />} title="Made for you" body={sentence} badge="From your answers" />
                      {ranked.map((template) => (
                        <Option key={template.id} selected={choice === template.id} onClick={() => setChoice(template.id)} icon={<LayoutDashboard className="size-4" />} title={template.name} body={template.description} />
                      ))}
                      <Option selected={choice === 'describe'} onClick={() => setChoice('describe')} icon={<PencilLine className="size-4" />} title="Describe it in a sentence" body="Type what should happen and watch the graph build itself." />
                      {choice === 'describe' ? (
                        <DescribeWorkflowComposer value={described.text} onChange={(text, result) => setDescribed({ text, workflow: result?.workflow ?? null })} repository={effectiveRepo} autoFocus showPreview={false} />
                      ) : null}
                      <Option selected={choice === 'blank'} onClick={() => setChoice('blank')} icon={<FilePlus2 className="size-4" />} title="A blank canvas" body="Just a manual trigger. Build it node by node." />
                    </div>
                    <aside className="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
                      <p className="text-xs font-medium text-muted-foreground">Preview</p>
                      {pick?.workflow ? (
                        <>
                          <GraphThumbnail workflow={pick.workflow} className="h-44" />
                          <p className="text-sm font-medium">{pick.workflow.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {pick.workflow.nodes.length} nodes · agents: {agents === 'both' ? 'Claude Code + Codex' : agents === 'claude' ? 'Claude Code' : 'Codex'} · {review} review
                          </p>
                        </>
                      ) : (
                        <div className="flex h-44 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">Describe a workflow to see it here</div>
                      )}
                      {guestWork.length > 0 ? (
                        <div className="mt-2 flex flex-col gap-2 rounded-lg border bg-card p-3">
                          <p className="text-xs font-medium">Also bring from this browser</p>
                          {guestWork.map((workflow) => (
                            <label key={workflow.id} className="flex items-center gap-2 text-xs">
                              <Checkbox
                                checked={chosenImports.has(workflow.id)}
                                onCheckedChange={(checked) => {
                                  const next = new Set(chosenImports);
                                  if (checked === true) next.add(workflow.id);
                                  else next.delete(workflow.id);
                                  setImportIds(next);
                                }}
                              />
                              <span className="truncate">{workflow.name}</span>
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </aside>
                  </div>
                </>
              ) : null}

              {step === 4 && created !== null ? <Ready workflow={created} onOpen={() => router.push(`/workflows/${created.id}`)} /> : null}
            </motion.div>
          </AnimatePresence>

          {step < 4 ? (
            <div className="mt-10 flex items-center justify-between gap-3 border-t pt-6">
              <Button variant="ghost" onClick={() => go(step - 1)} disabled={step === 0 || saving}>
                <ArrowLeft data-icon="inline-start" /> Back
              </Button>
              {step < 3 ? (
                <Button size="lg" onClick={() => go(step + 1)} disabled={!canContinue}>
                  Continue <ArrowRight data-icon="inline-end" />
                </Button>
              ) : (
                <Button size="lg" onClick={() => void finish()} disabled={!canContinue || saving}>
                  {saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
                  Create my workflow
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function Ready({ workflow, onOpen }: { workflow: Workflow; onOpen: () => void }) {
  const brand = useBrand();
  const command = `npm install -g github:aydinmrnv/relay && ${brand.slug} connect`;
  return (
    <div className="flex flex-col items-center gap-8 text-center">
      <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 18 }} className="flex size-14 items-center justify-center rounded-2xl bg-success/15 text-success">
        <Check className="size-7" />
      </motion.span>
      <Title eyebrow="All set" title={`“${workflow.name}” is ready`} body="It is saved to your account and paused until you switch it on. Test-run it for free; every phase plays back on the canvas." center />
      <GraphThumbnail workflow={workflow} className="h-40 w-full max-w-md" />
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="lg" onClick={onOpen}>
          Open it in the builder <ArrowRight data-icon="inline-end" />
        </Button>
        <Button size="lg" variant="outline" nativeButton={false} render={<Link href="/dashboard" />}>
          Go to the dashboard
        </Button>
      </div>
      <div className="flex w-full max-w-xl flex-col gap-2 rounded-xl border bg-card p-4 text-left">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Laptop className="size-4 text-primary" /> Optional: run it for real on your machine
        </p>
        <p className="text-xs text-muted-foreground">In the repository you want the agents to work on, run this. It pairs the studio with your machine, signs in Claude Code and Codex, and turns test runs into real ones.</p>
        <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 font-mono text-xs">
          <span className="flex-1 truncate">{command}</span>
          <CopyButton value={command} />
        </div>
      </div>
    </div>
  );
}

function Title({ eyebrow, title, body, center = false }: { eyebrow: string; title: string; body: string; center?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-2', center && 'items-center')}>
      <p className="text-xs font-semibold tracking-wide text-primary uppercase">{eyebrow}</p>
      <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h1>
      <p className="max-w-2xl text-pretty text-muted-foreground">{body}</p>
    </div>
  );
}

function Tile({ selected, onClick, icon, title, body, badge, compact = false }: { selected: boolean; onClick: () => void; icon?: React.ReactNode; title: string; body: string; badge?: string; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'flex items-start gap-3 rounded-xl border bg-card text-left transition-all outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50',
        compact ? 'p-3' : 'p-4',
        selected && 'border-primary bg-primary/[0.04] ring-1 ring-primary',
      )}
    >
      {icon === undefined ? null : <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background', selected ? 'text-primary' : 'text-muted-foreground')}>{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          {badge === undefined ? null : <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">{badge}</span>}
        </span>
        <span className="text-xs text-muted-foreground">{body}</span>
      </span>
      <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', selected && 'border-primary bg-primary text-primary-foreground')}>{selected ? <Check className="size-3" /> : null}</span>
    </button>
  );
}

function SmallTile({ selected, onClick, icon, label, order }: { selected: boolean; onClick: () => void; icon: React.ReactNode; label: string; order?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'relative flex flex-col items-center gap-2 rounded-xl border bg-card px-3 py-4 text-center text-sm transition-all outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50',
        selected && 'border-primary bg-primary/[0.04] ring-1 ring-primary',
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-lg border bg-background text-muted-foreground">{icon}</span>
      <span className="font-medium">{label}</span>
      {selected && order === 0 ? <span className="absolute top-1.5 right-1.5 rounded-full bg-primary px-1.5 text-[9px] font-semibold text-primary-foreground">trigger</span> : null}
    </button>
  );
}

function Option({ selected, onClick, icon, title, body, badge }: { selected: boolean; onClick: () => void; icon: React.ReactNode; title: string; body: string; badge?: string }) {
  return <Tile selected={selected} onClick={onClick} icon={icon} title={title} body={body} badge={badge} />;
}

/** The first workflow, described the way someone would say it, from the answers so far. */
function madeForYouSentence(sources: string[], destinations: string[], review: Review, role: Role | null): string {
  const source = SOURCES.find((option) => option.id === sources[0]) ?? SOURCES.find((option) => option.id === (role === 'oss' ? 'github-issues' : 'linear'))!;
  const unattended = source.id !== 'manual';
  const pipeline = review === 'light' ? 'run a quick fix with light review' : review === 'thorough' ? 'run the pipeline with a thorough review' : 'run the pipeline';
  const budget = unattended ? `, stay under $${role === 'learning' ? 2 : 5} a run` : '';
  const allowlist = unattended && role === 'oss' ? ', only for maintainers alice and bob' : '';
  const told = destinations
    .map((id) => DESTINATIONS.find((option) => option.id === id)?.phrase)
    .filter((phrase): phrase is string => phrase !== undefined)
    .slice(0, 2);
  const tail = told.length === 0 ? '' : ` and ${told.join(' and ')}`;
  return `${source.phrase}${allowlist}${budget}, ${pipeline} and open a draft PR${tail}.`;
}

function rankTemplates(sources: string[], destinations: string[]) {
  const wanted = new Set([...sources, ...destinations]);
  return [...TEMPLATES]
    .map((template, index) => ({ template, score: template.connectors.filter((id) => wanted.has(id)).length * 10 - index }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.template);
}

/** Puts the chosen agents and review depth on every pipeline node, so the first workflow matches the answers. */
function withAgents(workflow: Workflow, agents: AgentChoice, review: Review): Workflow {
  const roles =
    agents === 'claude'
      ? { planner: 'claude', planReviewer: 'claude', implementer: 'claude', codeReviewer: 'claude' }
      : agents === 'codex'
        ? { planner: 'codex', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'codex' }
        : { planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' };
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (node.data.typeId === 'pipeline.action.run') return { ...node, data: { ...node.data, config: { ...node.data.config, ...roles, review } } };
      if (node.data.typeId === 'pipeline.action.fast') return { ...node, data: { ...node.data, config: { ...node.data.config, implementer: roles.implementer } } };
      return node;
    }),
  };
}
