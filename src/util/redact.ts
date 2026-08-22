/**
 * Relay logs subprocess output verbatim into `events.jsonl`, and that output can
 * contain whatever the agent happened to print. These patterns strip the token
 * shapes we can recognize before anything reaches disk.
 *
 * This is defence in depth, not a guarantee: the real protection is that Relay
 * never reads credentials and never forwards the environment it cannot see.
 *
 * The same shapes guard the other path a secret can take off this machine: the
 * pre-publish scan in `src/git/secretScan.ts` reads the high-signal subset of
 * this list. One list, two doors.
 */
export interface SecretPattern {
  /** Short name a scan reports when this matches — never the matched text. */
  id: string;
  pattern: RegExp;
  replacement: string;
  /**
   * True for shapes that are near-certainly credentials: vendor token prefixes,
   * key blocks. The pre-publish secret scan uses only these, because there a
   * false positive blocks a delivery. The low-signal shapes still guard the
   * event log, where a false positive costs one redacted word.
   */
  highSignal: boolean;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: '[redacted:github-token]', highSignal: true },
  { id: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: '[redacted:github-pat]', highSignal: true },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replacement: '[redacted:anthropic-key]', highSignal: true },
  { id: 'api-key', pattern: /\bsk-[A-Za-z0-9]{20,}/g, replacement: '[redacted:api-key]', highSignal: true },
  { id: 'aws-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[redacted:aws-key-id]', highSignal: true },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replacement: '[redacted:slack-token]', highSignal: true },
  { id: 'jwt', pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[redacted:jwt]', highSignal: true },
  {
    id: 'private-key',
    pattern: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
    replacement: '[redacted:private-key]',
    highSignal: true,
  },
  {
    id: 'authorization-header',
    pattern: /\b(authorization|auth|bearer)\s*[:=]\s*\S+/gi,
    replacement: '$1: [redacted]',
    highSignal: false,
  },
  {
    id: 'credential-assignment',
    pattern: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g,
    replacement: '$1=[redacted]',
    highSignal: false,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Recursively redacts strings inside a structure destined for events.jsonl. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactDeep(item, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
