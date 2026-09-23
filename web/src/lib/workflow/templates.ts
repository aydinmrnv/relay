/**
 * Starter workflows. Each is built against the live catalog, so a template
 * never references a trigger or action id that does not exist: it asks for a
 * connector by id and picks the closest trigger/action by keyword.
 */
import { nanoid } from 'nanoid';
import type { Brand } from '../brand';
import { defaultConfig, getConnector, getNodeType, nodeTypeId, pickAction, pickTrigger, type NodeKind } from '../connectors';
import type { Workflow, WorkflowEdge, WorkflowNode } from './schema';

export interface TemplateMeta {
  id: string;
  name: string;
  description: string;
  connectors: string[];
  tags: string[];
}

export const TEMPLATES: TemplateMeta[] = [
  {
    id: 'ticket-to-pr',
    name: 'Ticket to pull request',
    description: 'Assign a Linear issue to the bot. It plans, gets reviewed, implements, gets reviewed again, tests, and opens a draft PR. Slack hears about it.',
    connectors: ['linear', 'gates', 'pipeline', 'delivery', 'slack'],
    tags: ['starter', 'linear', 'slack'],
  },
  {
    id: 'label-run',
    name: 'Label-triggered GitHub run',
    description: 'A label on a GitHub issue starts an unattended run behind an allowlist and a budget. The summary lands back on the issue.',
    connectors: ['github-issues', 'gates', 'pipeline', 'delivery'],
    tags: ['starter', 'github', 'unattended'],
  },
  {
    id: 'sentry-fix',
    name: 'Sentry error to fix',
    description: 'A new Sentry issue is triaged by a model. Regressions get a fast fix and a draft PR; the rest become a Linear ticket.',
    connectors: ['sentry', 'logic', 'pipeline', 'delivery', 'linear'],
    tags: ['observability', 'triage'],
  },
  {
    id: 'xcode-nightly',
    name: 'Xcode nightly build',
    description: 'Every weeknight, build and test the iOS app. A failing build becomes a ticket, the pipeline fixes it, and the team wakes up to a PR.',
    connectors: ['schedule', 'xcode', 'logic', 'linear', 'pipeline', 'delivery', 'slack'],
    tags: ['apple', 'schedule'],
  },
  {
    id: 'youtube-triage',
    name: 'YouTube comment to issue',
    description: 'Comments on your videos are classified by a model. Bug reports become GitHub issues and a Discord ping.',
    connectors: ['youtube', 'logic', 'github-issues', 'discord'],
    tags: ['community', 'social'],
  },
  {
    id: 'support-fix',
    name: 'Support ticket to fix, with approval',
    description: 'A Zendesk ticket tagged "bug" waits for a human to approve, then runs the pipeline and replies to the customer with the PR.',
    connectors: ['zendesk', 'gates', 'pipeline', 'delivery'],
    tags: ['support', 'approval'],
  },
];

interface Builder {
  node: (connectorId: string, kind: NodeKind, keywords: string[], col: number, row: number, config?: Record<string, unknown>, label?: string) => string | null;
  edge: (from: string | null, to: string | null, sourceHandle?: string, targetHandle?: string) => void;
}

const COL = 320;
const ROW = 190;

export function instantiateTemplate(templateId: string, brand: Brand, repository = 'acme/api'): Workflow | undefined {
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
      edges.push({ id: `e_${nanoid(8)}`, source: from, target: to, sourceHandle: sourceHandle ?? null, targetHandle: targetHandle ?? null });
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
    enabled: true,
    createdAt: now,
    updatedAt: now,
    templateId,
    repository,
  };
}

