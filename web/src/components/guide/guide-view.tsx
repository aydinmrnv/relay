'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  FlaskConical,
  GitPullRequest,
  Hash,
  Keyboard,
  Layers,
  MessageCircleQuestion,
  MousePointerClick,
  Signpost,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { PageHeader } from '@/components/app/page-header';
import { Stagger, StaggerItem } from '@/components/motion/fade-in';
import { useBrand } from '@/hooks/use-brand';
import { useSignedIn } from '@/hooks/use-agent-accounts';
import { useStudio } from '@/lib/store';
import { explain, GLOSSARY_ORDER } from '@/lib/glossary';
import { isMac, keyLabel, SHORTCUTS } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { Reveal } from './reveal';
import { SectionChips, SectionNav, type SectionLink } from './section-nav';
import { WorkflowAnatomy } from './workflow-anatomy';
import { PipelineStepper } from './pipeline-stepper';

const SECTIONS: SectionLink[] = [
  { id: 'start', label: 'Start here', icon: Signpost },
  { id: 'anatomy', label: 'Anatomy of a workflow', icon: WorkflowIcon },
  { id: 'pipeline-inside', label: 'Inside the pipeline', icon: Layers },
  { id: 'concepts', label: 'Concepts', icon: BookOpen },
  { id: 'real-vs-simulated', label: 'Real or simulated', icon: FlaskConical },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard },
  { id: 'faq', label: 'Questions', icon: MessageCircleQuestion },
];
const SECTION_IDS = SECTIONS.map((section) => section.id);

/** Room for the sticky app header (and the chip row on narrow screens) when jumping to an anchor. */
const ANCHOR_OFFSET = 'scroll-mt-28 xl:scroll-mt-20';

const subscribeNothing = () => () => undefined;

