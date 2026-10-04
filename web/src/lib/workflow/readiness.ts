/**
 * What running a workflow for real looks like today, in one line, so a
 * template never reads as more finished than it is.
 *
 * Three things can run a workflow. A test run plays every node here, for
 * free. `relay workflow` (the CLI, and Run on your computer) walks the same
 * graph and performs it: which steps it performs is `./engine/support`, a
 * table the engine and the studio share byte for byte. The exported GitHub
 * Action is narrower than both: it runs the pipeline for one GitHub issue and
 * the app steps it can place, and cannot make a decision the canvas draws.
 */
import { getNodeType } from '../connectors';
import { nodeSupport, testRunsOnly, type NodeSupport } from './engine/support';
import type { Workflow } from './schema';

export { nodeSupport, type NodeSupport };

/** Whether nothing but a test run plays this step: the engine does not perform it, and it cannot be handed to a bridge. */
export function isSimulatedOnly(typeId: string): boolean {
  return testRunsOnly(typeId);
}

/**
 * Steps the exported GitHub Action does not perform, though `relay workflow`
 * does. The Action decides the allowlist and the budget inside Relay and then
 * runs the pipeline on the issue it was given; nothing in a workflow file
 * evaluates a Condition, waits for a person or asks a model.
 */
export const ACTION_CANNOT: ReadonlySet<string> = new Set([
  'gates.action.approval',
  'logic.action.condition',
  'logic.action.filter',
  'logic.action.transform',
  'logic.action.ai-step',
  'logic.action.merge-paths',
  'pipeline.action.estimate',
  'schedule.action.delay',
  'schedule.action.business-hours',
]);

export interface RealRunGap {
  nodeId: string;
  name: string;
  /** Handed to the person's bridge when they have one; skipped otherwise. */
  bridge: boolean;
  note: string;
}

/** The steps of a workflow a real run does not perform itself, and why. Empty when it performs every one. */
export function realRunGaps(workflow: Workflow): RealRunGap[] {
  const gaps: RealRunGap[] = [];
  for (const node of workflow.nodes) {
    const def = getNodeType(node.data.typeId);
    if (def === undefined || def.kind !== 'action') continue;
    const support = nodeSupport(def.id);
    if (support.real) continue;
    const label = typeof node.data.label === 'string' && node.data.label.trim().length > 0 ? node.data.label.trim() : `${def.connector.name} · ${def.name}`;
    gaps.push({ nodeId: node.id, name: label, bridge: support.bridge, note: support.note });
  }
  return gaps;
}

export interface Readiness {
  /** An event can start it with nobody pressing anything. */
  unattended: boolean;
  headline: string;
  detail: string;
}

const GITHUB_NATIVE = new Set(['github-issues']);

export function readiness(workflow: Workflow): Readiness {
  const trigger = workflow.nodes.map((node) => getNodeType(node.data.typeId)).find((def) => def?.kind === 'trigger');
  if (trigger === undefined || trigger.id === 'logic.trigger.manual') {
    return { unattended: false, headline: 'Started by hand', detail: 'Run it on your computer with an issue or a description: the guardrails, the pipeline and the steps after it all run for real.' };
  }
  if (GITHUB_NATIVE.has(trigger.connectorId)) {
    const served = nodeSupport(trigger.id).real ? ' On a machine of your own, relay workflow serve watches for the label and runs every step.' : '';
    return { unattended: true, headline: 'Runs unattended today', detail: `Export it: the GitHub Action starts on the issue event, behind the same guardrails.${served}` };
  }
  if (nodeSupport(trigger.id).real) {
    return { unattended: true, headline: 'Runs unattended today', detail: `Export it and run relay workflow serve on a machine of your own: it keeps this trigger (${trigger.name.toLowerCase()}) and runs every step each time it fires.` };
  }
  return {
    unattended: false,
    headline: 'Test it here, run it by hand',
    detail: `Nothing listens for ${trigger.connector.name} events yet. Point ${trigger.connector.name}’s webhook at an Incoming webhook trigger to start it by itself, or run it by hand: a real run performs every step it can and says which it could not.`,
  };
}
