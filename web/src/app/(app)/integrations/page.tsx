'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Globe, Plug, Search, SearchX, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/app/page-header';
import { CategoryRail, CategorySelect, filterLabel, inFilter, type Filter } from '@/components/integrations/category-rail';
import { ConnectDialog } from '@/components/integrations/connect-dialog';
import { ConnectorCard } from '@/components/integrations/connector-card';
import { ConnectorSheet } from '@/components/integrations/connector-sheet';
import { matchConnector, SORT_LABELS, sortMatches, tokenize, type ConnectorMatch, type SortKey } from '@/components/integrations/connector-meta';
import { useStudio } from '@/lib/store';
import { CATALOG_STATS, CONNECTORS, getConnector } from '@/lib/connectors';

export default function IntegrationsPage() {
  // useSearchParams needs a Suspense boundary so the page can still prerender.
  return (
    <Suspense fallback={null}>
      <IntegrationsInner />
    </Suspense>
  );
}

/**
 * Updates the query string without a navigation. Next keeps useSearchParams in
 * step with history.replaceState, so `?app=` and `?q=` stay shareable and the
 * ⌘K palette's `/integrations?app=<id>` links land on an open sheet.
 */
function writeParams(patch: Record<string, string | null>) {
  const next = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value.length === 0) next.delete(key);
    else next.set(key, value);
  }
  const search = next.toString();
  window.history.replaceState(null, '', search.length > 0 ? `?${search}` : window.location.pathname);
}

const SORT_ITEMS = (Object.keys(SORT_LABELS) as SortKey[]).map((key) => ({ value: key, label: SORT_LABELS[key] }));

