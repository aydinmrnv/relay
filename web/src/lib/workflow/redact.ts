/**
 * What of a workflow may leave the browser, and what may become public.
 *
 * Two different bars. Sync, versions and imports go to the owner's own
 * account, so only credentials are held back (`isSecretField`). A share
 * link is public, so it keeps a setting only when it cannot be a secret, a
 * link, an address or a person: choices, numbers and switches always pass;
 * free text passes only when nothing in it looks like one of those.
 */
import { getNodeType } from '@/lib/connectors';
import type { Workflow } from './schema';

const SECRET_KEY = /secret|token|password|passwd|api[-_]?key|apikey|authori[sz]ation|auth[-_]?header|headers|cookie|webhook[-_]?url|private[-_]?key|credential|signing/i;

const fieldTypes = new Map<string, Map<string, string>>();

function fieldType(typeId: string, key: string): string | undefined {
  let types = fieldTypes.get(typeId);
  if (types === undefined) {
    types = new Map((getNodeType(typeId)?.fields ?? []).map((field) => [field.key, field.type]));
    fieldTypes.set(typeId, types);
  }
  return types.get(key);
}

/** A credential: typed as a secret in the catalog, or named like one. Never leaves the browser it was typed in. */
export function isSecretField(typeId: string, key: string): boolean {
  return fieldType(typeId, key) === 'secret' || SECRET_KEY.test(key);
}

const LINK = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|hooks\.slack\.com|discord(?:app)?\.com\/api/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const TOKEN = /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat|shpat|AKIA|AIza)[-_A-Za-z0-9]{6,}|\bBearer\s+\S+|\b[A-Za-z0-9_-]{32,}\b|[A-Z][A-Z0-9_]{2,}=\S+/;
const PEOPLE = /^(authors?|approvers?|reviewers?|owners?|users?|members?|mentions?|logins?)$/i;
const ADDRESSES = /^(to|cc|bcc|emails?|recipients?|from|replyTo)$/i;
const TEAMS = /^teams?$/i;

function publicValue(typeId: string, key: string, value: unknown): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (isSecretField(typeId, key)) return '';
  const type = fieldType(typeId, key);
  if (type === 'json') return '';
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && !LINK.test(item) && !EMAIL.test(item) && !TOKEN.test(item));
  if (typeof value !== 'string') return '';
  if (value.trim().length === 0) return value;
  if (PEOPLE.test(key)) return 'your-login';
  if (ADDRESSES.test(key)) return 'you@example.com';
  if (TEAMS.test(key)) return 'your-org/your-team';
  if (key === 'assignee') return '@your-bot';
  if (LINK.test(value) || EMAIL.test(value) || TOKEN.test(value)) return '';
  return value;
}

/** A copy fit for the public. Whoever remixes it fills in their own links, people and credentials. */
export function redactForSharing(source: Workflow): Workflow {
  return {
    ...source,
    repository: 'your-org/your-repo',
    exportedAt: undefined,
    nodes: source.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        config: Object.fromEntries(Object.entries(node.data.config).map(([key, value]) => [key, publicValue(node.data.typeId, key, value)])),
      },
    })),
  };
}
