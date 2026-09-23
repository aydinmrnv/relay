/**
 * Repairs saved graphs whose connections name ports that do not exist.
 *
 * Earlier builds of the starter templates wired some edges with guessed handle
 * ids ("out", "in", "change"), and a browser keeps what it was given. On load,
 * each such edge is pointed at the real port — the one with that id if it
 * exists, otherwise the first one whose type fits — so old workflows stop
 * reporting errors nobody introduced. Type mismatches are left alone: those
 * are real, and the validator explains them.
 */
import { getNodeType, type PortType } from '../connectors';
import { portsCompatible } from './validate';
import type { Workflow } from './schema';

export function repairEdges(workflow: Workflow): Workflow {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  let changed = false;
  const edges = workflow.edges.map((edge) => {
    const source = getNodeType(byId.get(edge.source)?.data.typeId ?? '');
    const target = getNodeType(byId.get(edge.target)?.data.typeId ?? '');
    if (source === undefined || target === undefined) return edge;
    const out = source.outputs.find((port) => port.id === edge.sourceHandle) ?? (edge.sourceHandle == null ? undefined : source.outputs[0]);
    const fits = (port: { type: PortType }) => out === undefined || portsCompatible(out.type, port.type);
    const inputOk = target.inputs.some((port) => port.id === edge.targetHandle);
    const inp = inputOk || edge.targetHandle == null ? undefined : (target.inputs.find(fits) ?? target.inputs[0]);
    const sourceHandle = out?.id ?? edge.sourceHandle ?? null;
    const targetHandle = inp?.id ?? edge.targetHandle ?? null;
    if (sourceHandle === (edge.sourceHandle ?? null) && targetHandle === (edge.targetHandle ?? null)) return edge;
    changed = true;
    return { ...edge, sourceHandle, targetHandle };
  });
  return changed ? { ...workflow, edges } : workflow;
}

/**
 * Two starter templates shipped with a real mistake, now fixed in
 * templates.ts, and copies of them live on in browsers that were seeded
 * before. Each repair applies only when the exact broken shape is present,
 * so a workflow somebody has since changed is left as they made it.
 */
export function repairKnownTemplateIssues(workflow: Workflow): Workflow {
  if (workflow.templateId === 'youtube-triage') {
    let changed = false;
    const nodes = workflow.nodes.map((node) => {
      if (node.data.typeId !== 'youtube.action.post-comment') return node;
      const videoId = node.data.config['videoId'];
      if (typeof videoId === 'string' && videoId.trim().length > 0) return node;
      changed = true;
      return { ...node, data: { ...node.data, config: { ...node.data.config, videoId: '{{issue.videoId}}' } } };
    });
    return changed ? { ...workflow, nodes } : workflow;
  }
  if (workflow.templateId === 'support-fix') {
    // The customer reply takes a finished run, but was wired from the delivered change.
    const typeOf = (id: string) => workflow.nodes.find((node) => node.id === id)?.data.typeId;
    const pipeline = workflow.nodes.find((node) => node.data.typeId === 'pipeline.action.run');
    if (pipeline === undefined) return workflow;
    let changed = false;
    const edges = workflow.edges.map((edge) => {
      if (typeOf(edge.source) !== 'delivery.action.deliver' || typeOf(edge.target) !== 'zendesk.action.reply-to-customer') return edge;
      changed = true;
      return { ...edge, source: pipeline.id, sourceHandle: 'run', targetHandle: 'run' };
    });
    return changed ? { ...workflow, edges } : workflow;
  }
  return workflow;
}