function IntegrationsInner() {
  const params = useSearchParams();
  const appId = params.get('app');
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortKey>('recommended');
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const connections = useStudio((state) => state.connections);
  const connect = useStudio((state) => state.connect);
  const disconnect = useStudio((state) => state.disconnect);

  // The sheet follows `?app=`. Remember the last app shown so its content stays
  // on screen while the sheet slides closed after the param is cleared.
  const [shownId, setShownId] = useState<string | null>(appId);
  if (appId !== null && appId !== shownId) setShownId(appId);
  const sheetOpen = appId !== null && getConnector(appId) !== undefined;
  const shown = shownId === null ? undefined : getConnector(shownId);

  const tokens = useMemo(() => tokenize(query), [query]);
  const matches = useMemo(() => CONNECTORS.map((connector) => matchConnector(connector, tokens)).filter((match): match is ConnectorMatch => match !== null), [tokens]);

  const isConnected = useCallback((id: string) => connections[id] !== undefined, [connections]);

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: matches.length, popular: 0, connected: 0 };
    for (const { connector } of matches) {
      result[connector.category] = (result[connector.category] ?? 0) + 1;
      if (connector.popular === true) result['popular'] = (result['popular'] ?? 0) + 1;
      if (isConnected(connector.id)) result['connected'] = (result['connected'] ?? 0) + 1;
    }
    return result;
  }, [matches, isConnected]);

  const visible = useMemo(() => sortMatches(matches.filter((match) => inFilter(match.connector, filter, isConnected)), sort, isConnected), [matches, filter, sort, isConnected]);

  const onSearch = (value: string) => {
    setQuery(value);
    writeParams({ q: value.trim().length > 0 ? value : null });
  };

  const openApp = useCallback((id: string) => writeParams({ app: id }), []);
  const onConnect = useCallback((id: string) => {
    setConnectingId(id);
    setConnectOpen(true);
  }, []);
  const onDisconnect = useCallback(
    (id: string) => {
      const connector = getConnector(id);
      const account = useStudio.getState().connections[id]?.account;
      disconnect(id);
      toast(`Disconnected ${connector?.name ?? id}`, account === undefined ? undefined : { action: { label: 'Undo', onClick: () => connect(id, account) } });
    },
    [connect, disconnect],
  );

  const connectedCount = Object.keys(connections).length;
  const filtered = filter !== 'all' || tokens.length > 0;

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Integrations"
        term="connection"
        description={
          <>
            {CATALOG_STATS.connectors} apps your workflows can listen to and act on, built-in nodes included. A <strong className="font-medium text-foreground">trigger</strong> starts a workflow when something happens in an app; an{' '}
            <strong className="font-medium text-foreground">action</strong> does something there. Connections in this prototype are local flags, not real sign-ins, so you can design against every app without connecting any.
          </>
        }
        actions={
          <dl className="grid grid-cols-3 gap-x-6 text-right max-sm:w-full max-sm:text-left">
            <Stat label="Apps" value={CATALOG_STATS.connectors} />
            <Stat label="Triggers" value={CATALOG_STATS.triggers} />
            <Stat label="Actions" value={CATALOG_STATS.actions} />
          </dl>
        }
      />

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        <aside className="hidden [scrollbar-width:thin] lg:sticky lg:top-16 lg:block lg:max-h-[calc(100dvh-5rem)] lg:overflow-y-auto lg:pb-4">
          <CategoryRail value={filter} onChange={setFilter} counts={counts} />
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="h-9 min-w-0 flex-1 basis-60">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput value={query} onChange={(event) => onSearch(event.target.value)} placeholder="Search apps, triggers and actions…" aria-label="Search apps, triggers and actions" />
              {query.length > 0 ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onSearch('')}>
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
            <CategorySelect value={filter} onChange={setFilter} counts={counts} className="data-[size=default]:h-9 lg:hidden" />
            <Select value={sort} onValueChange={(next) => setSort((next ?? 'recommended') as SortKey)} items={SORT_ITEMS}>
              <SelectTrigger className="data-[size=default]:h-9" aria-label="Sort">
                <span className="text-muted-foreground">Sort:</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {SORT_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span aria-live="polite">
              {visible.length === counts['all'] && filter === 'all' && tokens.length === 0
                ? `${visible.length} apps · ${connectedCount} connected`
                : `${visible.length} ${visible.length === 1 ? 'result' : 'results'}${filter === 'all' ? '' : ` in ${filterLabel(filter)}`}${tokens.length > 0 ? ` for “${query.trim()}”` : ''}`}
            </span>
            {filtered ? (
              <Button
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs"
                onClick={() => {
                  setFilter('all');
                  onSearch('');
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </div>

          {visible.length === 0 ? (
            <NoResults
              query={query.trim()}
              filter={filter}
              matchesElsewhere={filter === 'all' ? 0 : (counts['all'] ?? 0)}
              onShowAll={() => setFilter('all')}
              onClear={() => onSearch('')}
              onOpenHttp={() => openApp('http')}
            />
          ) : (
            // Keyed by filter so switching category replays the stagger; typing does not.
            // Columns follow the space the grid actually has (container queries), not the
            // window, so the sidebar and the rail never squeeze cards below ~300px.
            <div key={filter} className="@container">
              <div className="grid gap-3 @[40rem]:grid-cols-2 @[60rem]:grid-cols-3 @[82rem]:grid-cols-4">
                {visible.map((match, index) => (
                  <ConnectorCard
                    key={match.connector.id}
                    match={match}
                    index={index}
                    connection={connections[match.connector.id]}
                    onOpen={openApp}
                    onConnect={onConnect}
                    onDisconnect={onDisconnect}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <ConnectorSheet connector={shown} open={sheetOpen} onOpenChange={(open) => (open ? undefined : writeParams({ app: null }))} onOpenApp={openApp} />
      <ConnectDialog connector={connectingId === null ? null : (getConnector(connectingId) ?? null)} open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="text-xl font-semibold tracking-tight tabular-nums">{value.toLocaleString('en-US')}</dd>
    </div>
  );
}

function NoResults({
  query,
  filter,
  matchesElsewhere,
  onShowAll,
  onClear,
  onOpenHttp,
}: {
  query: string;
  filter: Filter;
  matchesElsewhere: number;
  onShowAll: () => void;
  onClear: () => void;
  onOpenHttp: () => void;
}) {
  if (filter === 'connected' && query.length === 0) {
    return (
      <Empty className="border py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Plug />
          </EmptyMedia>
          <EmptyTitle>Nothing connected yet</EmptyTitle>
          <EmptyDescription>You do not need to connect anything to build or test a workflow. Connect an app when you want its nodes to stop reminding you.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={onShowAll}>
            Browse all apps
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <Empty className="border py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX />
        </EmptyMedia>
        <EmptyTitle>
          {query.length > 0 ? `No app matches “${query}”` : 'No apps here'}
          {filter === 'all' ? '' : ` in ${filterLabel(filter)}`}
        </EmptyTitle>
        <EmptyDescription>
          Anything with a URL still works. Start a workflow from an <span className="font-medium text-foreground">Incoming webhook</span>, or call the app’s API with an{' '}
          <span className="font-medium text-foreground">HTTP request</span> step.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={onOpenHttp}>
            <Globe data-icon="inline-start" /> Open HTTP & webhooks
          </Button>
          {matchesElsewhere > 0 ? (
            <Button variant="outline" onClick={onShowAll}>
              Show {matchesElsewhere} {matchesElsewhere === 1 ? 'match' : 'matches'} in all apps
            </Button>
          ) : query.length > 0 ? (
            <Button variant="outline" onClick={onClear}>
              Clear search
            </Button>
          ) : null}
        </div>
      </EmptyContent>
    </Empty>
  );
}
