import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConnector } from '@/lib/connectors';
import { uncoveredNodes } from '@/lib/connectors/connection-state';
import { CREDENTIAL_SPECS, credentialSpec, isWebhook } from '@/lib/connectors/credentials';
import { NODE_TYPES } from '@/lib/connectors';
import { TOKEN_PROBES } from '@/server/credentials/tokens';
import { checkCredential, sendTestMessage } from '@/server/credentials/verify';

/**
 * A made-up token: the app's prefix and filler nobody could mistake for a
 * real one. Built here rather than written out, so nothing in this file is
 * shaped like a secret a scanner would stop a push for.
 */
function made(prefix = ''): string {
  return `${prefix}${'relayfixture'.repeat(3)}`;
}

/** A token of the right shape for each app, and what its "who am I" answers when it is real. */
const SAMPLES: Record<string, { token: string; answer: unknown; account: string | undefined }> = {
  linear: { token: made('lin_api_'), answer: { data: { viewer: { name: 'Ada Lovelace', email: 'ada@acme.dev' }, organization: { name: 'Acme' } } }, account: 'Ada Lovelace (Acme)' },
  shortcut: { token: made(), answer: { id: 'm1', name: 'Ada Lovelace', mention_name: 'ada', workspace2: { url_slug: 'acme' } }, account: 'Ada Lovelace (acme)' },
  notion: { token: made('ntn_'), answer: { object: 'user', type: 'bot', name: 'Relay', bot: { workspace_name: 'Acme HQ' } }, account: 'Relay (Acme HQ)' },
  figma: { token: made('figd_'), answer: { id: '1', handle: 'Ada', email: 'ada@acme.dev' }, account: 'Ada' },
  circleci: { token: made(), answer: { id: 'u1', login: 'ada', name: 'Ada Lovelace' }, account: 'Ada Lovelace' },
  buildkite: { token: made(), answer: { uuid: 'b6', scopes: ['read_builds'], user: { name: 'Ada Lovelace', email: 'ada@acme.dev' } }, account: 'Ada Lovelace' },
  bitrise: { token: made(), answer: { data: { username: 'ada', email: 'ada@acme.dev' } }, account: 'ada' },
  vercel: { token: made(), answer: { user: { username: 'ada', name: 'Ada Lovelace', email: 'ada@acme.dev' } }, account: 'ada' },
  netlify: { token: made(), answer: { full_name: 'Ada Lovelace', email: 'ada@acme.dev' }, account: 'Ada Lovelace' },
  sentry: { token: made('sntryu_'), answer: { version: '0', auth: { scopes: ['event:read'] }, user: { name: 'Ada Lovelace', email: 'ada@acme.dev' } }, account: 'Ada Lovelace' },
  bugsnag: { token: made(), answer: { id: 'u1', name: 'Ada Lovelace', email: 'ada@acme.dev' }, account: 'Ada Lovelace' },
  rollbar: { token: made(), answer: { err: 0, result: { items: [] } }, account: undefined },
  snyk: { token: made(), answer: { data: { type: 'user', attributes: { name: 'Ada Lovelace', username: 'ada' } } }, account: 'Ada Lovelace' },
  semgrep: { token: made(), answer: { deployments: [{ id: 1, name: 'Acme', slug: 'acme' }] }, account: 'Acme' },
  launchdarkly: { token: made('api-'), answer: { accountId: 'a1', tokenName: 'Relay', tokenKind: 'personal' }, account: 'Relay' },
  statsig: { token: made('console-'), answer: { message: 'Gates listed successfully.', data: [] }, account: undefined },
  intercom: { token: made(), answer: { type: 'admin', name: 'Ada Lovelace', email: 'ada@acme.dev', app: { name: 'Acme' } }, account: 'Ada Lovelace (Acme)' },
  plain: { token: made('plainApiKey_'), answer: { data: { myWorkspace: { name: 'Acme' } } }, account: 'Acme' },
};

const TOKEN_SPECS = CREDENTIAL_SPECS.filter((spec) => !isWebhook(spec));

interface Seen {
  url: string;
  init: RequestInit;
}

