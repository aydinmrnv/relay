/**
 * Starter workflows. Each is built against the live catalog, so a template
 * never references a trigger or action id that does not exist: it asks for a
 * connector by id and picks the closest trigger/action by keyword.
 */
import { nanoid } from 'nanoid';
import type { Brand } from '../brand';
import { defaultConfig, getConnector, getNodeType, nodeTypeId, pickAction, pickTrigger, type NodeKind, type PortType } from '../connectors';
import { portsCompatible } from './validate';
import type { Workflow, WorkflowEdge, WorkflowNode } from './schema';

/** The job a template does, which is how the Templates page groups them. */
export type TemplateJob = 'tickets' | 'breaks' | 'upkeep' | 'requests';

export const TEMPLATE_JOBS: Array<{ job: TemplateJob; label: string }> = [
  { job: 'tickets', label: 'Tickets to pull requests' },
  { job: 'breaks', label: 'When something breaks' },
  { job: 'upkeep', label: 'Security and upkeep' },
  { job: 'requests', label: 'Requests from people' },
];

export interface TemplateMeta {
  id: string;
  name: string;
  /** What the workflow does, step by step, in two sentences. */
  description: string;
  /** Who it is for and when: the situation somebody is in when they want this. */
  when: string;
  job: TemplateJob;
  connectors: string[];
  tags: string[];
}

