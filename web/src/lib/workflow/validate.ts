import { getNodeType, type NodeTypeDef, type PortType } from '../connectors';
import type { Workflow, WorkflowEdge, WorkflowNode } from './schema';

export type IssueLevel = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  level: IssueLevel;
  message: string;
  hint?: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  errors: number;
  warnings: number;
}

/** Agents that cannot be confined to read-only, so they may never review. Mirrors `assertReviewRolesEnforceable`. */
const UNCONFINABLE_REVIEWERS = new Set(['aider']);

export function portsCompatible(a: PortType, b: PortType): boolean {
  return a === 'any' || b === 'any' || a === b;
}

export function resolveNode(node: WorkflowNode): NodeTypeDef | undefined {
  return getNodeType(node.data.typeId);
}

export function isTriggerNode(node: WorkflowNode): boolean {
  return resolveNode(node)?.kind === 'trigger';
}

export function isUnattendedTrigger(node: WorkflowNode): boolean {
  const def = resolveNode(node);
  if (def === undefined || def.kind !== 'trigger') return false;
  return def.id !== 'logic.trigger.manual';
}

export interface ValidationContext {
  /** Which agents are signed in on this machine, when the local bridge knows. Missing = unknown, never assumed. */
  signedIn?: Partial<Record<string, boolean>>;
}

