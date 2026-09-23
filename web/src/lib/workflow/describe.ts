/**
 * A workflow, read aloud.
 *
 * Walks the graph from its trigger and turns it into ordered steps a person can
 * read without knowing what a port is: "When a Linear issue is assigned, check
 * the budget; if refused, post to #eng-agents…". The builder shows it as the
 * workflow's summary and the templates page as a walkthrough, so both say the
 * same thing about the same graph.
 */
import { getNodeType, type NodeTypeDef } from '../connectors';
import type { Workflow, WorkflowEdge, WorkflowNode } from './schema';

export interface DescribedStep {
  nodeId: string;
  def: NodeTypeDef;
  /** Node label if the user renamed it, otherwise the node type's name. */
  title: string;
  /** What this node will do, with its configuration folded in where it helps. */
  sentence: string;
  /** Nesting under a branch: 0 for the main line. */
  depth: number;
  /** The branch this step sits on, e.g. "If refused" or "If true". */
  branch?: string;
}

export interface WorkflowDescription {
  steps: DescribedStep[];
  /** Nodes no trigger reaches: they will never run. */
  unreachable: DescribedStep[];
  /** Connector ids used, core excluded, for "you will need to connect…". */
  apps: string[];
  /** Coding agents the pipeline nodes use. */
  agents: string[];
}

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', aider: 'Aider' };

const BRANCH_PHRASES: Record<string, string> = {
  pass: 'If it passes',
  refused: 'If refused',
  approved: 'If approved',
  rejected: 'If rejected',
  true: 'If true',
  false: 'If false',
};

export function describeWorkflow(workflow: Workflow): WorkflowDescription {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of workflow.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }

  const steps: DescribedStep[] = [];
  const seen = new Set<string>();

  const visit = (node: WorkflowNode, depth: number, branch?: string) => {
    if (seen.has(node.id)) return;
    const def = getNodeType(node.data.typeId);
    if (def === undefined || def.id === 'logic.action.note') return;
    seen.add(node.id);
    steps.push({ nodeId: node.id, def, title: node.data.label ?? def.name, sentence: sentenceFor(node, def), depth, ...(branch === undefined ? {} : { branch }) });

    const edges = [...(outgoing.get(node.id) ?? [])].sort((a, b) => handleRank(def, a) - handleRank(def, b));
    const branching = def.outputs.length > 1;
    for (const edge of edges) {
      const target = byId.get(edge.target);
      if (target === undefined) continue;
      const handle = edge.sourceHandle ?? def.outputs[0]?.id ?? '';
      // The first, "happy" output continues the main line; the others indent.
      const isMain = !branching || handle === def.outputs[0]?.id;
      const label = branching ? (BRANCH_PHRASES[handle] ?? `If ${def.outputs.find((port) => port.id === handle)?.label.toLowerCase() ?? handle}`) : undefined;
      visit(target, isMain ? depth : depth + 1, isMain ? (branching ? label : undefined) : label);
    }
  };

  const triggers = workflow.nodes.filter((node) => getNodeType(node.data.typeId)?.kind === 'trigger');
  for (const trigger of triggers) visit(trigger, 0);

  const unreachable: DescribedStep[] = [];
  for (const node of workflow.nodes) {
    if (seen.has(node.id)) continue;
    const def = getNodeType(node.data.typeId);
    if (def === undefined || def.id === 'logic.action.note') continue;
    unreachable.push({ nodeId: node.id, def, title: node.data.label ?? def.name, sentence: sentenceFor(node, def), depth: 0 });
  }

  const apps = [...new Set(workflow.nodes.map((node) => getNodeType(node.data.typeId)).filter((def): def is NodeTypeDef => def !== undefined && def.connector.category !== 'core').map((def) => def.connectorId))];
  const agents = [
    ...new Set(
      workflow.nodes
        .filter((node) => getNodeType(node.data.typeId)?.connectorId === 'pipeline')
        .flatMap((node) => ['planner', 'planReviewer', 'implementer', 'codeReviewer'].map((role) => node.data.config[role]))
        .filter((agent): agent is string => typeof agent === 'string' && agent.length > 0),
    ),
  ];

  return { steps, unreachable, apps, agents };
}

/** One node's sentence on its own, for the inspector. */
export function describeNode(node: WorkflowNode): string | undefined {
  const def = getNodeType(node.data.typeId);
  return def === undefined ? undefined : sentenceFor(node, def);
}

