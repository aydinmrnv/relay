'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Blocks, Eye, GitPullRequestArrow, Lock, ShieldCheck, Sparkles, Wallet, Workflow } from 'lucide-react';
import { Hero7 } from '@/components/hero7';
import { Logos3 } from '@/components/logos3';
import { Feature43 } from '@/components/feature43';
import { Feature1 } from '@/components/feature1';
import { Pricing2 } from '@/components/pricing2';
import { Faq3 } from '@/components/faq3';
import { Cta4 } from '@/components/cta4';
import { Footer7 } from '@/components/footer7';
import { Changelog1 } from '@/components/changelog1';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ShimmerButton } from '@/components/watermelon/shimmer-button';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { BrandMark } from '@/components/app/brand-mark';
import { useBrand } from '@/hooks/use-brand';
import { CATALOG_STATS, CONNECTORS } from '@/lib/connectors';
import { PipelinePreview } from './pipeline-preview';

export function Landing() {
  const brand = useBrand();
  const router = useRouter();
  const marquee = CONNECTORS.filter((connector) => connector.category !== 'core').slice(0, 48);

  return (
    <main className="flex flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="container flex h-14 items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <BrandMark className="size-7" />
            <span className="font-semibold tracking-tight">{brand.name}</span>
            <Badge variant="secondary" className="ml-1 hidden sm:inline-flex">
              prototype
            </Badge>
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#how" className="hover:text-foreground">
              How it works
            </a>
            <a href="#integrations" className="hover:text-foreground">
              Integrations
            </a>
            <a href="#pricing" className="hover:text-foreground">
              Pricing
            </a>
            <a href="#faq" className="hover:text-foreground">
              FAQ
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/integrations" />}>
              {CATALOG_STATS.connectors} connectors
            </Button>
            <Button size="sm" nativeButton={false} render={<Link href="/dashboard" />}>
              Open the studio
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
        </div>
      </header>

      <Hero7
        className="pb-16 pt-24 lg:pb-20"
        heading={`${brand.name} turns a ticket into a reviewed pull request.`}
        description={`Assign an issue to the bot. Two coding agents plan, challenge each other, implement, review the diff and run your tests inside an isolated worktree. You decide how it delivers and who hears about it, on a canvas you drag together.`}
        buttons={{ primary: { text: 'Open the studio', url: '/dashboard' } }}
        reviews={undefined}
      />
      <div className="container -mt-8 flex flex-col items-center gap-3 pb-8">
        <ShimmerButton className="rounded-full px-5 py-2 text-sm" onClick={() => router.push('/templates')}>
          Start from a template
        </ShimmerButton>
        <p className="text-xs text-muted-foreground">Runs locally in your browser. Nothing is hosted, nothing is billed.</p>
      </div>

      <section id="how" className="container pb-8">
        <PipelinePreview />
      </section>

      <div id="integrations" />
      <Logos3
        className="py-16"
        heading={`${CATALOG_STATS.connectors} apps, ${CATALOG_STATS.triggers} triggers, ${CATALOG_STATS.actions} actions`}
        logos={marquee.map((connector) => ({ alt: connector.name, label: connector.name, icon: <ConnectorIcon connector={connector} size={18} variant="mark" /> }))}
      />

      <Feature43
        className="py-20"
        heading="Agents that check each other, guardrails that refuse by default"
        buttons={{}}
        features={[
          { icon: <Workflow className="size-5" />, title: 'Plan, review, implement, review', description: 'A planner writes the plan; a different model attacks it against the real code. The same happens to the diff. Nothing grades its own homework.' },
          { icon: <Eye className="size-5" />, title: 'Every claim checked against git', description: 'Diffs are computed from the worktree, tests are judged by exit code, cost is what the CLIs report. No chat transcript is treated as evidence.' },
          { icon: <ShieldCheck className="size-5" />, title: 'Refuses first', description: 'Allowlists, per-run and daily budgets, a kill switch re-read before every start. An unattended run can open a PR and can never merge one.' },
          { icon: <Blocks className="size-5" />, title: 'A node for every app', description: `Triggers from Linear, Jira, GitHub, Sentry, Zendesk, YouTube… actions into Slack, Notion, Xcode, Vercel, and ${CATALOG_STATS.connectors - 10} more. Typed ports stop the wrong thing from being wired to the wrong place.` },
          { icon: <Lock className="size-5" />, title: 'Bring your own subscription', description: 'Sign in to Claude Code with your Claude plan and to Codex with your ChatGPT plan, from the studio. Each CLI keeps its own login. No API keys, and no credential ever touches the orchestrator.' },
          { icon: <Wallet className="size-5" />, title: 'Free tier means your own compute', description: 'Export a GitHub Actions workflow and run on your minutes. Hosted microVMs and a self-hosted runner come later, as tiers, not as a rewrite.' },
        ]}
      />

      <Feature1
        className="py-16"
        heading="Drag the flow, ship the config"
        description={`The canvas is a UI over a state machine that already exists. Export produces a .relay/config.json the CLI reads today and a GitHub Actions workflow that runs it. What the canvas cannot express in those files, it says out loud.`}
        buttons={{ primary: { text: 'Open the builder', url: '/workflows' }, secondary: { text: 'Browse templates', url: '/templates' } }}
        image={{ src: '/builder-preview.svg', alt: 'The workflow builder canvas' }}
      />

      <div id="pricing" />
      <Pricing2
        className="py-20"
        heading="Pricing that starts at nothing"
        description="The prototype is free and local. These are the tiers it is designed to grow into."
        plans={[
          {
            name: 'Local',
            description: 'This prototype. Your browser, your GitHub Actions minutes, your Claude and ChatGPT subscriptions.',
            monthlyPrice: '$0',
            yearlyPrice: '$0',
            features: ['Unlimited workflows', `${CATALOG_STATS.connectors} connectors`, 'Export to config + Actions', 'Simulated runs', 'Bring your own subscription'],
            button: { text: 'Open the studio', url: '/dashboard' },
          },
          {
            name: 'Hosted',
            description: 'One Firecracker microVM per run, webhooks bridged for every connector.',
            monthlyPrice: '$29',
            yearlyPrice: '$290',
            features: ['Everything in Local', 'Hosted execution', 'Real triggers from every app', 'Run history and artifacts', 'Slack and email approvals'],
            button: { text: 'Not yet', url: '#faq' },
            highlighted: true,
          },
          {
            name: 'Self-hosted',
            description: 'The runner in your VPC, the canvas in the cloud. Credentials never leave you.',
            monthlyPrice: '$99',
            yearlyPrice: '$990',
            features: ['Everything in Hosted', 'Self-hosted runner', 'SSO and audit log', 'Org-wide guardrails', 'Priority support'],
            button: { text: 'Not yet', url: '#faq' },
          },
        ]}
      />

      <Changelog1
        className="py-16"
        title="What this prototype can do"
        description="Everything below runs in your browser today."
        entries={[
          { version: 'Builder', date: 'Now', title: 'Node-based canvas with typed ports', description: 'Drag triggers, gates, the pipeline, delivery and notifications. Connections are type-checked: an event cannot be fed to something that needs a ticket.', items: ['Palette with search across every connector', 'Inspector forms generated from each node’s fields', 'Validation that mirrors the CLI’s own rules'] },
          { version: 'Runs', date: 'Now', title: 'Simulated runs that behave like real ones', description: 'Phases, review rounds, budgets and refusals replay deterministically so you can see what a workflow would do before it costs anything.', items: ['Per-phase cost and duration', 'Gate refusals stop the run where they would', 'Run history on the dashboard'] },
          { version: 'Export', date: 'Now', title: 'Config and GitHub Actions workflow', description: 'One click produces the files a repository needs to run this for real on your own Actions minutes.', items: ['.relay/config.json', '.github/workflows/<name>.yml', 'SETUP.md listing the secrets by name'] },
        ]}
      />

      <div id="faq" />
      <Faq3
        className="py-20"
        heading="Questions"
        description="What this is, what it is not, and what it costs."
        items={[
          { id: 'cost', question: 'Does this cost anything?', answer: 'No. The prototype runs entirely in your browser and stores everything in localStorage. Exported workflows run on your own GitHub Actions minutes, which are free on public repositories and 3,000 minutes a month on private ones with GitHub Pro. Model usage counts against the Claude and ChatGPT subscriptions you already pay for, or against your own API keys if you prefer.' },
          { id: 'real', question: 'Are the runs real?', answer: 'In the prototype they are simulated: the same phases, rounds, budgets and refusals, played back deterministically. To run for real, export the workflow and commit the two files it produces.' },
          { id: 'name', question: `Why is it called ${brand.name}?`, answer: 'It might not be. The name is one field on the settings page; every screen, export and slug reads it from there.' },
          { id: 'apps', question: 'How do connectors work without a backend?', answer: 'Connections are mocked locally so you can design flows against the full catalog. GitHub, Slack, Discord and any HTTP endpoint are wired directly in the exported Actions workflow. Every other app goes through a bridge URL that the hosted product would own.' },
          { id: 'merge', question: 'Can it merge on its own?', answer: 'Only when a person started the run. A ticket assignment, a label, a schedule or a webhook is an unattended start, and unattended runs stop at a pull request. The builder refuses to export anything else.' },
          { id: 'keys', question: 'Do I need API keys?', answer: 'No. You sign in to Claude Code with your Claude subscription and to Codex with your ChatGPT subscription; the studio starts each CLI’s own login and asks it afterwards whether it worked. For GitHub Actions, Claude Code has claude setup-token and Codex has its documented auth.json method, both supported by the vendors. API keys remain an option in Settings.' },
        ]}
        supportHeading="Want to try it on a real repository?"
        supportDescription="Export any workflow. The SETUP.md in the bundle walks through the two files and three secrets it needs."
        supportButtonText="Open the studio"
        supportButtonUrl="/dashboard"
      />

      <Cta4
        className="py-16"
        heading="Build the flow you wish your team had"
        description={`Ticket in, reviewed pull request out, with your guardrails in between.`}
        buttons={{ primary: { text: 'Open the studio', url: '/dashboard' } }}
        features={['Free and local', 'Typed node canvas', `${CATALOG_STATS.connectors} connectors`, 'Exports real config', 'Rename it anytime']}
      />

      <Footer7
        className="py-16"
        logo={{ url: '/', src: '', alt: brand.name, title: brand.name }}
        description={brand.tagline}
        sections={[
          { title: 'Product', links: [{ name: 'Studio', href: '/dashboard' }, { name: 'Workflows', href: '/workflows' }, { name: 'Templates', href: '/templates' }, { name: 'Integrations', href: '/integrations' }] },
          { title: 'Engine', links: [{ name: 'Relay CLI on GitHub', href: 'https://github.com/aydinmrnv/relay' }, { name: 'How a run works', href: '#how' }, { name: 'Guardrails', href: '#faq' }] },
          { title: 'Built with', links: [{ name: 'shadcn/ui', href: 'https://ui.shadcn.com' }, { name: 'shadcnblocks', href: 'https://www.shadcnblocks.com' }, { name: 'Watermelon UI', href: 'https://ui.watermelon.sh' }, { name: 'React Flow', href: 'https://reactflow.dev' }] },
        ]}
        socialLinks={[]}
        copyright={`© ${new Date().getFullYear()} ${brand.name}. A prototype.`}
        legalLinks={[]}
      />
      <div className="container -mt-10 flex items-center gap-2 pb-10 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" />
        <span>Everything on this page is rendered from the connector catalog and the brand setting. Change the name in Settings and come back.</span>
        <GitPullRequestArrow className="ml-auto size-3.5" />
      </div>
    </main>
  );
}
