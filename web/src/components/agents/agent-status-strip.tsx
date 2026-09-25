'use client';

import Link from 'next/link';
import { useAgentsStore } from '@/hooks/use-agent-accounts';
import { AGENT_IDS, AGENT_META } from '@/lib/agents/types';
import { cn } from '@/lib/utils';

/** Small "who is signed in on the paired machine" line, for the pipeline inspector. */
export function AgentStatusStrip({ used }: { used: string[] }) {
  const bridge = useAgentsStore((state) => state.bridge);
  const status = useAgentsStore((state) => state.status);
  if (bridge !== 'available' || status === null) return null;
  const missing = AGENT_IDS.filter((id) => used.includes(id) && !status.agents[id].loggedIn);
  return (
    <div className={cn('rounded-lg border p-2.5 text-xs', missing.length > 0 ? 'border-warning/40 bg-warning/10' : 'bg-muted/40')}>
      <p className="mb-1 font-medium">Agents on your machine</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {AGENT_IDS.map((id) => {
          const account = status.agents[id];
          return (
            <li key={id} className="flex items-center gap-1.5">
              <span className="font-medium">{AGENT_META[id].name}</span>
              <span className="text-muted-foreground">{account.loggedIn ? (account.method === 'subscription' ? `subscription${account.plan ? ` · ${account.plan}` : ''}` : account.method === 'api-key' ? 'API key' : 'signed in') : account.installed ? 'not signed in' : 'not installed'}</span>
            </li>
          );
        })}
      </ul>
      {missing.length > 0 ? (
        <p className="mt-1.5 text-amber-800 dark:text-warning">
          This node uses {missing.map((id) => AGENT_META[id].name).join(' and ')}, which {missing.length === 1 ? 'is' : 'are'} not signed in. A real run would stop at the first turn.{' '}
          <Link href="/settings" className="underline underline-offset-2">
            Sign in
          </Link>
        </p>
      ) : null}
    </div>
  );
}
