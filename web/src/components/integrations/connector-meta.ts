/**
 * Plain-language copy and search for the Integrations page: how each kind of
 * sign-in works, and a connector search that also looks inside trigger and
 * action names.
 */
import { Box, KeyRound, Laptop, Puzzle, ShieldCheck, Ticket, type LucideIcon } from 'lucide-react';
import { CATEGORY_LABELS, type AuthKind, type Connector } from '@/lib/connectors';
import { credentialSpec } from '@/lib/connectors/credentials';
import { TEMPLATES, type TemplateMeta } from '@/lib/workflow/templates';

const AUTH_LABEL: Record<AuthKind, string> = {
  oauth: 'OAuth sign-in',
  'api-key': 'API key',
  token: 'Access token',
  app: 'App install',
  local: 'Runs locally',
  none: 'No sign-in',
};

/** How the app signs in: the real credential it takes when there is one, else how it will. */
export function authLabel(connector: Pick<Connector, 'id' | 'auth' | 'category'>): string {
  return connector.category === 'core' ? 'Built in' : (credentialSpec(connector.id)?.name ?? AUTH_LABEL[connector.auth]);
}

export const AUTH_ICON: Record<AuthKind, LucideIcon> = {
  oauth: ShieldCheck,
  'api-key': KeyRound,
  token: Ticket,
  app: Puzzle,
  local: Laptop,
  none: Box,
};

/** How connecting this kind of app will work once its sign-in is built, in a sentence or two. */
export function authExplainer(connector: Pick<Connector, 'name' | 'auth' | 'category'>, product: string): { title: string; body: string } {
  const name = connector.name;
  if (connector.category === 'core') {
    return { title: `Part of ${product}`, body: `${name} is built in. There is nothing to connect; it is always available in every workflow.` };
  }
  switch (connector.auth) {
    case 'oauth':
      return {
        title: `Sign in with ${name}`,
        body: `You will press Connect, sign in to ${name} and approve what ${product} may do. ${name} hands back a token you can revoke from its own settings at any time; you never type a password here.`,
      };
    case 'api-key':
      return {
        title: 'Paste an API key',
        body: `You will create a key in ${name}’s settings and paste it here. ${product} keeps it encrypted, for this workspace’s workflows only, so give it the narrowest scope that covers the actions you use.`,
      };
    case 'token':
      return {
        title: 'Paste an access token',
        body: `A personal or bot token from ${name}. It works like an API key but belongs to an account, so anything a workflow does shows up as that account; a bot account keeps it out of your own name.`,
      };
    case 'app':
      return {
        title: `Install the ${product} app`,
        body: `You will install ${product}’s app in your ${name} workspace or organisation and choose what it may see. The app has its own identity and fine-grained permissions, so nothing runs as a person.`,
      };
    case 'local':
      return {
        title: 'Runs on your runner',
        body: `${name} runs where your agents run: your computer through relay connect, or your Relay Cloud machine. There is nothing to authorise here; the tools only need to be installed and signed in there.`,
      };
    case 'none':
      return {
        title: 'No sign-in',
        body: `${name} only reads public data, so there is no account to connect. Use its nodes as they are.`,
      };
  }
}

/** Built-in nodes are always there; every other app can be marked connected. */
export function isBuiltIn(connector: Pick<Connector, 'category'>): boolean {
  return connector.category === 'core';
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface ConnectorMatch {
  connector: Connector;
  score: number;
  /** Trigger and action names that matched, so a card can say why it is here. */
  hits: string[];
}

export function tokenize(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Every word must match somewhere: name, tags, category, description, or the
 * name of one of the app's triggers or actions. Name hits rank highest.
 */
export function matchConnector(connector: Connector, tokens: string[]): ConnectorMatch | null {
  if (tokens.length === 0) return { connector, score: 0, hits: [] };
  const specs = [...connector.triggers, ...connector.actions];
  const fields: Array<[string, number]> = [
    [connector.name.toLowerCase(), 8],
    [(connector.tags ?? []).join(' ').toLowerCase(), 4],
    [CATEGORY_LABELS[connector.category].toLowerCase(), 3],
    [specs.map((spec) => spec.name).join(' · ').toLowerCase(), 2],
    [connector.uses.join(' ').toLowerCase(), 2],
    [connector.description.toLowerCase(), 1],
  ];
  let score = 0;
  for (const token of tokens) {
    let best = 0;
    for (const [text, weight] of fields) {
      if (text.startsWith(token)) best = Math.max(best, weight * 2);
      else if (text.includes(token)) best = Math.max(best, weight);
    }
    if (best === 0) return null;
    score += best;
  }
  // Prefer triggers/actions whose name holds every word ("label added" → "Label added"), else any word.
  const names = specs.map((spec) => spec.name);
  const all = names.filter((name) => tokens.every((token) => name.toLowerCase().includes(token)));
  const hits = all.length > 0 ? all : names.filter((name) => tokens.some((token) => name.toLowerCase().includes(token)));
  return { connector, score, hits: [...new Set(hits)] };
}

export type SortKey = 'recommended' | 'templates' | 'name' | 'connected';

export const SORT_LABELS: Record<SortKey, string> = {
  recommended: 'Recommended',
  templates: 'In the most templates',
  name: 'Name, A–Z',
  connected: 'Connected first',
};

export function sortMatches(matches: ConnectorMatch[], sort: SortKey, connected: (id: string) => boolean): ConnectorMatch[] {
  const byName = (a: ConnectorMatch, b: ConnectorMatch) => a.connector.name.localeCompare(b.connector.name);
  const popular = (m: ConnectorMatch) => (m.connector.popular === true ? 1 : 0);
  const used = (m: ConnectorMatch) => templatesUsing(m.connector.id).length;
  const copy = [...matches];
  switch (sort) {
    case 'name':
      return copy.sort(byName);
    case 'templates':
      return copy.sort((a, b) => used(b) - used(a) || popular(b) - popular(a) || byName(a, b));
    case 'connected':
      return copy.sort((a, b) => Number(connected(b.connector.id)) - Number(connected(a.connector.id)) || popular(b) - popular(a) || byName(a, b));
    case 'recommended':
      // Relevance first when searching, then the apps most people reach for.
      return copy.sort((a, b) => b.score - a.score || popular(b) - popular(a) || byName(a, b));
  }
}

/** The starter templates that use an app, so its page can offer a working workflow rather than a lone trigger. */
export function templatesUsing(connectorId: string): TemplateMeta[] {
  return TEMPLATES.filter((template) => template.connectors.includes(connectorId));
}