const BUDGET = { maxRunCostUsd: 6, maxDailyCostUsd: 40, confirmAboveUsd: 10 };
const PIPELINE = { review: 'standard', planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' };

const BUILDERS: Record<string, (b: Builder, brand: Brand) => void> = {
  'ticket-to-pr': (b, brand) => {
    const trigger = b.node('linear', 'trigger', ['assigned', 'assign'], 0, 1, { assignee: `@${brand.slug}-bot` });
    const budget = b.node('gates', 'action', ['budget'], 1, 1, BUDGET);
    const pipeline = b.node('pipeline', 'action', ['run the pipeline'], 2, 1, { ...PIPELINE, branchPrefix: brand.slug });
    const deliver = b.node('delivery', 'action', ['deliver'], 3, 1, { policy: 'pr', draft: true, labels: `${brand.slug}, needs-review` });
    const slack = b.node('slack', 'action', ['post', 'message', 'send'], 4, 0, { channel: '#eng-agents' });
    const linear = b.node('linear', 'action', ['comment', 'state', 'status', 'update'], 4, 2);
    const refused = b.node('slack', 'action', ['post', 'message', 'send'], 2, 2.6, { channel: '#eng-agents' }, 'Tell the channel it was refused');
    b.edge(trigger, budget, 'issue', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(budget, refused, 'refused', 'in');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(deliver, slack, 'change', 'in');
    b.edge(deliver, linear, 'change', 'in');
  },
  'label-run': (b, brand) => {
    const trigger = b.node('github-issues', 'trigger', ['label'], 0, 1, { label: `${brand.slug}:go` });
    const allow = b.node('gates', 'action', ['allowlist'], 1, 1, { authors: 'you\nalice\nbob', teams: 'acme/platform' });
    const budget = b.node('gates', 'action', ['budget'], 2, 1, BUDGET);
    const pipeline = b.node('pipeline', 'action', ['run the pipeline'], 3, 1, { ...PIPELINE, branchPrefix: brand.slug });
    const deliver = b.node('delivery', 'action', ['deliver'], 4, 1, { policy: 'pr', draft: true });
    const comment = b.node('delivery', 'action', ['comment'], 5, 1);
    const kill = b.node('gates', 'action', ['kill'], 1, 2.3, { enabled: true });
    b.edge(trigger, allow, 'issue', 'in');
    b.edge(allow, budget, 'pass', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(pipeline, comment, 'run', 'run');
    void kill;
  },
  'sentry-fix': (b, brand) => {
    const trigger = b.node('sentry', 'trigger', ['new issue', 'issue created', 'issue', 'alert'], 0, 1);
    const ai = b.node('logic', 'action', ['ai step'], 1, 1, { prompt: 'Is this a regression from the last release? Answer bug, feature or chore and estimate size.\n\n{{issue.title}}\n{{issue.body}}' });
    const cond = b.node('logic', 'action', ['condition'], 2, 1, { left: '{{issue.triage}}', op: 'contains', right: 'bug' });
    const fast = b.node('pipeline', 'action', ['fast'], 3, 0.4, { implementer: 'codex' });
    const deliver = b.node('delivery', 'action', ['deliver'], 4, 0.4, { policy: 'pr', draft: true, labels: `${brand.slug}, regression` });
    const ticket = b.node('linear', 'action', ['create'], 3, 1.8);
    b.edge(trigger, ai, 'issue', 'in');
    b.edge(ai, cond, 'out', 'in');
    b.edge(cond, fast, 'true', 'issue');
    b.edge(cond, ticket, 'false', 'in');
    b.edge(fast, deliver, 'run', 'run');
  },
  'xcode-nightly': (b, brand) => {
    const cron = b.node('schedule', 'trigger', ['schedule', 'cron'], 0, 1, { cron: '0 2 * * 1-5', timezone: 'Europe/London' });
    const build = b.node('xcode', 'action', ['test', 'build'], 1, 1, { scheme: 'App', destination: 'platform=iOS Simulator,name=iPhone 16' });
    const cond = b.node('logic', 'action', ['condition'], 2, 1, { left: '{{run.tests}}', op: 'not-equals', right: 'passed' }, 'Did anything fail?');
    const ticket = b.node('linear', 'action', ['create'], 3, 0.4, undefined, 'Create a ticket for the failure');
    const pipeline = b.node('pipeline', 'action', ['run the pipeline'], 4, 0.4, { ...PIPELINE, branchPrefix: brand.slug, review: 'light' });
    const deliver = b.node('delivery', 'action', ['deliver'], 5, 0.4, { policy: 'pr', draft: true });
    const slack = b.node('slack', 'action', ['post', 'message', 'send'], 6, 0.4, { channel: '#ios' });
    const ok = b.node('slack', 'action', ['post', 'message', 'send'], 3, 1.8, { channel: '#ios' }, 'Nightly is green');
    b.edge(cron, build, 'out', 'in');
    b.edge(build, cond, 'out', 'in');
    b.edge(cond, ticket, 'true', 'in');
    b.edge(cond, ok, 'false', 'in');
    b.edge(ticket, pipeline, 'out', 'issue');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(deliver, slack, 'change', 'in');
  },
  'youtube-triage': (b) => {
    const trigger = b.node('youtube', 'trigger', ['comment'], 0, 1);
    const ai = b.node('logic', 'action', ['ai step'], 1, 1, { prompt: 'Is this YouTube comment a bug report about the app? Reply bug or not-bug.\n\n{{issue.title}}' });
    const cond = b.node('logic', 'action', ['condition'], 2, 1, { left: '{{issue.triage}}', op: 'contains', right: 'bug' });
    const issue = b.node('github-issues', 'action', ['create'], 3, 0.4);
    const discord = b.node('discord', 'action', ['post', 'message', 'send'], 4, 0.4, { channel: '#community-bugs' });
    const thanks = b.node('youtube', 'action', ['comment', 'reply'], 3, 1.8, undefined, 'Say thanks');
    b.edge(trigger, ai, 'issue', 'in');
    b.edge(ai, cond, 'out', 'in');
    b.edge(cond, issue, 'true', 'in');
    b.edge(cond, thanks, 'false', 'in');
    b.edge(issue, discord, 'out', 'in');
  },
  'support-fix': (b, brand) => {
    const trigger = b.node('zendesk', 'trigger', ['ticket', 'created', 'tag'], 0, 1);
    const approval = b.node('gates', 'action', ['approval'], 1, 1, { via: 'chat', approvers: 'you', timeoutHours: 24 });
    const budget = b.node('gates', 'action', ['budget'], 2, 1, BUDGET);
    const pipeline = b.node('pipeline', 'action', ['run the pipeline'], 3, 1, { ...PIPELINE, branchPrefix: brand.slug });
    const deliver = b.node('delivery', 'action', ['deliver'], 4, 1, { policy: 'pr', draft: true });
    const reply = b.node('zendesk', 'action', ['reply', 'comment', 'respond'], 5, 1);
    b.edge(trigger, approval, 'issue', 'in');
    b.edge(approval, budget, 'approved', 'in');
    b.edge(budget, pipeline, 'pass', 'issue');
    b.edge(pipeline, deliver, 'run', 'run');
    b.edge(deliver, reply, 'change', 'in');
  },
};

/** A blank workflow with one manual trigger, for "New workflow". */
export function blankWorkflow(brand: Brand, repository = 'acme/api'): Workflow {
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

export { brandSlugFor };
function brandSlugFor(brand: Brand): string {
  return brand.slug;
}
