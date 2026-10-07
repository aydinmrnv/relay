'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CircleDashed, Plug, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { ConnectDialog } from '@/components/integrations/connect-dialog';
import { ConnectionStatus } from '@/components/integrations/connection-status';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { checkConnection } from '@/lib/cloud/connections';
import { getConnector, type Connector } from '@/lib/connectors';
import { appsInUse, connectionState, STATE_ORDER, uncoveredNodes, type AppUsage, type ConnectionState } from '@/lib/connectors/connection-state';
import { credentialSpec } from '@/lib/connectors/credentials';
import { timeAgo } from '@/lib/format';
import type { Connection, Workflow } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';

/** A real connection checked longer ago than this is asked again when the dashboard opens. */
const STALE_MS = 12 * 3600_000;

interface Row {
  connector: Connector;
  state: ConnectionState;
  connection: Connection | undefined;
  usage: AppUsage;
}

export function appRows(workflows: Workflow[], connections: Record<string, Connection>): Row[] {
  const rows: Row[] = [];
  for (const usage of appsInUse(workflows).values()) {
    const connector = getConnector(usage.connectorId);
    if (connector === undefined) continue;
    rows.push({ connector, state: connectionState(connector, connections[connector.id]), connection: connections[connector.id], usage });
  }
  return rows.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.usage.workflows.length - a.usage.workflows.length || a.connector.name.localeCompare(b.connector.name));
}

/**
 * Real connections are asked again when they have not been for a while, so a
 * webhook revoked in Slack or a token that expired shows up here as failing
 * rather than at the next real run. Checking posts and changes nothing. Once
 * per connection per page load.
 */
const checkedThisLoad = new Set<string>();

function useStaleChecks(connections: Record<string, Connection>, now: number): void {
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const enabled = useCapabilities().credentials === true;
  useEffect(() => {
    if (!signedIn || !enabled) return;
    for (const connection of Object.values(connections)) {
      const checkedAt = connection.credential?.checkedAt;
      if (checkedAt === undefined || checkedThisLoad.has(connection.connectorId) || now - new Date(checkedAt).getTime() < STALE_MS) continue;
      checkedThisLoad.add(connection.connectorId);
      // No answer is not news: it stays as it was, and the next load asks again.
      void checkConnection(connection.connectorId).catch(() => checkedThisLoad.delete(connection.connectorId));
    }
  }, [connections, now, signedIn, enabled]);
}

/**
 * The apps the workflows use and whether a real run could talk to each: one
 * row per app, worst first, each with the one thing to do about it.
 */
export function ConnectionsCard({ workflows, connections, now, className }: { workflows: Workflow[]; connections: Record<string, Connection>; now: number; className?: string }) {
  const rows = useMemo(() => appRows(workflows, connections), [workflows, connections]);
  const [connecting, setConnecting] = useState<Connector | null>(null);
  useStaleChecks(connections, now);

  const count = (state: ConnectionState) => rows.filter((row) => row.state === state).length;
  const summary = [
    count('failing') > 0 ? `${count('failing')} failing` : null,
    count('missing') > 0 ? `${count('missing')} not connected` : null,
    count('marked') > 0 ? `${count('marked')} marked ready` : null,
    count('verified') > 0 ? `${count('verified')} connected` : null,
  ].filter((part): part is string => part !== null);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Apps your workflows use</CardTitle>
        <CardDescription>
          {rows.length === 0
            ? 'None yet. Built-in nodes need nothing; an app’s trigger or action shows up here with what it needs.'
            : `${summary.length === 0 ? 'Nothing to connect.' : `${summary.join(' · ')}.`} Test runs need none of it; a real run needs each one.`}
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={rows.length === 0 ? '/integrations' : '/integrations?filter=in-use'} />}>
            Integrations <ArrowRight data-icon="inline-end" />
          </Button>
        </CardAction>
      </CardHeader>
      {rows.length === 0 ? null : (
        <CardContent>
          <ul className="grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => (
              <AppRow key={row.connector.id} row={row} now={now} onConnect={() => setConnecting(row.connector)} />
            ))}
          </ul>
        </CardContent>
      )}
      <ConnectDialog connector={connecting} open={connecting !== null} onOpenChange={(open) => (open ? undefined : setConnecting(null))} />
    </Card>
  );
}

function AppRow({ row, now, onConnect }: { row: Row; now: number; onConnect: () => void }) {
  const { connector, state, connection, usage } = row;
  const real = credentialSpec(connector.id) !== undefined;
  const uncovered = state === 'verified' ? uncoveredNodes(connector.id, usage.nodes) : [];
  const names = usage.workflows.map((workflow) => workflow.name);
  const note =
    state === 'failing'
      ? connection?.credential?.error
      : state === 'verified' && connection?.credential !== undefined
        ? uncovered.length > 0
          ? `${uncovered.map((def) => def.name).join(', ')} need${uncovered.length === 1 ? 's' : ''} a full sign-in`
          : `Checked ${timeAgo(connection.credential.checkedAt, now)}`
        : null;

  return (
    <li className="flex items-center gap-3 border-t py-2.5">
      <ConnectorIcon connector={connector} size={16} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={`/integrations?app=${encodeURIComponent(connector.id)}`} className="truncate text-sm font-medium hover:underline">
            {connector.name}
          </Link>
          <ConnectionStatus state={state} connection={connection} needed compact className="shrink-0" />
        </div>
        <p className="truncate text-xs text-muted-foreground" title={names.join(', ')}>
          {names.length === 1 ? names[0] : `${names[0]} and ${names.length - 1} more`}
        </p>
        {note === null || note === undefined ? null : (
          <p className={cn('truncate text-xs', state === 'failing' ? 'text-destructive' : uncovered.length > 0 ? 'text-amber-700 dark:text-warning' : 'text-muted-foreground')} title={note}>
            {note}
          </p>
        )}
      </div>
      <RowAction state={state} real={real} connectorId={connector.id} onConnect={onConnect} />
    </li>
  );
}

function RowAction({ state, real, connectorId, onConnect }: { state: ConnectionState; real: boolean; connectorId: string; onConnect: () => void }) {
  if (state === 'missing' || (state === 'marked' && real)) {
    return (
      <Button size="xs" variant={state === 'missing' ? 'outline' : 'ghost'} className="shrink-0" onClick={onConnect}>
        {real ? <Plug data-icon="inline-start" /> : <CircleDashed data-icon="inline-start" />}
        {state === 'marked' ? 'Connect' : real ? 'Connect' : 'Mark ready'}
      </Button>
    );
  }
  if (state === 'failing') {
    return (
      <Button size="xs" variant="outline" className="shrink-0 border-destructive/40 text-destructive hover:text-destructive" nativeButton={false} render={<Link href={`/integrations?app=${encodeURIComponent(connectorId)}`} />}>
        <Wrench data-icon="inline-start" /> Fix
      </Button>
    );
  }
  return null;
}
