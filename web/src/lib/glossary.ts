/**
 * Every concept the studio asks somebody to understand, explained once.
 *
 * Help popovers, the guide page, empty states and the builder's tour all read
 * from here, so an explanation cannot drift between two screens. Entries are
 * plain strings on purpose: the product name is substituted at render time with
 * `explain(term, brand.name)`, which keeps this file free of React.
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
  | 'cost';

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
    long: `A workflow is a diagram you drag together: one trigger on the left, then gates, the agent pipeline and delivery, then whoever should hear about it. ${PRODUCT} saves it in this browser, can play it back as a test run, and compiles it into files a repository runs on its own GitHub Actions minutes.`,
    href: '/workflows',
  },
  trigger: {
    term: 'trigger',
    title: 'Trigger',
    short: 'The event that starts a workflow: an issue assigned, a label added, a schedule, a webhook.',
    long: 'Every workflow starts with exactly one thing that happened. Triggers come from connected apps (Linear, GitHub, Sentry, Zendesk…), from a schedule, from an incoming webhook, or from a Manual start button. A trigger has only outputs; it hands its payload — usually a ticket — to whatever it is wired to.',
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
    long: 'Blue ports carry a ticket (an issue with a title and a body). Violet carries a finished pipeline run. Indigo carries a change — a branch or a pull request. Grey is a plain event, and light grey accepts anything. The canvas refuses a connection whose colours do not fit, so a nonsense graph cannot be drawn in the first place.',
  },
  gate: {
    term: 'gate',
    title: 'Guardrail gates',
    short: 'Checks that sit in front of the pipeline and refuse by default: budget, allowlist, approval, kill switch.',
    long: 'Gates exist because anything that can be triggered by somebody else can spend your money. Each gate has a pass output and a refused output; wire the refused one to a Slack message and the team learns why nothing happened.',
  },
  budget: {
    term: 'budget',
    title: 'Budget gate',
    short: 'Refuses to start a run when it would cross a per-run or per-day spending ceiling.',
    long: 'The pipeline reports what each agent turn cost, and the budget gate compares the running total against your ceilings before anything starts. It never queues work for tomorrow — a refused run is refused, and says why.',
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
    short: 'Pauses the workflow until a named person approves in chat, on the issue, or in the dashboard.',
    long: 'Use it where a run should not start just because a ticket arrived — customer-reported bugs, anything expensive, anything touching production code. In a test run it is approved automatically after a short pause.',
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
    long: `The pipeline is what ${PRODUCT} is for. One coding agent writes a plan, a different one attacks it against the real code, the plan is revised, one implements, the other reviews the diff, and the project's own test suite has the last word. Everything happens on its own branch in its own worktree, so your checkout is never touched. It takes a ticket in and hands a run out.`,
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
    long: 'Cross-model review is the point: the planner and the plan reviewer should be different agents, and so should the implementer and the code reviewer. Reviewers always run read-only, which is why an agent with no read-only mode (Aider) can implement but never review.',
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
    short: 'Plays the workflow back in your browser with a sample ticket. Free, instant, and nothing leaves this machine.',
    long: 'A test run walks your graph node by node with the same phases, review rounds, budgets and refusals the real pipeline has, using a sample payload from the trigger (or one you type). It is seeded, so the same workflow replays the same run until you change it. Nothing is called, nothing is billed; costs shown are what the CLIs would report.',
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
    long: 'Each phase names the agent that did it, how long it took and what it cost, so you can see where the time and money went.',
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
    long: `You get .relay/config.json (what the ${PRODUCT} CLI reads), a GitHub Actions workflow, a SETUP.md listing the secrets to add, and the graph as JSON. Commit them, add the secrets, and the workflow runs on your repository with your own subscriptions — nothing is hosted or billed by ${PRODUCT}.`,
  },
  connection: {
    term: 'connection',
    title: 'Connections',
    short: 'Which apps the workflow may talk to. In this prototype a connection is a local flag, not a real login.',
    long: 'You can design against all of the catalog without connecting anything. Connecting an app marks it available and removes the reminder on its nodes; the hosted product would run the app’s own sign-in here.',
    href: '/integrations',
  },
  subscription: {
    term: 'subscription',
    title: 'Bring your own subscription',
    short: 'Claude Code signs in with your Claude plan and Codex with your ChatGPT plan. No API keys to paste.',
    long: `The studio asks the CLIs on this machine whether they are signed in, and can start their own sign-in flow from Settings. It never sees or stores a token. For GitHub Actions, the export uses each vendor's supported way to carry a personal plan into CI (CLAUDE_CODE_OAUTH_TOKEN, CODEX_AUTH_JSON), or API keys if you prefer.`,
    href: '/settings',
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
    long: 'Costs in test runs are simulated from realistic ranges per phase. In a real run they are exactly what Claude Code and Codex report, summed per phase.',
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
  'roles',
  'review-level',
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
  'connection',
  'subscription',
  'template',
];