/** A stand-in for `fetch` that answers every request the same way and remembers what it was asked. */
function answering(status: number, body: unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    // A 204 carries no body at all, and `Response` refuses to be given one.
    return new Response(status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

test('every app that connects for real is in the catalog, once, and not built in', () => {
  const ids = CREDENTIAL_SPECS.map((spec) => spec.connectorId);
  assert.equal(new Set(ids).size, ids.length);
  for (const spec of CREDENTIAL_SPECS) {
    const connector = getConnector(spec.connectorId);
    assert.ok(connector !== undefined, `${spec.connectorId} is not in the catalog`);
    assert.notEqual(connector.category, 'core', spec.connectorId);
    assert.ok(spec.steps.length > 0 && spec.setup.href.startsWith('https://'), spec.connectorId);
  }
});

test('a webhook names actions its app has; a token names none', () => {
  for (const spec of CREDENTIAL_SPECS) {
    if (!isWebhook(spec)) {
      assert.equal(spec.actions, undefined, spec.connectorId);
      continue;
    }
    const actions = new Set(getConnector(spec.connectorId)!.actions.map((action) => action.id));
    for (const action of spec.actions ?? []) assert.ok(actions.has(action), `${spec.connectorId} has no action ${action}`);
  }
});

test('every token has a way to be checked, a sample here, and nothing is checked that cannot be connected', () => {
  assert.deepEqual(Object.keys(TOKEN_PROBES).sort(), TOKEN_SPECS.map((spec) => spec.connectorId).sort());
  assert.deepEqual(Object.keys(SAMPLES).sort(), TOKEN_SPECS.map((spec) => spec.connectorId).sort());
});

test('a token goes to its own app over https, and nowhere a person could choose', () => {
  for (const [id, probe] of Object.entries(TOKEN_PROBES)) {
    const url = new URL(probe.url);
    assert.equal(url.protocol, 'https:', id);
    assert.equal(url.username + url.password, '', id);
    // The token travels in a header, never in the address, where logs would keep it.
    assert.ok(!probe.url.includes(SAMPLES[id]!.token), id);
    assert.ok(Object.values(probe.headers(SAMPLES[id]!.token)).some((value) => value.includes(SAMPLES[id]!.token)), id);
  }
});

test('each app’s real token is accepted, and named as the app names it', async () => {
  for (const spec of TOKEN_SPECS) {
    const sample = SAMPLES[spec.connectorId]!;
    assert.ok(spec.input.pattern.test(sample.token), `${spec.connectorId}: the sample token does not fit its own pattern`);
    const seen: Seen[] = [];
    const result = await checkCredential(spec, sample.token, answering(200, sample.answer, seen));
    assert.deepEqual(result, sample.account === undefined ? { ok: true } : { ok: true, account: sample.account }, spec.connectorId);
    assert.equal(seen.length, 1, spec.connectorId);
    assert.equal(seen[0]!.url, TOKEN_PROBES[spec.connectorId]!.url);
    assert.equal(seen[0]!.init.redirect, 'error', spec.connectorId);
  }
});

test('a token the app does not know is refused; an app that is down is not blamed on the token', async () => {
  for (const spec of TOKEN_SPECS) {
    const token = SAMPLES[spec.connectorId]!.token;
    for (const status of [401, 403, 404]) {
      const refused = await checkCredential(spec, token, answering(status, { message: 'no' }));
      assert.equal(refused.ok, false, `${spec.connectorId} ${status}`);
      assert.equal(!refused.ok && refused.reason, 'refused', `${spec.connectorId} ${status}`);
    }
    for (const status of [429, 500, 503]) {
      const down = await checkCredential(spec, token, answering(status, 'later'));
      assert.equal(!down.ok && down.reason, 'unreachable', `${spec.connectorId} ${status}`);
    }
    const offline = await checkCredential(spec, token, (async () => {
      throw new Error('offline');
    }) as typeof fetch);
    assert.equal(!offline.ok && offline.reason, 'unreachable', spec.connectorId);
  }
});

test('the wrong shape is refused before anything is sent', async () => {
  for (const spec of TOKEN_SPECS) {
    const seen: Seen[] = [];
    for (const value of ['', 'short', 'has a space in the middle of it', 'https://example.com/not-a-token\n']) {
      const result = await checkCredential(spec, value, answering(200, SAMPLES[spec.connectorId]!.answer, seen));
      assert.equal(result.ok, false, `${spec.connectorId}: ${JSON.stringify(value)}`);
    }
    assert.equal(seen.length, 0, spec.connectorId);
  }
});

test('a prefix another kind of key carries is turned away with why', async () => {
  const cases: Array<[string, string]> = [
    ['sentry', made('sntrys_')],
    ['launchdarkly', made('sdk-')],
    ['statsig', made('secret-')],
    ['linear', made('lin_oauth_')],
  ];
  for (const [id, value] of cases) {
    const spec = credentialSpec(id)!;
    const result = await checkCredential(spec, value, answering(200, SAMPLES[id]!.answer));
    assert.deepEqual(result, { ok: false, reason: 'refused', message: spec.input.mismatch }, id);
  }
});

test('an app that answers 200 to anyone is only believed when it says who is asking', async () => {
  // Sentry's API index, asked with no token or a wrong one it lets through.
  const sentry = await checkCredential(credentialSpec('sentry')!, SAMPLES['sentry']!.token, answering(200, { version: '0', auth: null, user: null }));
  assert.equal(!sentry.ok && sentry.reason, 'refused');
  // A GraphQL API that answers 200 with errors and no data.
  const linear = await checkCredential(credentialSpec('linear')!, SAMPLES['linear']!.token, answering(200, { errors: [{ message: 'Authentication required' }] }));
  assert.equal(!linear.ok && linear.reason, 'refused');
  const plain = await checkCredential(credentialSpec('plain')!, SAMPLES['plain']!.token, answering(200, { data: { myWorkspace: null }, errors: [{ message: 'forbidden' }] }));
  assert.equal(!plain.ok && plain.message, TOKEN_PROBES['plain']!.forbidden);
});

test('a 403 says which scope the check needs, where the app has one', async () => {
  for (const id of ['figma', 'rollbar', 'semgrep', 'plain']) {
    const result = await checkCredential(credentialSpec(id)!, SAMPLES[id]!.token, answering(403, { err: 'no' }));
    assert.equal(!result.ok && result.message, TOKEN_PROBES[id]!.forbidden, id);
  }
});

test('an accepted token with an answer that is not JSON, or is someone’s essay, still connects', async () => {
  const spec = credentialSpec('vercel')!;
  assert.deepEqual(await checkCredential(spec, SAMPLES['vercel']!.token, answering(200, '<html>ok</html>')), { ok: true });
  const long = await checkCredential(spec, SAMPLES['vercel']!.token, answering(200, { user: { username: `ada\n${'x'.repeat(500)}` } }));
  assert.ok(long.ok && long.account !== undefined && long.account.length === 80 && !long.account.includes('\n'));
});

test('a token has no test message, and says so without sending anything', async () => {
  const seen: Seen[] = [];
  const result = await sendTestMessage(credentialSpec('linear')!, SAMPLES['linear']!.token, 'hello', answering(200, {}, seen));
  assert.equal(result.ok, false);
  assert.equal(seen.length, 0);
});

test('a token is the whole sign-in: none of its app’s nodes is left uncovered, unlike a webhook’s', () => {
  const linear = NODE_TYPES.filter((def) => def.connectorId === 'linear');
  assert.ok(linear.length > 0);
  assert.deepEqual(uncoveredNodes('linear', linear), []);
  const slack = NODE_TYPES.filter((def) => def.connectorId === 'slack');
  assert.ok(uncoveredNodes('slack', slack).some((def) => def.kind === 'trigger'));
});

test('webhooks are still checked the way they were', async () => {
  const slack = credentialSpec('slack')!;
  const url = `https://hooks.slack.com/services/T000/B000/${made()}`;
  assert.deepEqual(await checkCredential(slack, url, answering(400, 'no_text')), { ok: true });
  const gone = await checkCredential(slack, url, answering(404, 'no_service'));
  assert.equal(!gone.ok && gone.reason, 'refused');
  const discord = credentialSpec('discord')!;
  const hook = `https://discord.com/api/webhooks/${'1'.repeat(18)}/${made()}`;
  assert.deepEqual(await checkCredential(discord, hook, answering(200, { name: 'Relay updates' })), { ok: true, account: 'Relay updates' });
  assert.deepEqual(await sendTestMessage(discord, hook, 'hello', answering(204, '')), { ok: true });
});