export function validateWorkflow(workflow: Workflow, context: ValidationContext = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const nodes = workflow.nodes;
  const edges = workflow.edges;
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // Unknown node types (a catalog entry was renamed, or an import from elsewhere).
  for (const node of nodes) {
    if (resolveNode(node) === undefined) {
      issues.push({ level: 'error', nodeId: node.id, message: `Unknown node type "${node.data.typeId}".`, hint: 'Delete it and drag the node in again from the palette.' });
    }
  }

  const triggers = nodes.filter(isTriggerNode);
  if (triggers.length === 0) {
    issues.push({ level: 'error', message: 'The workflow has no trigger.', hint: 'Every workflow starts with something that happened: a ticket assigned, a label applied, a schedule.' });
  }

  // Edges: endpoints exist, ports exist, types line up.
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) {
      issues.push({ level: 'error', edgeId: edge.id, message: 'A connection points at a node that no longer exists.' });
      continue;
    }
    const sourceDef = resolveNode(source);
    const targetDef = resolveNode(target);
    if (sourceDef === undefined || targetDef === undefined) continue;
    const out = sourceDef.outputs.find((port) => port.id === (edge.sourceHandle ?? sourceDef.outputs[0]?.id));
    const inp = targetDef.inputs.find((port) => port.id === (edge.targetHandle ?? targetDef.inputs[0]?.id));
    if (out === undefined || inp === undefined) {
      issues.push({ level: 'error', edgeId: edge.id, message: `Connection between ${sourceDef.name} and ${targetDef.name} uses a port that does not exist.` });
      continue;
    }
    if (!portsCompatible(out.type, inp.type)) {
      issues.push({
        level: 'error',
        edgeId: edge.id,
        message: `${sourceDef.name} produces a ${out.type}, but ${targetDef.name} expects a ${inp.type}.`,
        hint: inp.type === 'issue' ? 'Put an AI step or a "create issue" action in between to turn the event into a ticket.' : inp.type === 'run' ? 'Only the agent pipeline produces a run.' : undefined,
      });
    }
  }

  // Reachability and dangling nodes.
  const outgoing = groupBy(edges, (edge) => edge.source);
  const incoming = groupBy(edges, (edge) => edge.target);
  const reachable = new Set<string>();
  const stack = triggers.map((node) => node.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of outgoing.get(id) ?? []) stack.push(edge.target);
  }
  for (const node of nodes) {
    const def = resolveNode(node);
    if (def === undefined) continue;
    if (def.id === 'logic.action.note') continue;
    if (!reachable.has(node.id)) {
      issues.push({ level: 'warning', nodeId: node.id, message: `${def.name} is not connected to a trigger and will never run.` });
    } else if (def.outputs.length > 0 && (outgoing.get(node.id) ?? []).length === 0 && def.kind === 'trigger') {
      issues.push({ level: 'warning', nodeId: node.id, message: `${def.name} triggers nothing.`, hint: 'Connect it to the agent pipeline, or to a gate in front of it.' });
    }
    if (def.kind === 'action' && def.inputs.length > 0 && (incoming.get(node.id) ?? []).length === 0 && def.id !== 'logic.action.note') {
      issues.push({ level: 'warning', nodeId: node.id, message: `${def.name} has nothing feeding into it.` });
    }
  }

  // Cycles.
  if (hasCycle(nodes, outgoing)) {
    issues.push({ level: 'error', message: 'The workflow contains a loop.', hint: 'Runs must finish. Review rounds are already bounded inside the pipeline node.' });
  }

  // Pipeline-specific rules.
  const pipelines = nodes.filter((node) => resolveNode(node)?.connectorId === 'pipeline' && resolveNode(node)?.specId !== 'estimate');
  if (pipelines.length === 0) {
    issues.push({ level: 'info', message: 'No agent pipeline in this workflow.', hint: 'That is fine for pure automation, but nothing will write code.' });
  }
  for (const node of pipelines) {
    const config = node.data.config;
    for (const role of ['planReviewer', 'codeReviewer'] as const) {
      const agent = String(config[role] ?? '');
      if (UNCONFINABLE_REVIEWERS.has(agent)) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: `${agent} cannot be the ${role === 'planReviewer' ? 'plan reviewer' : 'code reviewer'}: it has no read-only mode.`,
          hint: 'A reviewer that can edit the code it reviews breaks the guarantee reviews rest on. Use Claude Code or Codex for review roles.',
        });
      }
    }
    if (config['planner'] !== undefined && config['planner'] === config['planReviewer']) {
      issues.push({ level: 'warning', nodeId: node.id, message: 'The same model plans and reviews the plan.', hint: 'Cross-model review is the point: give the review to the other CLI.' });
    }
    if (config['implementer'] !== undefined && config['implementer'] === config['codeReviewer']) {
      issues.push({ level: 'warning', nodeId: node.id, message: 'The same model implements and reviews the diff.', hint: 'Nobody should grade their own homework.' });
    }
    if (context.signedIn !== undefined) {
      const used = new Set(['planner', 'planReviewer', 'implementer', 'codeReviewer'].map((role) => String(config[role] ?? '')).filter(Boolean));
      const notSignedIn = [...used].filter((agent) => context.signedIn?.[agent] === false);
      const names: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
      for (const agent of notSignedIn) {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          message: `${names[agent] ?? agent} is not signed in on this machine.`,
          hint: 'A real run would stop at its first turn. Sign in from Settings, with your own subscription; nothing is billed by the studio.',
        });
      }
    }
  }

  // Delivery: merge is never allowed when nobody is present.
  const unattended = triggers.some(isUnattendedTrigger);
  for (const node of nodes) {
    const def = resolveNode(node);
    if (def?.id !== 'delivery.action.deliver') continue;
    if (unattended && node.data.config['policy'] === 'merge') {
      issues.push({
        level: 'error',
        nodeId: node.id,
        message: 'An unattended run may not merge.',
        hint: 'A ticket assignment starts this run with nobody watching. Deliver as a pull request and let a person merge.',
      });
    }
  }

  // Guardrails are opt-in, and their absence is worth saying out loud.
  if (unattended && pipelines.length > 0) {
    const hasBudget = nodes.some((node) => resolveNode(node)?.id === 'gates.action.budget');
    const hasAllowlist = nodes.some((node) => resolveNode(node)?.id === 'gates.action.allowlist');
    if (!hasBudget) {
      issues.push({ level: 'warning', message: 'No budget gate.', hint: 'Anyone who can trigger this can spend money. Put a Budget gate between the trigger and the pipeline.' });
    }
    if (!hasAllowlist) {
      issues.push({ level: 'warning', message: 'No author allowlist.', hint: 'On a public repository, a drive-by label is a funded denial-of-wallet attack.' });
    }
  }

  // Required fields.
  for (const node of nodes) {
    const def = resolveNode(node);
    if (def === undefined) continue;
    for (const field of def.fields) {
      if (field.required !== true) continue;
      const value = node.data.config[field.key];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) {
        issues.push({ level: 'error', nodeId: node.id, message: `${def.name}: "${field.label}" is required.` });
      }
    }
  }

  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.filter((issue) => issue.level === 'warning').length;
  return { ok: errors === 0, issues, errors, warnings };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

function hasCycle(nodes: WorkflowNode[], outgoing: Map<string, WorkflowEdge[]>): boolean {
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const current = state.get(id) ?? 0;
    if (current === 1) return true;
    if (current === 2) return false;
    state.set(id, 1);
    for (const edge of outgoing.get(id) ?? []) if (visit(edge.target)) return true;
    state.set(id, 2);
    return false;
  };
  return nodes.some((node) => visit(node.id));
}