export const TEMPLATES: TemplateMeta[] = [
  {
    id: 'ticket-to-pr',
    name: 'Linear ticket to pull request',
    description: 'Assign a Linear issue to the bot. Claude Code plans, Codex implements, each reviews the other, the tests run, and a draft PR opens; the ticket moves to In Review with the PR attached and #eng is asked for review.',
    when: 'Your team writes good tickets and the small ones sit in the backlog because nobody picks them up.',
    job: 'tickets',
    connectors: ['linear', 'gates', 'pipeline', 'delivery', 'slack'],
    tags: ['linear', 'slack'],
  },
  {
    id: 'label-run',
    name: 'GitHub label to pull request',
    description: 'A maintainer adds a label to an issue. Behind a kill switch, an allowlist and a budget, the pipeline runs and the summary lands back on the issue. A refused run leaves the label where it is, so nothing happens silently.',
    when: 'You maintain a repository and want to hand over an issue with one label, without anyone else being able to spend your budget.',
    job: 'tickets',
    connectors: ['github-issues', 'gates', 'pipeline', 'delivery'],
    tags: ['github', 'open source', 'runs unattended'],
  },
  {
    id: 'ci-fix',
    name: 'Fix main when CI goes red',
    description: 'When a workflow fails on main, the failing job and its log become the task. One fix at a time, under a budget, with a light review; #builds gets the PR, or the reason there is none.',
    when: 'A broken main blocks everyone, and the fix is usually small: a test that needs updating, a type that drifted, a merge that crossed another.',
    job: 'breaks',
    connectors: ['github-actions', 'gates', 'pipeline', 'delivery', 'slack'],
    tags: ['ci', 'slack'],
  },
  {
    id: 'sentry-fix',
    name: 'Sentry error to fix',
    description: 'A new production error that reaches five users is read by a model first. If the stack trace is enough, it gets a fix PR linked on the Sentry issue; if it needs a product decision, it becomes a Linear ticket instead.',
    when: 'Errors pile up in Sentry faster than anyone triages them, and many are one-line fixes once somebody reads the trace.',
    job: 'breaks',
    connectors: ['sentry', 'logic', 'gates', 'pipeline', 'delivery', 'linear', 'slack'],
    tags: ['errors', 'triage', 'linear'],
  },
  {
    id: 'support-fix',
    name: 'Customer bug report to fix, with approval',
    description: 'A Zendesk ticket tagged bug is checked for steps to reproduce and filed in Linear. An engineer approves in Slack before anything is spent, and the support agent gets an internal note with the PR, not the customer.',
    when: 'Support hears about bugs first, and engineering wants to decide which of them an agent may take.',
    job: 'requests',
    connectors: ['zendesk', 'logic', 'linear', 'gates', 'pipeline', 'delivery'],
    tags: ['support', 'approval', 'linear'],
  },
  {
    id: 'slack-to-pr',
    name: 'Fix it from Slack',
    description: 'React with :robot_face: to a bug report in #bugs. If you are on the list, it becomes a Linear ticket, the pipeline runs, and the draft PR is posted back in the thread.',
    when: 'Bugs get reported in a channel, and the person who sees one should not have to copy it into a tracker to get it fixed.',
    job: 'requests',
    connectors: ['slack', 'gates', 'linear', 'pipeline', 'delivery'],
    tags: ['slack', 'linear'],
  },
  {
    id: 'backlog-triage',
    name: 'Price new tickets before anyone picks them up',
    description: 'Every new Linear issue gets an estimate of what an agent run would cost, before any agent is called. Cheap ones are labelled agent-ready; the rest get a comment saying why they are too big to hand over.',
    when: 'You want to know which tickets are small enough for the agents without reading every one, and without paying to find out.',
    job: 'tickets',
    connectors: ['linear', 'pipeline', 'logic'],
    tags: ['linear', 'triage', 'free to run'],
  },
  {
    id: 'code-scanning-fix',
    name: 'Fix high-severity code scanning alerts',
    description: 'A new high or critical CodeQL alert becomes a fix, reviewed by both agents at the thorough level and opened as a draft PR for the security team.',
    when: 'Alerts are found automatically but fixed by hand, so they wait; the fix is usually local to the flagged flow.',
    job: 'upkeep',
    connectors: ['codeql', 'gates', 'pipeline', 'delivery', 'slack'],
    tags: ['security', 'slack'],
  },
  {
    id: 'dependency-upgrades',
    name: 'Weekly dependency upgrades that pass CI',
    description: 'Every Monday morning a GitHub issue records the ask; the agents upgrade what can be upgraded, fix what the upgrades break, and open one draft PR.',
    when: 'Version-bump bots open a PR per package and leave the breaking ones red; you want one PR that already builds.',
    job: 'upkeep',
    connectors: ['schedule', 'github-issues', 'gates', 'pipeline', 'delivery', 'slack'],
    tags: ['dependencies', 'schedule'],
  },
  {
    id: 'flag-cleanup',
    name: 'Remove feature flags that finished rolling out',
    description: 'When a LaunchDarkly flag has served one variation to everyone for 30 days, the agents delete the flag checks and the dead path, and open a small draft PR.',
    when: 'Flags are easy to add and nobody schedules removing them, so the code fills up with branches that can never run.',
    job: 'upkeep',
    connectors: ['launchdarkly', 'gates', 'pipeline', 'delivery', 'slack'],
    tags: ['feature flags', 'tech debt'],
  },
];

interface Builder {
  node: (connectorId: string, kind: NodeKind, keywords: string[], col: number, row: number, config?: Record<string, unknown>, label?: string) => string | null;
  edge: (from: string | null, to: string | null, sourceHandle?: string, targetHandle?: string) => void;
}

const COL = 320;
const ROW = 190;

