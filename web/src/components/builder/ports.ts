import type { PortType } from '@/lib/connectors';

/** Port colours and names, shared by the nodes, the legend, the inspector and the picker. */
export const PORT_STYLE: Record<PortType, { dot: string; label: string; noun: string }> = {
  issue: { dot: 'bg-sky-500', label: 'ticket', noun: 'a ticket' },
  run: { dot: 'bg-violet-500', label: 'run', noun: 'a finished run' },
  change: { dot: 'bg-indigo-600 dark:bg-indigo-400', label: 'PR / branch', noun: 'a branch or pull request' },
  message: { dot: 'bg-pink-500', label: 'message', noun: 'a message' },
  event: { dot: 'bg-zinc-400 dark:bg-zinc-500', label: 'event', noun: 'an event' },
  any: { dot: 'bg-zinc-300 dark:bg-zinc-600', label: 'anything', noun: 'anything' },
};

export const PORT_LEGEND: PortType[] = ['issue', 'run', 'change', 'event', 'any'];
