/**
 * Every concept the studio asks somebody to understand, explained once.
 *
 * Help popovers, the guide page, empty states and the builder's tour all read
 * from here, so an explanation cannot drift between two screens. Entries are
 * plain strings on purpose: the product name is substituted at render time with
 * `explain(term, brand.name)`, which keeps this file free of React. They may
 * use `**bold**`, backticks and a blank line between paragraphs; `RichText`
 * draws those.
 */

export type Term =
  | 'workflow'
  | 'trigger'
  | 'action'
  | 'port'
  | 'gate'
  | 'budget'
  | 'allowlist'
  | 'approval'
  | 'kill-switch'
  | 'pipeline'
  | 'review-level'
  | 'roles'
  | 'delivery'
  | 'test-run'
  | 'run'
  | 'phase'
  | 'validation'
  | 'export'
  | 'connection'
  | 'subscription'
  | 'template'
  | 'variables'
  | 'unattended'
  | 'cost'
  | 'coding-agent'
  | 'worktree'
  | 'secrets'
  | 'execution'
  | 'runner'
  | 'companion';

export interface GlossaryEntry {
  term: Term;
  title: string;
  /** One sentence, shown in tooltips and popovers. */
  short: string;
  /** A paragraph or two, shown on the guide page and in "learn more". */
  long: string;
  /** Where in the studio this lives, for "Show me" links. */
  href?: string;
}

const PRODUCT = '{product}';

