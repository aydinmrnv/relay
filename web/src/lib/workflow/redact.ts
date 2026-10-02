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

const LINKS = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;
const EMAILS = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi;
const TOKENS = /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat|shpat|AKIA|AIza)[-_A-Za-z0-9]{6,}|\bBearer\s+\S+|\b[A-Za-z0-9_-]{32,}\b|\b[A-Z][A-Z0-9_]{2,}=\S+/g;
const MENTIONS = /(^|[\s(,;:])@[A-Za-z0-9][A-Za-z0-9_-]{0,38}(?:\/[A-Za-z0-9_.-]+)?/g;

/**
 * Free text somebody wrote for themselves — a workflow's name, its
 * description, a node's label — made fit for a public page: what it says
 * stays, and anything that is a link, an address, a credential or a person
 * is replaced by a word for what it was.
 */
export function scrubText(text: string): string {
  return text.replace(LINKS, '[link]').replace(EMAILS, '[email]').replace(TOKENS, '[secret]').replace(MENTIONS, '$1@someone');
}

/**
 * A copy fit for the public. Whoever remixes it fills in their own links,
 * people and credentials.
 *
 * It is built up from what is known to be safe, not cut down from the
 * original: only the fields the studio itself defines are carried over, so a
 * key nobody anticipated — on the workflow, on a node, or in a node's
 * settings — is left behind rather than published.
 */
export function redactForSharing(source: Workflow): Workflow {
  return {
    id: source.id,
    name: scrubText(source.name),
    description: scrubText(source.description ?? ''),
    enabled: source.enabled,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    ...(source.templateId === undefined ? {} : { templateId: source.templateId }),
    repository: 'your-org/your-repo',
    nodes: source.nodes.map((node) => {
      const fields = new Set((getNodeType(node.data.typeId)?.fields ?? []).map((field) => field.key));
      return {
        id: node.id,
        type: node.type,
        position: { x: node.position.x, y: node.position.y },
        ...(typeof node.width === 'number' ? { width: node.width } : {}),
        ...(typeof node.height === 'number' ? { height: node.height } : {}),
        data: {
          typeId: node.data.typeId,
          ...(typeof node.data.label === 'string' ? { label: scrubText(node.data.label) } : {}),
          // A setting the node type does not define cannot be judged, so it is not published.
          config: Object.fromEntries(
            Object.entries(node.data.config)
              .filter(([key]) => fields.has(key))
              .map(([key, value]) => [key, publicValue(node.data.typeId, key, value)]),
          ),
        },
      };
    }),
    edges: source.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
      ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
      ...(typeof edge.label === 'string' ? { label: scrubText(edge.label) } : {}),
    })),
  };
}
