import type { PortType } from '@/lib/connectors';

/**
 * Port colours and names, shared by the nodes, the legend, the inspector and
 * the picker. A small, quiet set (globals.css, --port-*): cyan for a ticket,
 * grey for a finished run, ink for a branch or pull request.
 */
export const PORT_STYLE: Record<PortType, { dot: string; label: string; noun: string }> = {
  issue: { dot: 'bg-(--port-issue)', label: 'ticket', noun: 'a ticket' },
  run: { dot: 'bg-(--port-run)', label: 'run', noun: 'a finished run' },
  change: { dot: 'bg-(--port-change)', label: 'PR / branch', noun: 'a branch or pull request' },
  message: { dot: 'bg-(--port-message)', label: 'message', noun: 'a message' },
  event: { dot: 'bg-(--port-event)', label: 'event', noun: 'an event' },
  any: { dot: 'bg-(--port-any)', label: 'anything', noun: 'anything' },
};

export const PORT_LEGEND: PortType[] = ['issue', 'run', 'change', 'event', 'any'];
