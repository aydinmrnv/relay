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
  Laptop,
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
import { RichText } from '@/components/app/rich-text';
import { Stagger, StaggerItem } from '@/components/motion/fade-in';
import { useBrand } from '@/hooks/use-brand';
import { useSignedIn } from '@/hooks/use-agent-accounts';
import { useStudio } from '@/lib/store';
import { explain, GLOSSARY_ORDER } from '@/lib/glossary';
import { isMac, keyLabel, SHORTCUTS } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { RunnerCompare } from '@/components/companion/runner-compare';
import { Reveal } from './reveal';
import { SectionChips, SectionNav, type SectionLink } from './section-nav';
import { WorkflowAnatomy } from './workflow-anatomy';
import { PipelineStepper } from './pipeline-stepper';

const SECTIONS: SectionLink[] = [
  { id: 'start', label: 'Start here', icon: Signpost },
  { id: 'anatomy', label: 'Anatomy of a workflow', icon: WorkflowIcon },
  { id: 'pipeline-inside', label: 'Inside the pipeline', icon: Layers },
  { id: 'runners', label: 'Where runs happen', icon: Laptop },
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
            { icon: MousePointerClick, title: 'Design it here', body: 'A workflow is a diagram you drag together here. It is saved to your account, so it is there in any browser you sign in to.' },
            { icon: FlaskConical, title: 'Test it for free', body: 'A test run plays it back with simulated agents, costs and refusals. Nothing is called and nothing is billed.' },
            { icon: GitPullRequest, title: 'Run it for real', body: 'On your own computer through relay connect, or exported as a GitHub Actions workflow that a label on an issue starts. Either way, your own subscriptions do the work.' },
          ].map((fact) => (
            <StaggerItem key={fact.title} className="border-t pt-4">
              <fact.icon className="size-4 text-muted-foreground" aria-hidden />
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
            id="runners"
            eyebrow="Where runs happen"
            title="Your computer, or Relay Cloud"
            description="A real run happens wherever your coding agents are signed in, and there are two runners for that. Everything else about the run is the same, so the only real question is which machine should do the work."
          >
            <RunnerCompare />
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
            <Faq slug={brand.slug} />
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
        <p className="font-mono text-xs text-muted-foreground">{eyebrow}</p>
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
      title: 'Choose where your agents run, then sign them in',
      body: 'A real run needs the coding agents somewhere to run: on your own computer through relay connect, or on a machine Relay runs for you in Relay Cloud. Then sign in Claude Code with your Claude plan and Codex with your ChatGPT plan — the studio starts each CLI’s own login and never sees a token.',
      href: '/runners',
      cta: 'Your computer or Relay Cloud?',
      extra: { href: '/settings#agents', label: 'Settings → Coding agents' },
    },
    {
      key: 'template',
      title: 'Pick a template',
      body: 'Start from a ready-made workflow such as Fix main when CI goes red, or a blank canvas. Using a template copies it; the original never changes.',
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
          <li key={step.key} className="group relative flex gap-4 border-t py-4 first:border-t-0">
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums transition-colors',
                complete ? 'bg-success/15 text-success' : 'border text-foreground',
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
                <Link href={step.href} className="inline-flex items-center gap-1 text-sm font-medium text-signal underline-offset-4 hover:underline">
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
            className="inline-flex h-7 items-center rounded-full border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            {entry.title}
          </a>
        ))}
      </nav>
      <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
        {entries.map((entry) => (
          <article
            key={entry.term}
            id={entry.term}
            aria-labelledby={`${entry.term}-title`}
            className={cn(
              'group/concept flex flex-col gap-2 border-t pt-4 transition-colors duration-300 target:border-signal',
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
            <RichText text={entry.short} className="text-sm text-pretty" />
            <RichText text={entry.long} className="text-sm text-pretty text-muted-foreground" />
            {entry.href === undefined ? null : (
              <Link href={entry.href} className="mt-auto inline-flex items-center gap-1 pt-1 text-xs font-medium text-signal underline-offset-4 hover:underline">
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
  { what: 'The compiler and its files', status: 'real', detail: 'Export produces a config, an Actions workflow and a SETUP.md you can commit today. Steps the Action cannot decide are left out, and the export lists them.' },
  { what: 'Signing in to Claude Code and Codex', status: 'real', detail: 'Through the runner: runs the vendors’ own CLI logins on your computer, or on your machine in Relay Cloud, and reads their status.' },
  { what: 'Running a workflow for real', status: 'real', detail: 'On your computer, through relay connect or relay workflow run: every step, as drawn. The guardrails decide, the conditions are evaluated, the pipeline runs in the repository with your own sign-ins, and the steps after it post where they say. A Relay Cloud machine runs the pipeline and its delivery.' },
  { what: 'Human approval, Conditions, Filters, the AI step, waits and the cost estimate', status: 'real', detail: 'Performed in a real run. An approval waits for a person: answered in the run panel, or with relay workflow approve. A Filter is evaluated the same way in a test run. The exported Action still does not perform them.' },
  { what: 'A run started by a webhook, a schedule or a label', status: 'real', detail: 'relay workflow serve keeps the trigger on a machine of your own: it listens for the incoming webhook (signed deliveries, when a secret is set), keeps the clock for a schedule, and watches for a label on a GitHub issue.' },
  { what: 'A run started by GitHub, Linear or Sentry', status: 'real', detail: 'relay workflow serve reads the webhooks those apps send, signed with the secret you gave them: an issue assigned or labelled, a build gone red, a security alert, a new error. Written against the apps’ documented deliveries; a delivery it does not recognise starts nothing and says why.' },
  { what: 'Steps in Slack, Discord, GitHub and Linear, and HTTP requests', status: 'real', detail: 'Posted through a Slack or Discord webhook, done with gh, done through Linear’s API with your key, or sent to the URL. Each reads its credential from the runner’s environment; none is written into the workflow.' },
  { what: 'Installing an export into your repository', status: 'real', detail: 'Through relay connect on your computer, or by unzipping the download yourself.' },
  { what: 'An exported workflow running in your repository', status: 'real', detail: 'Runs on GitHub Actions with your own minutes and subscriptions, started by a label on an issue. The Action runs the pipeline and the steps it can place; it does not make the decisions the canvas draws.' },
  { what: 'Accounts, sync, share links and version history', status: 'real', detail: 'Kept in the studio’s database, under your account.' },
  { what: 'Describe-to-workflow and the spend forecast', status: 'real', detail: 'The sentence parser runs in your browser with no model call. The forecast is built from simulated runs, so it is an estimate.' },
  { what: 'Importing and exporting your data', status: 'real', detail: 'Everything in your account as one plain JSON file, and back again.' },
  { what: 'Slack and Discord connections', status: 'real', detail: 'A webhook you paste is checked with the app and kept encrypted. The studio posts test messages through it; an exported workflow posts with the same URL held as a secret in its repository.' },
  { what: 'Signing in to other apps with a key or token', status: 'real', detail: 'Linear, Notion, Sentry, Vercel and the other apps that take one pasted token: the app confirms whose it is, and the studio keeps it encrypted and asks again from the dashboard. A run does not act through it yet; it still reads its credentials from the runner’s environment.' },
  { what: 'Test runs', status: 'simulated', detail: 'Phases, review rounds, costs, refusals and pull request numbers are played back, seeded per workflow.' },
  { what: 'Steps in every other app', status: 'simulated', detail: 'Connected or marked ready, you can design against the whole catalog; “Mark ready” records a label and signs in to nothing. In a real run each such step is handed to a bridge of your own (BRIDGE_WEBHOOK_URL: n8n, a Zapier catch hook, your server), or skipped, and the run says which.' },
  { what: 'A run started by any other app’s own events', status: 'later', detail: 'Nothing reads Zendesk, Slack, LaunchDarkly, Jira or the other CI services yet. Point the app’s webhook at an Incoming webhook trigger, which is real, or start the workflow by hand.' },
  { what: 'Transform, and approvals asked in Slack or by email', status: 'later', detail: 'Transform passes its payload through unchanged. An approval is answered in the studio or at a terminal, not from a chat message.' },
  { what: 'A runner in your own network, or one isolated VM per exported run', status: 'later', detail: 'A machine of your own can join Relay Cloud by hand; the studio does not offer it. Exporting to GitHub Actions is what runs unattended today.' },
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

function Faq({ slug }: { slug: string }) {
  const link = 'font-medium text-foreground underline underline-offset-4';
  const items: Array<{ id: string; question: string; answer: React.ReactNode }> = [
    {
      id: 'cost',
      question: 'Does any of this cost money?',
      answer: (
        <p>
          The studio is free while in beta, and test runs call nothing. Exported workflows run on your repository’s own GitHub Actions minutes, which are free on public repositories and come out of your plan’s
          included minutes on private ones. Model usage counts against the Claude and ChatGPT subscriptions you already pay for, or against your API keys if you choose those.
        </p>
      ),
    },
    {
      id: 'data',
      question: 'Where is my data kept?',
      answer: (
        <p>
          In the studio’s database, under your account: workflows and their saved versions, runs, connections, your settings and your onboarding answers, so they follow you to any browser. A webhook or API token you connect an app with is kept encrypted. Values typed into a node’s secret fields stay in the browser they were typed in, and are left out of exports. The studio’s servers never receive your code: the agents work in a checkout on the runner you picked — your own computer, your Relay Cloud machine, or a GitHub runner — and only the workflow and the run’s record come back. Download everything, import it elsewhere or start over under{' '}
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
          No. Signing in runs the vendor’s own CLI login on your runner — your computer through relay connect, or your Relay Cloud machine — and the credential lands in the CLI there, exactly as if you had signed in from a terminal. The studio only asks the CLI
          whether it is signed in and gets back the method, plan and account label. An authorization code you paste is handed straight to the CLI and not kept.
        </p>
      ),
    },
    {
      id: 'where',
      question: 'Where do runs actually execute?',
      answer: (
        <p>
          In one of three places. <strong>Your computer</strong>, through relay connect: the pipeline works in your repository with your own sign-ins and streams back here.{' '}
          <strong>Relay Cloud</strong>, where it is offered (an invite-only beta): the same run, on a machine of yours that Relay makes and puts to sleep, reached with your account instead of a loopback pairing.{' '}
          <strong>Your repository’s GitHub Actions</strong>, once you export a workflow and commit its files: the Action installs Claude Code and Codex on a GitHub runner and runs the pipeline there, unattended, on your own minutes (free on public repositories). The first two are{' '}
          <Link href="/runners" className={link}>
            runners
          </Link>
          , and you pick one; the third is what a label on a GitHub issue starts today. Test runs execute nowhere: they are played back in this tab.
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
          <p>
            The Action is narrower than the canvas: it works on one GitHub issue per run, and cannot evaluate a Condition or wait for an approval. A step it cannot decide is left out of the workflow file, and the
            export names every one in its warnings. The CLI is not narrower: <span className="font-mono text-xs">relay workflow run</span> performs the workflow as drawn, and{' '}
            <span className="font-mono text-xs">relay workflow serve</span> keeps its trigger on a machine of your own.
          </p>
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
          No. A run started from the studio, and a run a label starts in GitHub Actions, both go as far as a pull request and stop: the validator will not let you export anything else, and the export caps delivery
          at a pull request as well. The CLI can merge only when you run it yourself in a terminal and ask for it.
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
