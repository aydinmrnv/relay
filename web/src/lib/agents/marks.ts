import type { ConnectorIcon } from '@/lib/connectors/types';
import { AGENT_META, type AgentId } from './types';

/**
 * The coding agents' marks. The agents are not apps in the connector catalog
 * (they are the engine's own roles, not something a workflow connects to), so
 * their icons live here rather than being looked up there: a catalog change
 * must never blank the hero, onboarding or Settings.
 */
export const AGENT_MARKS: Record<AgentId, { name: string; icon: ConnectorIcon }> = {
  claude: { name: AGENT_META.claude.name, icon: { si: 'SiClaude', color: '#D97757' } },
  codex: { name: AGENT_META.codex.name, icon: { lucide: 'SquareTerminal', color: '#10A37F' } },
};

export function agentMark(id: string): { name: string; icon: ConnectorIcon } | undefined {
  return id === 'claude' || id === 'codex' ? AGENT_MARKS[id] : undefined;
}
