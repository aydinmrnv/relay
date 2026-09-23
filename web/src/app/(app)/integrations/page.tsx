'use client';

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Check, Plug, Search, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { IntegrationsCard, type IntegrationItem } from '@/components/watermelon/integration-card';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useStudio } from '@/lib/store';
import { CATALOG_STATS, CATEGORY_LABELS, CONNECTORS, connectorsByCategory, type AuthKind, type Connector } from '@/lib/connectors';
import { cn } from '@/lib/utils';

const AUTH_LABEL: Record<AuthKind, string> = {
  oauth: 'OAuth',
  'api-key': 'API key',
  token: 'Token',
  app: 'App install',
  local: 'Runs locally',
  none: 'No auth',
};

export default function IntegrationsPage() {
  return (
    <Suspense fallback={null}>
      <IntegrationsInner />
    </Suspense>
  );
}

function IntegrationsInner() {
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [category, setCategory] = useState<string>('all');
  const [connecting, setConnecting] = useState<Connector | null>(null);
  const connections = useStudio((state) => state.connections);
  const connect = useStudio((state) => state.connect);
  const disconnect = useStudio((state) => state.disconnect);

  const groups = useMemo(() => connectorsByCategory(), []);
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    return CONNECTORS.filter((connector) => connector.category !== 'core')
      .filter((connector) => category === 'all' || connector.category === category || (category === 'connected' && connections[connector.id] !== undefined))
      .filter((connector) => {
        if (needle.length === 0) return true;
        const hay = `${connector.name} ${connector.description} ${(connector.tags ?? []).join(' ')} ${CATEGORY_LABELS[connector.category]}`.toLowerCase();
        return hay.includes(needle);
      });
  }, [category, needle, connections]);

  const popular: IntegrationItem[] = CONNECTORS.filter((connector) => connector.popular && connector.category !== 'core')
    .slice(0, 8)
    .map((connector) => ({
      id: connector.id,
      name: connector.name,
      entities: CATEGORY_LABELS[connector.category],
      description: connector.description,
      tags: (connector.tags ?? []).slice(0, 3),
      triggers: connector.triggers.length,
      actions: connector.actions.length,
      available: true,
      icon: <ConnectorIcon connector={connector} size={18} variant="mark" />,
    }));

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
          <p className="text-sm text-muted-foreground">
            {CATALOG_STATS.connectors} connectors across {CATALOG_STATS.categories} categories. Connections are mocked locally so you can design against the whole catalog.
          </p>
        </div>
        <div className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search apps, triggers, actions…" className="pl-8" />
        </div>
      </div>

      <Tabs value={category} onValueChange={(value) => setCategory(String(value))}>
        <ScrollArea className="w-full whitespace-nowrap">
          <TabsList variant="line" className="w-max">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="connected">Connected ({Object.keys(connections).length})</TabsTrigger>
            {groups
              .filter((group) => group.category !== 'core')
              .map((group) => (
                <TabsTrigger key={group.category} value={group.category}>
                  {group.label} <span className="ml-1 text-muted-foreground">{group.connectors.length}</span>
                </TabsTrigger>
              ))}
          </TabsList>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </Tabs>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {filtered.map((connector) => {
          const connection = connections[connector.id];
          return (
            <Card key={connector.id} size="sm" className={cn('flex flex-col', connection !== undefined ? 'border-emerald-500/40' : '')}>
              <CardHeader>
                <div className="flex items-start gap-3">
                  <ConnectorIcon connector={connector} size={20} />
                  <div className="min-w-0 flex-1">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <span className="truncate">{connector.name}</span>
                      {connection !== undefined ? <Check className="size-3.5 text-emerald-600" /> : null}
                    </CardTitle>
                    <CardDescription className="line-clamp-2 text-xs">{connector.description}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="mt-auto flex flex-col gap-2">
                <div className="flex flex-wrap gap-1">
                  <Badge variant="secondary" className="text-[10px]">
                    {CATEGORY_LABELS[connector.category]}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {AUTH_LABEL[connector.auth]}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {connector.triggers.length} triggers · {connector.actions.length} actions
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-muted-foreground">{connection === undefined ? 'Not connected' : connection.account}</span>
                  {connection === undefined ? (
                    <Button size="xs" variant="outline" onClick={() => setConnecting(connector)}>
                      <Plug data-icon="inline-start" /> Connect
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        disconnect(connector.id);
                        toast(`Disconnected ${connector.name}`);
                      }}
                    >
                      <Unplug data-icon="inline-start" /> Disconnect
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {filtered.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">Nothing matches “{query}”.</p> : null}

      {needle.length === 0 && category === 'all' ? (
        <section className="mt-6 hidden flex-col items-center gap-3 lg:flex">
          <div className="text-center">
            <h2 className="text-lg font-semibold tracking-tight">Popular, as a marketplace card</h2>
            <p className="text-sm text-muted-foreground">The same catalog rendered with Watermelon UI’s integration card.</p>
          </div>
          <IntegrationsCard title="Popular" items={popular} />
        </section>
      ) : null}

      <ConnectDialog
        connector={connecting}
        onClose={() => setConnecting(null)}
        onConnect={(account) => {
          if (connecting === null) return;
          connect(connecting.id, account);
          toast.success(`Connected ${connecting.name} (mock)`);
          setConnecting(null);
        }}
      />
    </div>
  );
}

function ConnectDialog({ connector, onClose, onConnect }: { connector: Connector | null; onClose: () => void; onConnect: (account: string) => void }) {
  const [account, setAccount] = useState('');
  const open = connector !== null;
  const defaultAccount = connector === null ? '' : connector.auth === 'local' ? 'this machine' : `acme (${connector.name})`;
  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent>
        {connector === null ? null : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <ConnectorIcon connector={connector} size={22} />
                <div>
                  <DialogTitle>Connect {connector.name}</DialogTitle>
                  <DialogDescription>{AUTH_LABEL[connector.auth]} · {connector.triggers.length} triggers · {connector.actions.length} actions</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="rounded-lg border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
              {connector.auth === 'oauth' || connector.auth === 'app'
                ? `In the hosted product this opens ${connector.name}'s consent screen. The prototype records a local, fake connection so you can build against it.`
                : connector.auth === 'local'
                  ? `${connector.name} runs on your own machine through the local runner. Nothing to authorise; the prototype just marks it available.`
                  : `In the hosted product you would paste a key here and it would be stored encrypted, scoped to this workspace. The prototype stores nothing but the fact that you connected.`}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account">Account label</Label>
              <Input id="account" value={account} onChange={(event) => setAccount(event.target.value)} placeholder={defaultAccount} />
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">What this unlocks</p>
              <ul className="list-disc pl-4">
                {connector.triggers.slice(0, 3).map((trigger) => (
                  <li key={trigger.id}>Trigger: {trigger.name}</li>
                ))}
                {connector.actions.slice(0, 3).map((action) => (
                  <li key={action.id}>Action: {action.name}</li>
                ))}
              </ul>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => onConnect(account.trim() || defaultAccount)}>Connect</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
