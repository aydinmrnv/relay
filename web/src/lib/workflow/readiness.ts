/**
 * What running a workflow for real looks like today, in one line, so a
 * template never reads as more finished than it is.
 *
 * Only a GitHub issue event can start an exported workflow on its own: the
 * Action fires on it directly. Every other trigger is designed, validated and
 * test-run here, and runs for real when a person starts it on their machine or
 * Relay Cloud with the ticket or a description. The steps before and after the
 * pipeline (Slack, Linear, Zendesk…) are simulated until app connections ship.
 * See docs/design/workflow-execution.md for the plan that closes the gap.
 */
import { getNodeType } from '../connectors';
import type { Workflow } from './schema';

/**
 * Steps a test run plays that nothing performs for real: not the CLI, not
 * the exported Action. They are worth drawing — a Condition says what the
 * workflow is meant to decide — but they must not read as working.
 */
export const SIMULATED_ONLY: ReadonlySet<string> = new Set([
  'gates.action.approval',
  'http.trigger.webhook',
  'logic.action.condition',
  'logic.action.filter',
  'logic.action.transform',
  'logic.action.ai-step',
  'logic.action.merge-paths',
  'pipeline.action.estimate',
  'schedule.action.delay',
  'schedule.action.business-hours',
]);

export function isSimulatedOnly(typeId: string): boolean {
  return SIMULATED_ONLY.has(typeId);
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
    return { unattended: false, headline: 'Started by hand', detail: 'Run it on your computer or Relay Cloud with an issue or a description.' };
  }
  if (GITHUB_NATIVE.has(trigger.connectorId)) {
    return { unattended: true, headline: 'Runs unattended today', detail: 'Export it: the GitHub Action starts on the issue event, behind the same guardrails.' };
  }
  return {
    unattended: false,
    headline: 'Test it here, run it by hand',
    detail: `Starting it from ${trigger.connector.name} events is not wired up yet. Test runs play every node; a real run on your computer or Relay Cloud does the pipeline and delivery.`,
  };
}