export const GLOSSARY: Record<Term, GlossaryEntry> = {
  workflow: {
    term: 'workflow',
    title: 'Workflow',
    short: 'A graph that says what starts a run, what checks it, what the agents do, and where the result goes.',
    long: `A workflow is a diagram you drag together: one trigger on the left, then gates, the agent pipeline and delivery, then whoever should hear about it. ${PRODUCT} saves it to your account, can play it back as a test run, runs it for real on your computer as it is drawn, and compiles it into files a repository runs with the relay CLI or on its own GitHub Actions minutes.`,
    href: '/workflows',
  },
  trigger: {
    term: 'trigger',
    title: 'Trigger',
    short: 'The event that starts a workflow: an issue assigned, a label added, a schedule, a webhook.',
    long: 'Every workflow starts with exactly one thing that happened. Triggers come from apps (Linear, GitHub, Sentry, Zendesk…), from a schedule, from an incoming webhook, or from a Manual start button. A trigger has only outputs; it hands its payload — usually a ticket — to whatever it is wired to. In a test run every trigger fires with a sample. For real, a label on a GitHub issue is the one that starts an exported workflow by itself today; the others are started by a person, with a ticket.',
  },
  action: {
    term: 'action',
    title: 'Action',
    short: 'A step that does something: post to Slack, run the pipeline, open a pull request, call a URL.',
    long: 'Actions take something in on the left and pass something on to the right. Some have more than one output — a Condition has True and False, a Budget gate has Within budget and Refused — so the graph can branch on what happened.',
  },
  port: {
    term: 'port',
    title: 'Ports and colours',
    short: 'The dots on each node. Colours are types: a ticket only plugs into something that accepts a ticket.',
    long: 'Each colour is a type. One carries a ticket: an issue with a title and a body. One carries a finished pipeline run. One carries a change: a branch or a pull request. One is a plain “this happened” event, and the faintest accepts anything. Hover a dot to read which it is. Inputs are on the left of a node, outputs on the right. The canvas refuses a connection whose colours do not fit, so a nonsense graph cannot be drawn in the first place.',
  },
  gate: {
    term: 'gate',
    title: 'Guardrail gates',
    short: 'Checks that sit in front of the pipeline and refuse by default: budget, allowlist, approval, kill switch.',
    long: 'Gates exist because anything that can be triggered by somebody else can spend your money. Each gate has a pass output and a refused output. Wire the refused one to a Slack message and the team learns why nothing happened, instead of wondering.',
  },
  budget: {
    term: 'budget',
    title: 'Budget gate',
    short: 'Refuses to start a run when it would cross a per-run or per-day spending ceiling.',
    long: 'The pipeline reports what each agent turn cost, and the budget gate compares the running totals against your per-run and per-day ceilings before anything starts. It never queues work for tomorrow: a refused run is refused, and says why. Unattended workflows should always have one; the exported Action will not start without the ceilings set.',
  },
  allowlist: {
    term: 'allowlist',
    title: 'Author allowlist',
    short: 'Only the listed people or teams may start a run. An empty list means nobody may.',
    long: 'On a public repository, a label anyone can apply is an invitation to spend your budget. The allowlist checks who asked before anything else happens.',
  },
  approval: {
    term: 'approval',
    title: 'Human approval',
    short: 'Holds a run for a named person’s yes or no. A real run waits for the answer; a test run plays one.',
    long: 'Use it where a run should not start just because a ticket arrived — customer-reported bugs, anything expensive, anything touching production code. A real run stops here until somebody answers: with Approve or Reject in the run panel, or `relay workflow approve` in the repository. A no, or nobody answering before the timeout, takes the Rejected path. In a test run the answer is played: approved most of the time and rejected now and then, so both branches get exercised. The exported GitHub Action does not perform this step, and Export says so.',
  },
  'kill-switch': {
    term: 'kill-switch',
    title: 'Kill switch',
    short: 'A flag re-read before every start. Turn it off and no new unattended run begins.',
    long: 'It does not stop runs already in progress; it stops the next one. That makes it safe to flip at any time.',
  },
  pipeline: {
    term: 'pipeline',
    title: 'Agent pipeline',
    short: 'Plan → plan review → implement → code review → tests, in an isolated git worktree, by two different agents.',
    long: `The pipeline is what ${PRODUCT} is for. One coding agent writes a plan, a different one attacks it against the real code, the plan is revised, one implements, the other reviews the diff, and the project's own test suite has the last word. Everything happens on its own branch in its own worktree, so your checkout is never touched. It takes a ticket in and hands a finished run out. The Fast run variant skips both reviews for small, well-described tickets.`,
  },
  'review-level': {
    term: 'review-level',
    title: 'Review level',
    short: 'How hard the agents check each other: Light (one round), Standard (two each), Thorough (three each).',
    long: 'More rounds find more problems and cost more. Standard is the default; Light suits small, well-described tickets; Thorough suits anything you would not want to review twice yourself.',
  },
  roles: {
    term: 'roles',
    title: 'Agent roles',
    short: 'Who plans, who reviews the plan, who implements and who reviews the code.',
    long: 'Cross-model review is the point: the planner and the plan reviewer should be different agents, and so should the implementer and the code reviewer. Reviewers always run read-only, which is why an agent with no read-only mode can implement but never review.',
  },
  delivery: {
    term: 'delivery',
    title: 'Delivery',
    short: 'How far a finished run carries its work: leave it, commit, push, open a pull request, or merge.',
    long: 'The delivery node turns a run into a change. A run started by somebody else — a ticket assignment, a label, a schedule — may open a pull request but may never merge; the validator will stop you from wiring that. A secret scan runs before anything is pushed.',
  },
  'test-run': {
    term: 'test-run',
    title: 'Test run',
    short: 'Plays the workflow back in your browser with a sample ticket. Free: nothing is run and no agent is called.',
    long: 'A test run walks your graph node by node with the same phases, review rounds, budgets and refusals the real pipeline has, using a sample payload from the trigger (or one you type). It is seeded, so the same workflow replays the same run until you change it. Nothing is called and nothing is billed; the costs and times shown are drawn from typical ranges per phase, not measured. Its record is saved to your account like any other run. How fast it plays back is a setting.',
    href: '/workflows',
  },
  run: {
    term: 'run',
    title: 'Run',
    short: 'One execution of a workflow, with every node it touched, what it cost, and what it delivered.',
    long: 'Runs are recorded here with a timeline, the pipeline phases, the cost per phase, the diff, the tests and the pull request. Open one to see exactly what happened and why.',
    href: '/runs',
  },
  phase: {
    term: 'phase',
    title: 'Pipeline phases',
    short: 'The steps inside the pipeline: fetch the issue, create the workspace, plan, review, implement, review, test.',
    long: 'Each phase names the agent that did it, how long it took and what it cost, so you can see where the time and money went. Plan review and code review repeat for as many rounds as the review level allows, and stop early once the reviewer has nothing left to raise.',
    href: '/runs',
  },
  validation: {
    term: 'validation',
    title: 'Validation',
    short: 'Checks the graph against the same rules the CLI enforces, as you edit.',
    long: 'Errors stop a test run and an export: a missing trigger, ports that do not fit, a loop, a reviewer that cannot be read-only, an unattended run that could merge, a required field left empty. Warnings are advice — no budget gate, the same agent grading its own work — and never block you.',
  },
  export: {
    term: 'export',
    title: 'Export',
    short: 'Compiles the workflow into files a repository needs to run it on its own GitHub Actions minutes.',
    long: `You get .relay/config.json (what the ${PRODUCT} CLI reads), the workflow compiled for the CLI under .relay/workflows/, a GitHub Actions workflow under .github/workflows/, a SETUP.md listing the secrets to add, and the graph as JSON so it can be imported again. Commit them, add the secrets, and the workflow runs on your repository with your own subscriptions: as drawn with \`relay workflow run\` and \`relay workflow serve\`, or on GitHub Actions. Nothing is hosted or billed by ${PRODUCT}. The Action is narrower than the canvas: it works on one GitHub issue per run and cannot evaluate a Condition or wait for an approval. So each step is placed by where it sits in the graph, a step the Action cannot decide is left out, and every such difference is listed as a warning in the export.`,
    href: '/workflows',
  },
  connection: {
    term: 'connection',
    title: 'Connections',
    short: 'Which apps a workflow may talk to. Slack and Discord connect for real, with a webhook the studio checks; other apps can be marked ready.',
    long: 'You can design and test against the whole catalog without connecting anything. Slack and Discord take a webhook URL: the studio checks it with the app, keeps it encrypted in your account and only ever shows its last four characters. A webhook can post to one channel and do nothing else. Every other app can be marked ready, which records a label and signs in to nothing, until its own sign-in is built.',
    href: '/integrations',
  },
  subscription: {
    term: 'subscription',
    title: 'Bring your own subscription',
    short: 'Claude Code signs in with your Claude plan and Codex with your ChatGPT plan. No API keys to paste.',
    long: `The studio asks the CLIs on your runner whether they are signed in, and can start their own sign-in flow from Settings → Coding agents. It never sees or stores a token: the credential lands in the CLI, exactly as if you had signed in from a terminal. For GitHub Actions, the export uses each vendor's supported way to carry a personal plan into CI (CLAUDE_CODE_OAUTH_TOKEN, CODEX_AUTH_JSON), or API keys if you prefer.`,
    href: '/settings#agents',
  },
  template: {
    term: 'template',
    title: 'Templates',
    short: 'Ready-made workflows built from the live catalog. Use one, then change anything.',
    long: 'Each template is a complete, valid graph. Using it copies it into your workflows; the original is never changed.',
    href: '/templates',
  },
  variables: {
    term: 'variables',
    title: 'Variables',
    short: 'Placeholders like {{issue.title}} or {{run.prUrl}} that are filled in when the workflow runs.',
    long: 'Text fields marked as templates accept variables. Use the Variables button next to the field to insert one: issue.* comes from the trigger, run.* from the pipeline, workflow.* and product.* are always there.',
  },
  unattended: {
    term: 'unattended',
    title: 'Unattended runs',
    short: 'Any run nobody pressed a button for — a ticket, a label, a schedule, a webhook.',
    long: 'Unattended runs are held to stricter rules: they may never merge, and the validator warns when there is no budget gate or allowlist in front of the pipeline.',
  },
  cost: {
    term: 'cost',
    title: 'Cost',
    short: 'What the coding CLIs report each turn cost. On a subscription it counts against your plan’s usage.',
    long: 'Costs in test runs are simulated from realistic ranges per phase. In a real run they are exactly what Claude Code and Codex report, summed per phase. On a subscription nothing extra is billed, but the number is still what budget gates compare against, so a ceiling means the same thing on either kind of account.',
    href: '/runs',
  },
  'coding-agent': {
    term: 'coding-agent',
    title: 'Coding agents',
    short: 'The command-line tools that do the work, such as Claude Code and Codex, each signed in with its own account.',
    long: `${PRODUCT} does not bring its own model. The pipeline drives coding CLIs you already use: Claude Code and Codex. Another CLI can be plugged in as a harness in the repository’s config, but those two are the ones built in and tested. Each runs inside the run's worktree on its own account, so the plan you already pay for does the work. Two different agents checking each other is what makes the reviews worth having.`,
    href: '/settings#agents',
  },
  worktree: {
    term: 'worktree',
    title: 'Isolated worktree',
    short: 'A separate checkout on its own branch where a run does all its work, so your own checkout is never touched.',
    long: 'Before any agent starts, the pipeline creates a git worktree on a fresh branch named after the branch prefix, the ticket and its title. Agents edit files there, tests run there, and delivery pushes from there. If a run fails or is stopped, the branch and the work so far stay behind for you to inspect.',
  },
  secrets: {
    term: 'secrets',
    title: 'Repository secrets',
    short: 'Values the exported Action reads from your repository settings: agent credentials and webhook URLs. The studio never sees them.',
    long: 'SETUP.md lists every secret an export needs, by name. Claude Code needs CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API key); Codex needs CODEX_AUTH_JSON (subscription) or OPENAI_API_KEY (API key); Slack, Discord and bridged actions add their webhook URLs. Add them under the repository’s Settings → Secrets and variables → Actions, or with gh secret set.',
    href: '/settings#credentials',
  },
  companion: {
    term: 'companion',
    title: 'Your computer (relay connect)',
    short: 'The Relay CLI on your computer, paired with the studio: it signs in your coding agents, runs workflows for real and installs exports.',
    long: `The studio draws, checks and compiles workflows in your browser; your coding agents, their sign-ins and your repository are on your computer. \`relay connect\`, run inside a repository, starts a small server on 127.0.0.1 that only a paired studio may use, and prints a link that pairs this browser with it. From then on the studio can start Claude Code’s and Codex’s own sign-ins, run a workflow’s pipeline for real in that repository — streaming every phase back to the canvas — and install an export straight into it. Test runs stay free and in the browser either way. The pairing token never leaves the browser and your computer, and relay connect never reads an agent credential. Relay Cloud, where it is offered, is the same job on a machine Relay runs for you instead; /runners compares the two.`,
    href: '/connect',
  },
  runner: {
    term: 'runner',
    title: 'Runner: your computer, or Relay Cloud',
    short: 'The place a run actually executes and your coding agents are signed in: your own computer through relay connect, or a machine Relay runs for you.',
    long: `Two runners, one protocol, the same result either way. **Your computer**: \`relay connect\` inside a repository, reachable only on 127.0.0.1, with your sign-ins in the CLIs’ own files where they already are. Free, but only while that process is running. **Relay Cloud** (invite-only beta, where a deployment offers it): a Linux machine of yours that Relay makes, and puts to sleep after ten idle minutes. Nothing to install, no terminal, and it wakes in about a minute when you press Run, so it works from any browser even with your laptop shut. It runs one run at a time. It needs an account, because Relay Cloud knows your machine by your sign-in, and it has no public address: it dials out, and only your own signed-in studio reaches it.

Whichever you pick, the agents run with your own Claude and ChatGPT plans, the studio never asks you for a model credential and has no route that reads one, the code lands in your repository as a branch and a pull request, and test runs stay free in the browser. What does differ is where things sit: on your computer, your checkout and sign-ins never leave it; on Relay Cloud they live on your own cloud machine’s disk, which Relay operates and which goes away when you remove the machine. You choose which runner sign-ins and runs go to, and every run remembers the machine it started on, so switching never orphans one.`,
    href: '/runners',
  },
  execution: {
    term: 'execution',
    title: 'Where runs execute',
    short: 'A real run executes on the runner you picked — your computer or Relay Cloud — and an exported workflow runs unattended on your repository’s own GitHub Actions minutes.',
    long: `There are three places work happens, and they answer different questions. **The runner you picked** (/runners): "Run on your computer" sends the whole workflow there and performs every step of it, with your own sign-ins, streaming each back to the canvas; "Run in Relay Cloud" runs the pipeline and its delivery. **A machine of your own, unattended**: \`relay workflow serve\` keeps a workflow's trigger — an incoming webhook, a schedule, a label — and runs it each time. **Your repository’s GitHub Actions**: Export compiles the graph into plain files you commit; a label on a GitHub issue is a real trigger there, on your own Actions minutes, free on public repositories. **Your browser**: a test run never executes anything; it is played back node by node with simulated agents, costs and refusals. Hosted microVMs for exported runs and a self-hosted runner in your own network are planned, not built.`,
    href: '/settings#running',
  },
};

/** The entry with the product name filled in. */
export function explain(term: Term, productName: string): GlossaryEntry {
  const entry = GLOSSARY[term];
  return {
    ...entry,
    short: entry.short.replaceAll(PRODUCT, productName),
    long: entry.long.replaceAll(PRODUCT, productName),
  };
}

/** Order used by the guide page: roughly the order somebody meets them. */
export const GLOSSARY_ORDER: Term[] = [
  'workflow',
  'trigger',
  'action',
  'port',
  'pipeline',
  'coding-agent',
  'roles',
  'review-level',
  'worktree',
  'gate',
  'budget',
  'allowlist',
  'approval',
  'kill-switch',
  'delivery',
  'unattended',
  'validation',
  'test-run',
  'run',
  'phase',
  'cost',
  'variables',
  'export',
  'secrets',
  'execution',
  'runner',
  'companion',
  'connection',
  'subscription',
  'template',
];