export function GuideView() {
  const brand = useBrand();

  return (
    <div className="flex flex-1 flex-col gap-8 p-4 pb-16 md:p-6 md:pb-24">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-8">
        <PageHeader
          title={`How ${brand.name} works`}
          description={`What every part of the studio does, how to get from nothing to a workflow running in your repository, and what is real today. The “?” buttons around the studio link to the entries here.`}
          actions={
            <>
              <Button variant="outline" nativeButton={false} render={<Link href="/settings" />}>
                Settings
              </Button>
              <Button nativeButton={false} render={<Link href="/templates" />}>
                Start from a template <ArrowRight data-icon="inline-end" />
              </Button>
            </>
          }
        />

        <Stagger className="grid gap-3 sm:grid-cols-3">
          {[
            { icon: MousePointerClick, title: 'Design it here', body: 'A workflow is a diagram you drag together here. It is saved to your account, or in this browser if you are a guest.' },
            { icon: FlaskConical, title: 'Test it for free', body: 'A test run plays it back with simulated agents, costs and refusals. Nothing is called and nothing is billed.' },
            { icon: GitPullRequest, title: 'Run it in your repository', body: 'Export writes the config and a GitHub Actions workflow. It runs on your own minutes, with your own subscriptions.' },
          ].map((fact) => (
            <StaggerItem key={fact.title} className="relative overflow-hidden rounded-xl border bg-card p-4">
              <div aria-hidden className="pointer-events-none absolute -top-10 -right-10 size-28 rounded-full bg-primary/10 blur-2xl" />
              <fact.icon className="size-4 text-primary" aria-hidden />
              <p className="mt-3 text-sm font-medium">{fact.title}</p>
              <p className="mt-1 text-sm text-pretty text-muted-foreground">{fact.body}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </div>

      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_13rem]">
        <div className="grid min-w-0 grid-cols-1 gap-16">
          <SectionChips items={SECTIONS} ids={SECTION_IDS} className="-mb-10 xl:hidden" />

          <GuideSection id="start" eyebrow="Start here" title="From nothing to a workflow in your repository" description="Five steps. Each one links to the page where you do it, and ticks itself off once it is done.">
            <StartSteps />
          </GuideSection>

          <GuideSection
            id="anatomy"
            eyebrow="Anatomy of a workflow"
            title="Five nodes, read left to right"
            description="A workflow is one trigger followed by whatever should happen next. Here is a small one, with what each part does and what the coloured dots mean."
          >
            <WorkflowAnatomy />
          </GuideSection>

          <GuideSection
            id="pipeline-inside"
            eyebrow="Inside the pipeline"
            title="What happens between ticket and pull request"
            description="The Agent pipeline node is where the coding agents work. A run goes through these phases in order; the review phases repeat as the review level allows. You can watch them in any run’s timeline."
          >
            <PipelineStepper />
          </GuideSection>

          <GuideSection id="concepts" eyebrow="Concepts" title="Every term, explained once" description="The same explanations the “?” buttons show, in full. Link to any of them with its # anchor.">
            <Concepts productName={brand.name} />
          </GuideSection>

          <GuideSection
            id="real-vs-simulated"
            eyebrow="Real or simulated"
            title="What is real today"
            description="Most of the studio is the real thing. Test runs are played back, so you can design and try a workflow before anything runs or costs money."
          >
            <RealVsSimulated />
          </GuideSection>

          <GuideSection id="shortcuts" eyebrow="Keyboard shortcuts" title="Faster with the keyboard" description="Press ? anywhere to open this list in a dialog. Single-letter shortcuts are ignored while you are typing in a field.">
            <Shortcuts />
          </GuideSection>

          <GuideSection id="faq" eyebrow="Questions" title="Frequently asked" description="Costs, privacy, where things run, and what you get out of it.">
            <Faq productName={brand.name} slug={brand.slug} />
          </GuideSection>
        </div>

        <aside className="hidden xl:block">
          <SectionNav items={SECTIONS} ids={SECTION_IDS} />
        </aside>
      </div>
    </div>
  );
}

function GuideSection({ id, eyebrow, title, description, children }: { id: string; eyebrow: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn('grid min-w-0 grid-cols-1 gap-6', ANCHOR_OFFSET)}>
      <Reveal className="grid max-w-2xl gap-1.5">
        <p className="text-xs font-medium tracking-wide text-primary uppercase">{eyebrow}</p>
        <h2 id={`${id}-title`} className="text-xl font-semibold tracking-tight text-balance">
          {title}
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">{description}</p>
      </Reveal>
      <Reveal delay={0.05}>{children}</Reveal>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function StartSteps() {
  const hydrated = useStudio((state) => state.hydrated);
  const workflows = useStudio((state) => state.workflows);
  const runCount = useStudio((state) => state.runs.length);
  const signedIn = useSignedIn();

  // Ticks only mean something once this browser's data has been read.
  const list = Object.values(workflows);
  const done = {
    agents: signedIn.claude === true || signedIn.codex === true,
    template: hydrated && list.some((workflow) => workflow.templateId !== undefined),
    build: hydrated && list.length > 0,
    test: hydrated && runCount > 0,
    export: hydrated && list.some((workflow) => workflow.exportedAt !== undefined),
  };

  const steps: Array<{ key: keyof typeof done; title: string; body: string; href: string; cta: string; extra?: { href: string; label: string } }> = [
    {
      key: 'agents',
      title: 'Connect your machine and sign in your agents',
      body: 'Run relay connect in your repository and open the link it prints. Then sign in Claude Code with your Claude plan and Codex with your ChatGPT plan: the studio starts each CLI’s own login on your machine and never sees a token.',
      href: '/connect',
      cta: 'Connect your machine',
      extra: { href: '/settings#agents', label: 'Settings → Coding agents' },
    },
    {
      key: 'template',
      title: 'Pick a template',
      body: 'Start from a ready-made workflow such as Ticket to pull request, or a blank canvas. Using a template copies it; the original never changes.',
      href: '/templates',
      cta: 'Browse templates',
    },
    {
      key: 'build',
      title: 'Shape it in the builder',
      body: 'Drag nodes from the palette, wire ports whose colours fit, and fill in each node in the inspector. Validation points at problems as you go.',
      href: '/workflows',
      cta: 'Open your workflows',
      extra: { href: '/integrations', label: 'Connect the apps it uses' },
    },
    {
      key: 'test',
      title: 'Run a test',
      body: 'Press Test run in the builder. It plays back with the same phases, budgets and refusals a real run has, costs nothing, and is recorded under Runs.',
      href: '/runs',
      cta: 'See your runs',
    },
    {
      key: 'export',
      title: 'Export it to your repository',
      body: 'Export in the builder downloads a .zip with the config, a GitHub Actions workflow and a SETUP.md. Unzip it into the repository, add the secrets it lists, and it runs on your own minutes.',
      href: '/workflows',
      cta: 'Choose a workflow to export',
      extra: { href: '/settings#credentials', label: 'Pick subscription or API key first' },
    },
  ];

  return (
    <ol className="grid gap-3">
      {steps.map((step, index) => {
        const complete = done[step.key];
        return (
          <li key={step.key} className="group relative flex gap-4 rounded-xl border bg-card p-4 transition-colors hover:border-primary/30">
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums transition-colors',
                complete ? 'bg-success/15 text-success' : 'bg-primary/10 text-primary',
              )}
              aria-label={complete ? `Step ${index + 1}, done` : `Step ${index + 1}`}
            >
              {complete ? <Check className="size-4" aria-hidden /> : index + 1}
            </span>
            <div className="grid min-w-0 flex-1 gap-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {step.title}
                {complete ? (
                  <Badge variant="outline" className="h-5 border-success/30 bg-success/10 text-[10px] text-success">
                    Done
                  </Badge>
                ) : null}
              </p>
              <p className="text-sm text-pretty text-muted-foreground">{step.body}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <Link href={step.href} className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline">
                  {step.cta} <ArrowRight className="size-3.5" aria-hidden />
                </Link>
                {step.extra === undefined ? null : (
                  <Link href={step.extra.href} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    {step.extra.label}
                  </Link>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */

function Concepts({ productName }: { productName: string }) {
  const entries = GLOSSARY_ORDER.map((term) => explain(term, productName));
  return (
    <div className="grid gap-5">
      <nav aria-label="Jump to a concept" className="flex flex-wrap gap-1.5">
        {entries.map((entry) => (
          <a
            key={entry.term}
            href={`#${entry.term}`}
            className="inline-flex h-7 items-center rounded-full border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            {entry.title}
          </a>
        ))}
      </nav>
      <div className="grid gap-3 md:grid-cols-2">
        {entries.map((entry) => (
          <article
            key={entry.term}
            id={entry.term}
            aria-labelledby={`${entry.term}-title`}
            className={cn(
              'group/concept flex flex-col gap-2 rounded-xl border bg-card p-4 transition-[border-color,box-shadow] duration-300 target:border-primary/50 target:ring-3 target:ring-primary/15',
              ANCHOR_OFFSET,
            )}
          >
            <h3 id={`${entry.term}-title`} className="flex items-center gap-1.5 text-sm font-semibold">
              {entry.title}
              <a
                href={`#${entry.term}`}
                aria-label={`Link to ${entry.title}`}
                className="text-muted-foreground/0 transition-colors group-hover/concept:text-muted-foreground/70 hover:text-foreground! focus-visible:text-foreground"
              >
                <Hash className="size-3.5" aria-hidden />
              </a>
            </h3>
            <p className="text-sm text-pretty">{entry.short}</p>
            <p className="text-sm text-pretty text-muted-foreground">{entry.long}</p>
            {entry.href === undefined ? null : (
              <Link href={entry.href} className="mt-auto inline-flex items-center gap-1 pt-1 text-xs font-medium text-primary underline-offset-4 hover:underline">
                Show me <ArrowRight className="size-3" aria-hidden />
              </Link>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

type Reality = 'real' | 'simulated' | 'later';

const REALITY: Array<{ what: string; status: Reality; detail: string }> = [
  { what: 'The catalog, the canvas and validation', status: 'real', detail: 'Every node and rule you see is the one the export and the CLI use.' },
  { what: 'The compiler and its files', status: 'real', detail: 'Export produces a config, an Actions workflow and a SETUP.md you can commit today.' },
  { what: 'Signing in to Claude Code and Codex', status: 'real', detail: 'Through relay connect: runs the vendors’ own CLI logins on your machine and reads their status.' },
  { what: 'Running a workflow on your machine', status: 'real', detail: 'Through relay connect: the pipeline runs in your repository with your sign-ins and streams back to the canvas.' },
  { what: 'Installing an export into your repository', status: 'real', detail: 'Through relay connect, or by unzipping the download yourself.' },
  { what: 'An exported workflow running in your repository', status: 'real', detail: 'Runs on GitHub Actions with your own minutes and subscriptions.' },
  { what: 'Accounts, sync, share links and version history', status: 'real', detail: 'Kept in the studio’s database. As a guest, everything stays in this browser instead.' },
  { what: 'Describe-to-workflow and the spend forecast', status: 'real', detail: 'The sentence parser runs in your browser with no model call. The forecast is built from simulated runs, so it is an estimate.' },
  { what: 'Renaming the product, importing and exporting your data', status: 'real', detail: 'Stored in your account or this browser; the export is a plain JSON file.' },
  { what: 'Test runs', status: 'simulated', detail: 'Phases, review rounds, costs, refusals and pull request numbers are played back, seeded per workflow.' },
  { what: 'Connections to apps', status: 'simulated', detail: '“Connect” marks an app as ready so you can design against the whole catalog. No app is signed in to; an export uses your repository’s secrets.' },
  { what: 'Human approvals', status: 'simulated', detail: 'In a test run, an approval gate approves itself after a short pause.' },
  { what: 'Hosted and self-hosted runners', status: 'later', detail: 'Your own machine and your own GitHub Actions are what exist today. The others are shown in Settings as “later”.' },
];

const REALITY_BADGE: Record<Reality, { label: string; className: string }> = {
  real: { label: 'Real', className: 'border-success/30 bg-success/10 text-success' },
  simulated: { label: 'Simulated', className: 'border-warning/40 bg-warning/10 text-amber-700 dark:text-warning' },
  later: { label: 'Not built yet', className: 'text-muted-foreground' },
};

function RealVsSimulated() {
  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="w-[38%] pl-4">What</TableHead>
            <TableHead className="w-28">Status</TableHead>
            <TableHead className="pr-4">What that means</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {REALITY.map((row) => (
            <TableRow key={row.what}>
              <TableCell className="pl-4 align-top font-medium whitespace-normal">{row.what}</TableCell>
              <TableCell className="align-top">
                <Badge variant="outline" className={cn('h-5 text-[11px]', REALITY_BADGE[row.status].className)}>
                  {REALITY_BADGE[row.status].label}
                </Badge>
              </TableCell>
              <TableCell className="pr-4 align-top text-pretty whitespace-normal text-muted-foreground">{row.detail}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Shortcuts() {
  // The platform decides ⌘ versus Ctrl; the server renders Ctrl and the client corrects it.
  const mac = useSyncExternalStore(subscribeNothing, isMac, () => false);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {SHORTCUTS.map((group) => (
        <div key={group.group} className="rounded-xl border bg-card p-4">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.group}</p>
          <ul className="mt-3 grid gap-2">
            {group.items.map((shortcut) => (
              <li key={shortcut.what} className="flex items-center justify-between gap-4 text-sm">
                <span className="text-pretty">{shortcut.what}</span>
                <KbdGroup className="shrink-0">
                  {shortcut.keys.map((key) => (
                    <Kbd key={key}>{keyLabel(key, mac)}</Kbd>
                  ))}
                </KbdGroup>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Faq({ productName, slug }: { productName: string; slug: string }) {
  const link = 'font-medium text-foreground underline underline-offset-4';
  const items: Array<{ id: string; question: string; answer: React.ReactNode }> = [
    {
      id: 'cost',
      question: 'Does any of this cost money?',
      answer: (
        <p>
          The studio does not: it runs in your browser and test runs call nothing. Exported workflows run on your repository’s own GitHub Actions minutes, which are free on public repositories and come out of your
          plan’s included minutes on private ones (3,000 a month with GitHub Pro). Model usage counts against the Claude and ChatGPT subscriptions you already pay for, or against your API keys if you choose those.
        </p>
      ),
    },
    {
      id: 'data',
      question: 'Where is my data kept?',
      answer: (
        <p>
          With an account, in the studio’s database: workflows, runs, connections, the product name and your settings, so they follow you to any browser. Values typed into secret fields stay in the browser they were typed in, and your code is never stored. As a guest, all of it stays in this browser’s local storage. Download everything, import it elsewhere or start over under{' '}
          <Link href="/settings#data" className={link}>
            Settings → Your data
          </Link>
          ; delete your account under{' '}
          <Link href="/settings#account" className={link}>
            Settings → Account
          </Link>
          .
        </p>
      ),
    },
    {
      id: 'credentials',
      question: 'Does the studio see my Claude or ChatGPT credentials?',
      answer: (
        <p>
          No. Signing in runs the vendor’s own CLI login on your machine, through relay connect, and the credential lands in the CLI exactly as if you had signed in from a terminal. The studio only asks the CLI
          whether it is signed in and gets back the method, plan and account label. An authorization code you paste is handed straight to the CLI and not kept.
        </p>
      ),
    },
    {
      id: 'where',
      question: 'Where do runs actually execute?',
      answer: (
        <p>
          Test runs execute nowhere: they are played back in this tab. Real runs execute in one of two places. On your machine, when you start one from the builder with relay connect running: the pipeline works
          in your repository with your own sign-ins and streams back here. Or on GitHub Actions in your repository, once you export a workflow and commit its files: the Action installs Claude Code and Codex on
          a GitHub runner and runs the pipeline there, unattended. Hosted and self-hosted runners are planned, not built.
        </p>
      ),
    },
    {
      id: 'export',
      question: 'What exactly does Export produce?',
      answer: (
        <>
          <p>Four plain-text files you can read before committing — installed straight into your repository by relay connect, or as one .zip that unzips at its root:</p>
          <ul className="mb-3 grid gap-1 pl-4 [&>li]:list-disc">
            <li>
              <span className="font-mono text-xs">.relay/config.json</span>: what the CLI reads.
            </li>
            <li>
              <span className="font-mono text-xs">.github/workflows/&lt;workflow&gt;.yml</span>: the GitHub Actions workflow that runs it.
            </li>
            <li>
              <span className="font-mono text-xs">SETUP.md</span>: the secrets to add, and how.
            </li>
            <li>
              <span className="font-mono text-xs">{slug}-workflow.json</span>: the graph itself, which you can import again.
            </li>
          </ul>
          <p>Anything the canvas can express but those files cannot is listed as a warning in the export, never dropped silently.</p>
        </>
      ),
    },
    {
      id: 'costs-real',
      question: 'Are the costs in test runs real?',
      answer: (
        <p>
          No. They are drawn from realistic ranges for each phase, so budget gates refuse where they would. In a real run the cost is what Claude Code and Codex report for each turn, summed per phase. On a
          subscription nothing extra is billed, but the number is still what the budget gate compares.
        </p>
      ),
    },
    {
      id: 'merge',
      question: 'Can a workflow merge on its own?',
      answer: (
        <p>
          Only when a person started the run. A ticket assignment, a label, a schedule or a webhook is an unattended start, and unattended runs stop at a pull request. The validator will not let you export anything
          else, and the export caps delivery at a pull request as well.
        </p>
      ),
    },
    {
      id: 'keys',
      question: 'Do I need API keys?',
      answer: (
        <p>
          No. Claude Code signs in with your Claude subscription and Codex with your ChatGPT subscription. For GitHub Actions each vendor has a supported way to carry a personal plan into CI. API keys remain an
          option for either agent under{' '}
          <Link href="/settings#credentials" className={link}>
            Settings → Running &amp; exporting
          </Link>
          .
        </p>
      ),
    },
    {
      id: 'name',
      question: `Why is it called ${productName}?`,
      answer: (
        <p>
          It might not be. The name is one field under{' '}
          <Link href="/settings#general" className={link}>
            Settings → General
          </Link>
          ; every screen, slug, trigger label and export follows it.
        </p>
      ),
    },
  ];

  return (
    <Accordion multiple className="rounded-xl border bg-card px-4">
      {items.map((item) => (
        <AccordionItem key={item.id} value={item.id}>
          <AccordionTrigger className="py-3.5 text-[15px] hover:no-underline">{item.question}</AccordionTrigger>
          <AccordionContent className="pb-4 text-pretty text-muted-foreground">{item.answer}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