export function instantiateTemplate(templateId: string, brand: Brand, repository = ''): Workflow | undefined {
  const meta = TEMPLATES.find((template) => template.id === templateId);
  if (meta === undefined) return undefined;
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];

  const builder: Builder = {
    node: (connectorId, kind, keywords, col, row, config = {}, label) => {
      const connector = getConnector(connectorId);
      if (connector === undefined) return null;
      const spec = kind === 'trigger' ? pickTrigger(connector, keywords) : pickAction(connector, keywords);
      if (spec === undefined) return null;
      const typeId = nodeTypeId(connectorId, kind, spec.id);
      const def = getNodeType(typeId);
      if (def === undefined) return null;
      const id = `n_${nanoid(8)}`;
      nodes.push({
        id,
        type: 'wf',
        position: { x: 80 + col * COL, y: 120 + row * ROW },
        data: { typeId, config: { ...defaultConfig(def), ...config }, ...(label === undefined ? {} : { label }) },
      });
      return id;
    },
    edge: (from, to, sourceHandle, targetHandle) => {
      if (from === null || to === null) return;
      // The builders name handles for readability, but the action a keyword
      // picked may call its ports something else. Resolve against the real
      // ports, falling back to the first one whose type fits, so a template
      // can never ship a connection the validator rejects.
      const source = getNodeType(nodes.find((node) => node.id === from)?.data.typeId ?? '');
      const target = getNodeType(nodes.find((node) => node.id === to)?.data.typeId ?? '');
      const out = source?.outputs.find((port) => port.id === sourceHandle) ?? source?.outputs[0];
      const fits = (port: { type: PortType }) => out === undefined || portsCompatible(out.type, port.type);
      const inp = target?.inputs.find((port) => port.id === targetHandle && fits(port)) ?? target?.inputs.find(fits) ?? target?.inputs[0];
      edges.push({ id: `e_${nanoid(8)}`, source: from, target: to, sourceHandle: out?.id ?? null, targetHandle: inp?.id ?? null });
    },
  };

  BUILDERS[templateId]?.(builder, brand);

  const now = new Date().toISOString();
  return {
    id: `wf_${nanoid(10)}`,
    name: meta.name,
    description: meta.description,
    nodes,
    edges,
    // Paused, like a blank or a described workflow: nothing made here is switched on until its owner says so.
    enabled: false,
    createdAt: now,
    updatedAt: now,
    templateId,
    repository,
  };
}