function handleRank(def: NodeTypeDef, edge: WorkflowEdge): number {
  const index = def.outputs.findIndex((port) => port.id === (edge.sourceHandle ?? def.outputs[0]?.id));
  return index < 0 ? 99 : index;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function money(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value % 1 === 0 ? value : value.toFixed(2)}` : null;
}

/** One sentence per node. Specific where the configuration says something worth reading, generic otherwise. */
function sentenceFor(node: WorkflowNode, def: NodeTypeDef): string {
  const config = node.data.config;
  switch (def.id) {
    case 'pipeline.action.run': {
      const planner = AGENT_NAMES[text(config['planner'])] ?? 'one agent';
      const planReviewer = AGENT_NAMES[text(config['planReviewer'])] ?? 'another';
      const implementer = AGENT_NAMES[text(config['implementer'])] ?? 'one agent';
      const codeReviewer = AGENT_NAMES[text(config['codeReviewer'])] ?? 'another';
      const level = text(config['review']) || 'standard';
      const tests = config['runTests'] === false ? 'without running the tests' : 'then runs the test suite';
      return `${planner} writes a plan and ${planReviewer} reviews it; ${implementer} implements and ${codeReviewer} reviews the diff (${level} review), ${tests} — all on a fresh branch in an isolated worktree.`;
    }
    case 'pipeline.action.fast':
      return `${AGENT_NAMES[text(config['implementer'])] ?? 'One agent'} plans and implements in one go, with no reviews${config['runTests'] === false ? '' : '; only the test suite checks the work'}.`;
    case 'pipeline.action.estimate':
      return 'Prices the run from the issue and the repository before any agent starts.';
    case 'gates.action.budget': {
      const run = money(config['maxRunCostUsd']);
      const day = money(config['maxDailyCostUsd']);
      return `Refuses to start if this run could cost more than ${run ?? 'the per-run limit'} or today's total would pass ${day ?? 'the daily limit'}.`;
    }
    case 'gates.action.allowlist': {
      const authors = text(config['authors']).split('\n').map((line) => line.trim()).filter(Boolean);
      return authors.length === 0 ? 'Lets nobody through yet: the allowlist is empty.' : `Only continues if the request came from ${authors.slice(0, 3).join(', ')}${authors.length > 3 ? ` or ${authors.length - 3} more` : ''}.`;
    }
    case 'gates.action.approval':
      return `Waits for ${text(config['approvers']).split('\n')[0] || 'a person'} to approve${text(config['via']) ? ` (${text(config['via'])})` : ''}, for up to ${text(config['timeoutHours']) || '24'} hours.`;
    case 'gates.action.kill-switch':
      return config['enabled'] === true ? 'Checks the kill switch; unattended runs are currently allowed.' : 'Checks the kill switch; it is off, so nothing past this point runs.';
    case 'gates.action.concurrency':
      return `Lets at most ${text(config['maxConcurrentRuns']) || '1'} run(s) go at once for this repository; the rest wait.`;
    case 'delivery.action.deliver': {
      const policy = text(config['policy']);
      const how: Record<string, string> = {
        none: 'Leaves the change in the worktree for you to look at.',
        branch: 'Commits the change to a local branch.',
        push: 'Commits and pushes the branch, without opening a pull request.',
        pr: `Commits, pushes and opens a ${config['draft'] === false ? '' : 'draft '}pull request for a person to review.`,
        merge: 'Commits, pushes, opens a pull request and merges it once checks pass.',
      };
      return how[policy] ?? def.description;
    }
    case 'logic.action.condition':
      return `Checks whether ${text(config['left']) || 'a field'} ${text(config['op']) || 'contains'} “${text(config['right'])}”, and branches.`;
    case 'logic.action.ai-step':
      return 'Asks a model one question — to triage, classify or summarise — and passes the answer on.';
    case 'logic.trigger.manual':
      return 'Starts when you press Run, with the prompt you give it.';
    case 'schedule.trigger.cron':
      return `Starts on a schedule (${text(config['cron']) || 'cron'}${text(config['timezone']) ? `, ${text(config['timezone'])}` : ''}).`;
    default: {
      const channel = text(config['channel']);
      if (channel.length > 0 && def.kind === 'action') return `${def.description.replace(/\.$/, '')} — in ${channel}.`;
      return def.kind === 'trigger' ? `Starts when this happens in ${def.connector.name}: ${def.description.charAt(0).toLowerCase()}${def.description.slice(1)}` : def.description;
    }
  }
}
