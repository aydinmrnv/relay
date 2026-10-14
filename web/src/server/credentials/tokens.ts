/**
 * How each app is asked whether a token is real: one request to the app's
 * own "who am I" endpoint, which reads and changes nothing. Every address
 * here is fixed, so a token is only ever sent to the app that issued it; the
 * person's input never chooses the host.
 *
 * One entry per `api-token` spec in `lib/connectors/credentials.ts`; a test
 * fails when the two lists differ.
 */

export interface TokenProbe {
  url: string;
  /** GET unless the app only answers a query. */
  body?: string;
  headers: (token: string) => Record<string, string>;
  /** A path that a signed-in answer has. Some apps answer 200 to anyone, and say who is asking inside. */
  must?: string;
  /** Paths to a name for whoever the token belongs to, best first. */
  who?: string[];
  /** Paths to the workspace or organisation it is in, shown after the name. */
  where?: string[];
  /** What a 403 means here, when it is not simply a wrong token: usually a scope the check needs. */
  forbidden?: string;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export const TOKEN_PROBES: Readonly<Record<string, TokenProbe>> = {
  linear: {
    url: 'https://api.linear.app/graphql',
    body: JSON.stringify({ query: '{ viewer { name email } organization { name } }' }),
    // A personal API key goes in bare; `Bearer` is for Linear's OAuth tokens.
    headers: (token) => ({ authorization: token }),
    must: 'data.viewer',
    who: ['data.viewer.name', 'data.viewer.email'],
    where: ['data.organization.name'],
  },
  shortcut: {
    url: 'https://api.app.shortcut.com/api/v3/member',
    headers: (token) => ({ 'shortcut-token': token }),
    who: ['name', 'mention_name'],
    where: ['workspace2.url_slug'],
  },
  notion: {
    url: 'https://api.notion.com/v1/users/me',
    headers: (token) => ({ ...bearer(token), 'notion-version': '2022-06-28' }),
    who: ['name'],
    where: ['bot.workspace_name'],
  },
  figma: {
    url: 'https://api.figma.com/v1/me',
    headers: (token) => ({ 'x-figma-token': token }),
    who: ['handle', 'email'],
    forbidden: 'Figma refused the token. If it is new, check it has read access to “Current user”; otherwise it has expired or was revoked.',
  },
  circleci: {
    url: 'https://circleci.com/api/v2/me',
    headers: (token) => ({ 'circle-token': token }),
    who: ['name', 'login'],
  },
  buildkite: {
    // Answers for any token, whatever its scopes; `/v2/user` would need `read_user`.
    url: 'https://api.buildkite.com/v2/access-token',
    headers: bearer,
    who: ['user.name', 'user.email', 'description'],
  },
  bitrise: {
    url: 'https://api.bitrise.io/v0.1/me',
    headers: (token) => ({ authorization: token }),
    who: ['data.username', 'data.email'],
  },
  vercel: {
    url: 'https://api.vercel.com/v2/user',
    headers: bearer,
    who: ['user.username', 'user.name', 'user.email'],
  },
  netlify: {
    url: 'https://api.netlify.com/api/v1/user',
    headers: bearer,
    who: ['full_name', 'email'],
  },
  sentry: {
    // The API's index answers 200 to anyone; `auth` is null unless the token is real.
    url: 'https://sentry.io/api/0/',
    headers: bearer,
    must: 'auth',
    who: ['user.name', 'user.email', 'user.username'],
  },
  bugsnag: {
    url: 'https://api.bugsnag.com/user',
    headers: (token) => ({ authorization: `token ${token}`, 'x-version': '2' }),
    who: ['name', 'email'],
  },
  rollbar: {
    // A project token has no "who am I"; listing a page of items is the lightest thing its read scope allows.
    url: 'https://api.rollbar.com/api/1/items?page=1',
    headers: (token) => ({ 'x-rollbar-access-token': token }),
    // Rollbar answers 403 both to a token it has never seen and to a real one without the scope.
    forbidden: 'Rollbar refused the token: either it is not one Rollbar knows, or it may not read. Use a project access token with the read scope.',
  },
  snyk: {
    url: 'https://api.snyk.io/rest/self?version=2024-10-15',
    headers: (token) => ({ authorization: `token ${token}` }),
    who: ['data.attributes.name', 'data.attributes.username', 'data.attributes.email'],
  },
  semgrep: {
    url: 'https://semgrep.dev/api/v1/deployments',
    headers: bearer,
    who: ['deployments.0.name', 'deployments.0.slug'],
    forbidden: 'Semgrep knows this token, but it is not for the Web API. Create one with the Web API scope ticked.',
  },
  launchdarkly: {
    url: 'https://app.launchdarkly.com/api/v2/caller-identity',
    headers: (token) => ({ authorization: token }),
    who: ['tokenName'],
  },
  statsig: {
    url: 'https://statsigapi.net/console/v1/gates?limit=1',
    headers: (token) => ({ 'statsig-api-key': token }),
  },
  intercom: {
    url: 'https://api.intercom.io/me',
    headers: (token) => ({ ...bearer(token), accept: 'application/json' }),
    who: ['name', 'email'],
    where: ['app.name'],
  },
  plain: {
    url: 'https://core-api.uk.plain.com/graphql/v1',
    body: JSON.stringify({ query: '{ myWorkspace { name } }' }),
    headers: bearer,
    must: 'data.myWorkspace',
    who: ['data.myWorkspace.name'],
    forbidden: 'Plain knows this key, but it may not read the workspace. Add the workspace:read permission to it.',
  },
};

/** The value at a dotted path (`data.viewer.name`, `deployments.0.slug`), or undefined. */
export function pick(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function firstText(value: unknown, paths: readonly string[] | undefined): string | undefined {
  for (const path of paths ?? []) {
    const found = pick(value, path);
    if (typeof found === 'string' && found.trim().length > 0) return found.trim();
  }
  return undefined;
}

/** "Ada Lovelace (Acme)": whose token it is and where, from what the app answered. Cut short, since it is the app's text. */
export function accountName(probe: TokenProbe, answer: unknown): string | undefined {
  const who = firstText(answer, probe.who);
  const where = firstText(answer, probe.where);
  const name = who === undefined ? where : where === undefined || where === who ? who : `${who} (${where})`;
  return name === undefined ? undefined : name.replace(/\s+/g, ' ').slice(0, 80);
}