// A typical full run costs about $5 and one in ten goes past $6 (see the
// spend forecast), so the per-run cap leaves room for the long tail rather
// than stopping good runs halfway. Smaller jobs get smaller caps.
const BUDGET = { maxRunCostUsd: 8, maxDailyCostUsd: 40, confirmAboveUsd: 10 };
const PIPELINE = { review: 'standard', planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' };

const BUILDERS: Record<string, (b: Builder, brand: Brand) => void> = {
  'ticket-to-pr': (b, brand) => {
    const trigger = b.node('linear', 'trigger', ['issue-assigned'], 0, 1, { assignee: `@${brand.slug}-bot` });
    const budget = b.node('gates', 'action', ['budget'], 1, 1, BUDGET);
    const pipeline = b.node('pipeline', 'action', ['run'], 2, 1, { ...PIPELINE, branchPrefix: brand.slug });
    const deliver = b.node('delivery', 'action', ['deliver'], 3, 1, { policy: 'pr', draft: true, labels: `${brand.slug}, needs-review` });
    const attach = b.node('linear', 'action', ['attach-pr'], 4, 0.2);
    const inReview = b.node('linear', 'action', ['update-state'], 4, 1, { state: 'In Review' });
    const review = b.node('slack', 'action', ['share-pr'], 4, 1.8, { channel: '#eng', text: '{{issue.key}} {{issue.title}}: a draft PR is ready for review. {{run.prUrl}}' });
    const refused = b.node('linear', 'action', ['comment'], 2, 2.4, { body: `Not started: this would go past today's agent budget. Nothing was spent. Assign it to @${brand.slug}-bot again tomorrow, or run it by hand.` }, 'Tell the ticket why');
    b.edge(trigger, budget, 'issue', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(budget, refused, 'refused', 'in');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(deliver, attach, 'change', 'change');
    b.edge(deliver, inReview, 'change', 'in');
    b.edge(deliver, review, 'change', 'change');
  },
  'label-run': (b, brand) => {
    const trigger = b.node('github-issues', 'trigger', ['issue-labelled'], 0, 1, { label: `${brand.slug}:go` });
    const kill = b.node('gates', 'action', ['kill'], 1, 1, { enabled: true });
    const allow = b.node('gates', 'action', ['allowlist'], 2, 1, { authors: 'you\nalice\nbob', teams: 'acme/platform' });
    const budget = b.node('gates', 'action', ['budget'], 3, 1, BUDGET);
    const pipeline = b.node('pipeline', 'action', ['run'], 4, 1, { ...PIPELINE, branchPrefix: brand.slug });
    const deliver = b.node('delivery', 'action', ['deliver'], 5, 0.4, { policy: 'pr', draft: true });
    const comment = b.node('delivery', 'action', ['comment-summary'], 5, 1.6);
    b.edge(trigger, kill, 'issue', 'in');
    b.edge(kill, allow, 'out', 'in');
    b.edge(allow, budget, 'pass', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(pipeline, comment, 'run', 'run');
  },
  'ci-fix': (b, brand) => {
    const trigger = b.node('github-actions', 'trigger', ['workflow-failed'], 0, 1, { workflow: 'ci.yml', branch: 'main', firstFailureOnly: true });
    const one = b.node('gates', 'action', ['concurrency'], 1, 1, { maxConcurrentRuns: 1 }, 'One fix at a time');
    const budget = b.node('gates', 'action', ['budget'], 2, 1, { maxRunCostUsd: 5, maxDailyCostUsd: 20, confirmAboveUsd: 10 });
    const pipeline = b.node('pipeline', 'action', ['run'], 3, 1, { ...PIPELINE, review: 'light', branchPrefix: `${brand.slug}/ci` });
    const deliver = b.node('delivery', 'action', ['deliver'], 4, 1, { policy: 'pr', draft: true, labels: 'ci-fix', prTitle: 'Fix CI on main: {{issue.job}}' });
    const post = b.node('slack', 'action', ['share-pr'], 5, 1, { channel: '#builds', text: 'main has been red since {{issue.commit}} ({{issue.job}}). A fix is ready for review: {{run.prUrl}}' });
    const refused = b.node('slack', 'action', ['post-message'], 3, 2.4, { channel: '#builds', text: "main is red ({{issue.title}}) and today's budget for fixing it is spent, so this one needs a person: {{issue.url}}" }, 'Tell #builds it needs a person');
    b.edge(trigger, one, 'issue', 'in');
    b.edge(one, budget, 'out', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(budget, refused, 'refused', 'in');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(deliver, post, 'change', 'change');
  },
  'sentry-fix': (b, brand) => {
    const trigger = b.node('sentry', 'trigger', ['issue-created'], 0, 1, { project: 'web', environment: 'production', minUsers: 5 });
    const ai = b.node('logic', 'action', ['ai-step'], 1, 1, { prompt: 'Can this error be fixed from the stack trace and the code alone, without a product decision? Answer fixable or needs-a-person, then say why in one line.\n\n{{issue.title}}\n{{issue.body}}' }, 'Fixable from the trace?');
    const cond = b.node('logic', 'action', ['condition'], 2, 1, { left: '{{issue.triage}}', op: 'contains', right: 'fixable' });
    const budget = b.node('gates', 'action', ['budget'], 3, 0.4, BUDGET);
    const pipeline = b.node('pipeline', 'action', ['run'], 4, 0.4, { ...PIPELINE, review: 'light', branchPrefix: brand.slug });
    const deliver = b.node('delivery', 'action', ['deliver'], 5, 0.4, { policy: 'pr', draft: true, labels: `${brand.slug}, sentry`, prTitle: 'Fix {{issue.key}}: {{issue.title}}', prBody: 'Fixes {{issue.url}}\n\n{{run.summary}}\n\nReviewed by {{run.codeReviewer}}. Tests: {{run.tests}}. Cost: {{run.cost}}.' });
    const link = b.node('sentry', 'action', ['link-pr'], 6, 0);
    const post = b.node('slack', 'action', ['share-pr'], 6, 0.9, { channel: '#eng-alerts', text: 'Sentry {{issue.key}} ({{issue.users}} users): a fix is ready for review. {{run.prUrl}}' });
    const ticket = b.node('linear', 'action', ['create-issue'], 3, 1.8, { title: 'Sentry: {{issue.title}}', body: '{{issue.users}} users affected in production.\n\n{{issue.body}}\n\n{{issue.url}}' }, 'File it for a person');
    const noted = b.node('sentry', 'action', ['add-comment'], 4, 1.8);
    b.edge(trigger, ai, 'issue', 'in');
    b.edge(ai, cond, 'out', 'in');
    b.edge(cond, budget, 'true', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(deliver, link, 'change', 'change');
    b.edge(deliver, post, 'change', 'change');
    b.edge(cond, ticket, 'false', 'in');
    b.edge(ticket, noted, 'issue', 'in');
  },
  'support-fix': (b, brand) => {
    const trigger = b.node('zendesk', 'trigger', ['ticket-tagged'], 0, 1, { tag: 'bug' });
    const ai = b.node('logic', 'action', ['ai-step'], 1, 1, { prompt: 'Does this support ticket say how to reproduce the problem: what the customer did, what they expected, what happened? Answer reproducible or needs-info, then list the steps as you understand them.\n\n{{issue.title}}\n{{issue.body}}' }, 'Enough to reproduce?');
    const cond = b.node('logic', 'action', ['condition'], 2, 1, { left: '{{issue.triage}}', op: 'contains', right: 'reproducible' });
    const ticket = b.node('linear', 'action', ['create-issue'], 3, 0.4, { title: '{{issue.title}}', body: 'From Zendesk {{issue.key}} ({{issue.url}}):\n\n{{issue.body}}' }, 'Track it in Linear');
    const approval = b.node('gates', 'action', ['approval'], 4, 0.4, { via: 'chat', approvers: 'you', timeoutHours: 24 });
    const budget = b.node('gates', 'action', ['budget'], 5, 0.4, BUDGET);
    const pipeline = b.node('pipeline', 'action', ['run'], 6, 0.4, { ...PIPELINE, branchPrefix: brand.slug });
    const deliver = b.node('delivery', 'action', ['deliver'], 7, 0.4, { policy: 'pr', draft: true, labels: `${brand.slug}, customer-reported` });
    const note = b.node('zendesk', 'action', ['add-internal-note'], 8, 0.4, { body: "Engineering has a fix in review: {{run.prUrl}} (tracked as {{issue.key}}). It hasn't shipped, so don't promise a date yet." });
    const needsInfo = b.node('zendesk', 'action', ['add-internal-note'], 3, 1.8, { body: 'Engineering needs steps to reproduce before this can be fixed: what the customer did, what they expected, and what happened instead.' }, 'Ask support for steps');
    const declined = b.node('zendesk', 'action', ['add-internal-note'], 5, 1.8, { body: 'An engineer chose not to hand this to the agents. It is tracked as {{issue.key}} for a person to pick up.' }, 'Say an engineer has it');
    b.edge(trigger, ai, 'issue', 'in');
    b.edge(ai, cond, 'out', 'in');
    b.edge(cond, ticket, 'true', 'in');
    b.edge(cond, needsInfo, 'false', 'in');
    b.edge(ticket, approval, 'issue', 'in');
    b.edge(approval, budget, 'approved', 'in');
    b.edge(approval, declined, 'rejected', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(deliver, note, 'change', 'in');
  },
  'slack-to-pr': (b, brand) => {
    const trigger = b.node('slack', 'trigger', ['reaction-added'], 0, 1, { channel: '#bugs', reaction: 'robot_face' });
    const allow = b.node('gates', 'action', ['allowlist'], 1, 1, { authors: 'you\nalice\nsam' }, 'Who may ask from Slack');
    const ticket = b.node('linear', 'action', ['create-issue'], 2, 1, { title: '{{issue.title}}', body: 'Reported in Slack by {{trigger.reporter}}: {{trigger.url}}\n\n{{issue.body}}' }, 'Track it in Linear');
    const seen = b.node('slack', 'action', ['add-reaction'], 3, 0.2, { reaction: 'eyes' });
    const budget = b.node('gates', 'action', ['budget'], 3, 1, BUDGET);
    const pipeline = b.node('pipeline', 'action', ['run'], 4, 1, { ...PIPELINE, branchPrefix: brand.slug });
    const deliver = b.node('delivery', 'action', ['deliver'], 5, 1, { policy: 'pr', draft: true, labels: `${brand.slug}, from-slack` });
    const reply = b.node('slack', 'action', ['reply-in-thread'], 6, 1, { text: 'Draft PR ready for review: {{run.prUrl}} (tracked as {{issue.key}})' });
    const refused = b.node('slack', 'action', ['reply-in-thread'], 2, 2.4, { text: "Not started automatically: only people on the list can ask from Slack, and each fix has to fit today's budget. Nothing was spent." }, 'Say why in the thread');
    b.edge(trigger, allow, 'issue', 'in');
    b.edge(allow, ticket, 'pass', 'in');
    b.edge(allow, refused, 'refused', 'in');
    b.edge(ticket, seen, 'issue', 'in');
    b.edge(ticket, budget, 'issue', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(budget, refused, 'refused', 'in');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(deliver, reply, 'change', 'in');
  },
  'backlog-triage': (b, brand) => {
    const trigger = b.node('linear', 'trigger', ['issue-created'], 0, 1, { team: 'ENG' });
    const estimate = b.node('pipeline', 'action', ['estimate'], 1, 1);
    const cond = b.node('logic', 'action', ['condition'], 2, 1, { left: '{{issue.estimateUsd}}', op: 'lt', right: '3' }, 'Under $3 a run?');
    const label = b.node('linear', 'action', ['add-label'], 3, 0.4, { label: 'agent-ready' });
    const small = b.node('linear', 'action', ['comment'], 4, 0.4, { body: `An agent run for this should cost about \${{issue.estimateUsd}}. Labelled agent-ready: assign it to @${brand.slug}-bot to start.` }, 'Say what it would cost');
    const large = b.node('linear', 'action', ['comment'], 3, 1.8, { body: 'An agent run for this is estimated at ${{issue.estimateUsd}}, more than an unattended run should take. Split it into smaller tickets, or run it by hand with a budget.' }, 'Say why it is too big');
    b.edge(trigger, estimate, 'issue', 'issue');
    b.edge(estimate, cond, 'issue', 'in');
    b.edge(cond, label, 'true', 'in');
    b.edge(label, small, 'out', 'in');
    b.edge(cond, large, 'false', 'in');
  },
  'code-scanning-fix': (b, brand) => {
    const trigger = b.node('codeql', 'trigger', ['alert-created'], 0, 1, { severity: 'high' });
    const budget = b.node('gates', 'action', ['budget'], 1, 1, { maxRunCostUsd: 10, maxDailyCostUsd: 30, confirmAboveUsd: 12 });
    const pipeline = b.node('pipeline', 'action', ['run'], 2, 1, { ...PIPELINE, review: 'thorough', branchPrefix: `${brand.slug}/security` });
    const deliver = b.node('delivery', 'action', ['deliver'], 3, 1, { policy: 'pr', draft: true, reviewers: 'acme/security', labels: 'security', prTitle: 'Fix code scanning alert: {{issue.title}}' });
    const post = b.node('slack', 'action', ['share-pr'], 4, 1, { channel: '#security', text: 'Code scanning ({{issue.severity}}): {{issue.title}}. A fix is ready for review: {{run.prUrl}}' });
    const refused = b.node('slack', 'action', ['post-message'], 2, 2.4, { channel: '#security', text: "New {{issue.severity}} code scanning alert: {{issue.title}}. Today's budget for automatic fixes is spent, so it needs a person: {{issue.url}}" }, 'Tell #security it needs a person');
    b.edge(trigger, budget, 'issue', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(budget, refused, 'refused', 'in');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(deliver, post, 'change', 'change');
  },
  'dependency-upgrades': (b, brand) => {
    const trigger = b.node('schedule', 'trigger', ['cron'], 0, 1, { cron: '0 6 * * 1', timezone: 'Europe/London' }, 'Mondays at 06:00');
    const ask = b.node('github-issues', 'action', ['create-issue'], 1, 1, {
      title: 'Weekly dependency upgrades',
      body: 'Upgrade every dependency to its latest minor and patch release, and any major release whose migration guide is short. Fix whatever the upgrades break, and run the full test suite.\n\nLeave out majors that need a real migration, and list them in the pull request with a line on what each would take.',
      labels: 'dependencies',
    }, 'Write down the ask');
    const budget = b.node('gates', 'action', ['budget'], 2, 1, { maxRunCostUsd: 12, maxDailyCostUsd: 12, confirmAboveUsd: 15 });
    const pipeline = b.node('pipeline', 'action', ['run'], 3, 1, { ...PIPELINE, branchPrefix: `${brand.slug}/deps` });
    const deliver = b.node('delivery', 'action', ['deliver'], 4, 1, { policy: 'pr', draft: true, labels: 'dependencies', prTitle: 'Weekly dependency upgrades' });
    const post = b.node('slack', 'action', ['share-pr'], 5, 1, { channel: '#eng', text: "This week's dependency upgrades are ready for review, CI included: {{run.prUrl}}" });
    b.edge(trigger, ask, 'out', 'in');
    b.edge(ask, budget, 'issue', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(deliver, post, 'change', 'change');
  },
  'flag-cleanup': (b, brand) => {
    const trigger = b.node('launchdarkly', 'trigger', ['flag-stale'], 0, 1, { environment: 'production', days: 30 });
    const budget = b.node('gates', 'action', ['budget'], 1, 1, { maxRunCostUsd: 4, maxDailyCostUsd: 12, confirmAboveUsd: 6 });
    const pipeline = b.node('pipeline', 'action', ['run'], 2, 1, { ...PIPELINE, review: 'light', branchPrefix: `${brand.slug}/flags` });
    const deliver = b.node('delivery', 'action', ['deliver'], 3, 1, { policy: 'pr', draft: true, labels: 'flag-cleanup', prTitle: 'Remove the {{issue.flagKey}} flag' });
    const post = b.node('slack', 'action', ['share-pr'], 4, 1, { channel: '#eng', text: '{{issue.flagKey}} has served one variation to everyone for a month. Removal PR: {{run.prUrl}}' });
    b.edge(trigger, budget, 'issue', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(deliver, post, 'change', 'change');
  },
};

/** A blank workflow with one manual trigger, for "New workflow". */
export function blankWorkflow(brand: Brand, repository = ''): Workflow {
  const now = new Date().toISOString();
  const typeId = 'logic.trigger.manual';
  const def = getNodeType(typeId);
  return {
    id: `wf_${nanoid(10)}`,
    name: 'Untitled workflow',
    description: '',
    nodes: def === undefined ? [] : [{ id: `n_${nanoid(8)}`, type: 'wf', position: { x: 120, y: 200 }, data: { typeId, config: defaultConfig(def) } }],
    edges: [],
    enabled: false,
    createdAt: now,
    updatedAt: now,
    repository,
  };
}

/**
 * A new workflow that starts from one specific trigger instead of the manual
 * one, for "Start a workflow with this" on the Integrations page. Disabled,
 * like a blank workflow, until somebody wires up what should happen next.
 */
export function workflowFromTrigger(triggerTypeId: string, brand: Brand, repository = ''): Workflow | undefined {
  const def = getNodeType(triggerTypeId);
  if (def === undefined || def.kind !== 'trigger') return undefined;
  const base = blankWorkflow(brand, repository);
  return {
    ...base,
    name: `${def.connector.name}: ${def.name}`,
    description: `Starts from the ${def.connector.name} trigger “${def.name}”. ${def.description}`.trim(),
    nodes: [{ id: `n_${nanoid(8)}`, type: 'wf', position: { x: 120, y: 200 }, data: { typeId: def.id, config: defaultConfig(def) } }],
  };
}
