import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';

import { readHubConfig } from '../src/cli/commands/hub.ts';
import { AuthError, ClerkVerifier, mintRunnerToken } from '../src/cloud/hub/auth.ts';
import { Fleet } from '../src/cloud/hub/fleet.ts';
import { createHub, StaticVerifier, type Hub, type HubLogEntry } from '../src/cloud/hub/server.ts';
import { acceptWebSocket, isWebSocketUpgrade } from '../src/cloud/ws.ts';
import { isLoopbackOrigin, TRUSTED_STUDIO_ORIGIN, trustedStudioOrigin } from '../src/studio/protocol.ts';

/**
 * Who the hub answers, and what it will hold in memory for them (CLOUD-11).
 */

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

describe('Clerk session tokens, checked more strictly', () => {
  const issuer = 'https://clever-cat-1.clerk.accounts.dev';
  const HOUR = 60 * 60_000;

  function keyPair(kid: string) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
  }

  function jwt(claims: unknown, key: KeyObject, kid: string): string {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
    return `${head}.${body}.${signature}`;
  }

  /** A verifier whose clock and whose Clerk the test controls. */
  function setup(parties: readonly string[] = ['https://studio.example']) {
    let time = 1_800_000_000_000;
    let published: Array<Record<string, unknown>> = [];
    let reachable = true;
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      if (!reachable) throw new Error('Clerk is down');
      return new Response(JSON.stringify({ keys: published }), { status: 200 });
    }) as unknown as typeof fetch;
    const verifier = new ClerkVerifier({ issuer, authorizedParties: parties, fetchImpl, now: () => time });
    const claims = (extra: Record<string, unknown> = {}) => ({ sub: 'user_42', sid: 'sess_1', iss: issuer, azp: 'https://studio.example', exp: Math.floor(time / 1000) + 60, ...extra });
    return {
      verifier,
      claims,
      advance: (ms: number) => (time += ms),
      publish: (...keys: Array<{ jwk: Record<string, unknown> }>) => (published = keys.map((key) => key.jwk)),
      setReachable: (value: boolean) => (reachable = value),
      fetches: () => fetches,
    };
  }

  it('refuses a token that does not say which site it was issued to', async () => {
    const key = keyPair('k1');
    const { verifier, claims, publish } = setup();
    publish(key);
    assert.equal((await verifier.verify(jwt(claims(), key.privateKey, 'k1'))).userId, 'user_42');
    const { azp: _azp, ...without } = claims();
    await assert.rejects(verifier.verify(jwt(without, key.privateKey, 'k1')), /does not say which site/);
    await assert.rejects(verifier.verify(jwt(claims({ azp: 7 }), key.privateKey, 'k1')), AuthError);
    await assert.rejects(verifier.verify(jwt(claims({ azp: 'http://localhost:3000' }), key.privateKey, 'k1')), /another site/);
  });

  it('authorises nobody when it is given no studio, instead of everybody', async () => {
    const key = keyPair('k1');
    const { verifier, claims, publish } = setup([]);
    publish(key);
    await assert.rejects(verifier.verify(jwt(claims(), key.privateKey, 'k1')), /another site/);
  });

  it('says "not a session token" to JSON that is not an object, rather than failing on it', async () => {
    const { verifier } = setup();
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    await assert.rejects(verifier.verify(`${part(null)}.${part({})}.sig`), AuthError);
    await assert.rejects(verifier.verify(`${part({ alg: 'RS256', kid: 'k1' })}.${part(null)}.sig`), AuthError);
  });

  it('reads the keys again when they are an hour old, so a key Clerk withdrew stops working', async () => {
    const old = keyPair('k-old');
    const fresh = keyPair('k-new');
    const { verifier, claims, publish, advance, fetches } = setup();
    publish(old);
    await verifier.verify(jwt(claims(), old.privateKey, 'k-old'));
    await verifier.verify(jwt(claims(), old.privateKey, 'k-old'));
    assert.equal(fetches(), 1, 'not on every request');

    // Clerk rotates: the old key is no longer published.
    publish(fresh);
    advance(59 * 60_000);
    await verifier.verify(jwt(claims(), old.privateKey, 'k-old'));
    assert.equal(fetches(), 1, 'still within the hour');

    advance(2 * 60_000);
    await assert.rejects(verifier.verify(jwt(claims(), old.privateKey, 'k-old')), /not signed by this studio/);
    assert.equal(fetches(), 2);
    assert.equal((await verifier.verify(jwt(claims(), fresh.privateKey, 'k-new'))).userId, 'user_42');
  });

  it('keeps working on the keys it has while Clerk is unreachable, for a day and no longer, asking at most once a minute', async () => {
    const key = keyPair('k1');
    const { verifier, claims, publish, advance, setReachable, fetches } = setup();
    publish(key);
    await verifier.verify(jwt(claims(), key.privateKey, 'k1'));
    setReachable(false);

    advance(2 * HOUR);
    for (let index = 0; index < 5; index += 1) await verifier.verify(jwt(claims(), key.privateKey, 'k1'));
    assert.equal(fetches(), 2, 'one failed read, not one per request');
    advance(61_000);
    await verifier.verify(jwt(claims(), key.privateKey, 'k1'));
    assert.equal(fetches(), 3);

    advance(23 * HOUR);
    await assert.rejects(verifier.verify(jwt(claims(), key.privateKey, 'k1')), /not signed by this studio/, 'a day without Clerk’s word on its keys is too long');

    setReachable(true);
    advance(61_000);
    assert.equal((await verifier.verify(jwt(claims(), key.privateKey, 'k1'))).userId, 'user_42');
  });
});

/* ------------------------------------------------------------------ */
/* Studios                                                             */
/* ------------------------------------------------------------------ */

describe('which studios a hub serves', () => {
  const key = `pk_test_${Buffer.from('clever-cat-1.clerk.accounts.dev$').toString('base64')}`;
  const base = { RELAY_HUB_SECRET: 'x'.repeat(40), CLERK_PUBLISHABLE_KEY: key };

  it('serves the trusted studio by default, and not a studio on this machine', async () => {
    const config = await readHubConfig(base);
    assert.deepEqual(config.origins, [TRUSTED_STUDIO_ORIGIN]);
    assert.deepEqual(config.droppedOrigins, []);
    assert.deepEqual((await readHubConfig({ ...base, RELAY_STUDIO_URL: 'https://studio.example.com/app' })).origins, ['https://studio.example.com']);
    await assert.rejects(readHubConfig({ ...base, RELAY_STUDIO_URL: 'not a url' }), /RELAY_STUDIO_URL/);
  });

  it('serves localhost only for a development hub, and says what it left out otherwise', async () => {
    const dev = await readHubConfig({ ...base, RELAY_HUB_DEV: '1' });
    assert.deepEqual(dev.origins, [TRUSTED_STUDIO_ORIGIN, 'http://localhost:3000']);

    // What every environment file written by an earlier deploy holds.
    const earlier = await readHubConfig({ ...base, RELAY_HUB_STUDIO_ORIGINS: `${TRUSTED_STUDIO_ORIGIN}/,http://localhost:3000` });
    assert.deepEqual(earlier.origins, [TRUSTED_STUDIO_ORIGIN], 'and a trailing slash is not part of an origin');
    assert.deepEqual(earlier.droppedOrigins, ['http://localhost:3000']);

    await assert.rejects(readHubConfig({ ...base, RELAY_HUB_STUDIO_ORIGINS: 'http://127.0.0.1:3000' }), /no studio to serve/);
    await assert.rejects(readHubConfig({ ...base, RELAY_HUB_STUDIO_ORIGINS: 'studio.example.com' }), /not an origin/);
    assert.deepEqual((await readHubConfig({ ...base, RELAY_HUB_DEV: '1', RELAY_HUB_STUDIO_ORIGINS: 'http://127.0.0.1:3000' })).origins, ['http://127.0.0.1:3000']);
  });

  it('knows a studio on this machine when it sees one', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://studio.localhost', 'http://127.8.9.1']) assert.equal(isLoopbackOrigin(origin), true, origin);
    for (const origin of ['https://studio.example.com', 'https://localhost.example.com', 'http://10.0.0.1:3000', 'nonsense']) assert.equal(isLoopbackOrigin(origin), false, origin);
    assert.equal(trustedStudioOrigin({}), TRUSTED_STUDIO_ORIGIN);
    assert.equal(trustedStudioOrigin({ RELAY_STUDIO_URL: 'http://localhost:3000/' }), 'http://localhost:3000');
  });
});

/* ------------------------------------------------------------------ */
/* What the hub says and holds                                         */
/* ------------------------------------------------------------------ */

const SECRET = 'hub-secret-'.padEnd(48, 'x');
const USER = 'user_test';
const STUDIO = { authorization: 'Bearer studio-token-0123456789' };

/** A runner that opens every run stream it is asked for and then does what the test says. */
async function fakeRunner(base: string, onStream: (send: (frame: unknown) => void, id: string) => void = () => undefined): Promise<WebSocket> {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/v1/runner/connect`, { headers: { authorization: `Bearer ${mintRunnerToken(SECRET, { runner: 'my-server', userId: USER }).token}` } } as unknown as string[]);
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as { t: string; id: string; url?: string };
    if (frame.t !== 'req') return;
    if (frame.url?.includes('/events') === true) {
      send({ t: 'res', id: frame.id, status: 200, stream: true });
      onStream(send, frame.id);
    } else send({ t: 'res', id: frame.id, status: 200, body: {} });
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  const welcomed = new Promise((resolve) => ws.addEventListener('message', resolve, { once: true }));
  send({ t: 'hello', hello: { product: 'relay', protocol: 1, authorized: true, capabilities: ['runs'] }, activity: { runs: 0, queued: 0, logins: 0 } });
  await welcomed;
  return ws;
}

async function startHub(options: { maxStreamsPerUser?: number; maxBuffered?: number } = {}): Promise<{ hub: Hub; base: string; port: number; logs: HubLogEntry[] }> {
  const logs: HubLogEntry[] = [];
  const fleet = new Fleet({ driver: null, regions: [], coresPerRunner: 2, tokenFor: () => ({ token: '', id: '' }) });
  const hub = createHub({ fleet, secret: SECRET, sessions: new StaticVerifier([['studio-token-0123456789', USER]]), origins: ['https://studio.example'], version: '1.2.3', heartbeatMs: 60_000, log: (entry) => logs.push(entry), ...options });
  const port = await hub.listen(0, '127.0.0.1');
  return { hub, base: `http://127.0.0.1:${port}`, port, logs };
}

describe('the hub’s health check', () => {
  it('says the hub is up, and nothing about how many machines or people there are', async () => {
    const { hub, base } = await startHub();
    try {
      const runner = await fakeRunner(base);
      assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true, version: '1.2.3' });
      runner.close();
    } finally {
      await hub.close();
    }
  });
});

describe('run streams one person holds open', () => {
  it('are counted, refused past the limit, and given back when a stream closes', async () => {
    const { hub, base } = await startHub({ maxStreamsPerUser: 2 });
    try {
      const runner = await fakeRunner(base);
      const open = async () => {
        const controller = new AbortController();
        const response = await fetch(`${base}/v1/runs/sr_x/events`, { headers: STUDIO, signal: controller.signal });
        return { response, controller };
      };
      const first = await open();
      const second = await open();
      assert.equal(first.response.status, 200);
      assert.equal(second.response.status, 200);

      // These used to be unlimited: a stream outlives the request the per-person limit counted.
      const third = await fetch(`${base}/v1/runs/sr_x/events`, { headers: STUDIO });
      assert.equal(third.status, 429);
      assert.match(((await third.json()) as { error: string }).error, /Too many run streams/);

      first.controller.abort();
      let reopened: Awaited<ReturnType<typeof open>> | null = null;
      for (let tries = 0; tries < 100 && reopened === null; tries += 1) {
        const attempt = await open();
        if (attempt.response.status === 200) reopened = attempt;
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(reopened !== null, 'the place of a closed stream is given back');
      second.controller.abort();
      reopened.controller.abort();
      runner.close();
    } finally {
      await hub.close();
    }
  });

  it('are cut when the browser stops reading, instead of being held in the hub’s memory', async () => {
    const { hub, base, port, logs } = await startHub({ maxBuffered: 256 * 1024 });
    let flooding = true;
    try {
      const filler = 'x'.repeat(16 * 1024);
      const runner = await fakeRunner(base, (send, id) => {
        let seq = 0;
        const flood = () => {
          if (!flooding) return;
          for (let index = 0; index < 50; index += 1) send({ t: 'record', id, record: { seq: (seq += 1), type: 'engine', data: { type: 'note', message: filler } } });
          setImmediate(flood);
        };
        flood();
      });
      // A browser that asks for the stream and then never reads it.
      const socket: Socket = connect(port, '127.0.0.1');
      const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
      socket.on('error', () => undefined);
      await new Promise((resolve) => socket.on('connect', resolve));
      socket.pause();
      socket.write(`GET /v1/runs/sr_x/events HTTP/1.1\r\nHost: hub\r\nAuthorization: ${STUDIO.authorization}\r\n\r\n`);

      const cut = async () => {
        for (let tries = 0; tries < 500; tries += 1) {
          if (logs.some((entry) => entry.msg === 'cut a run stream nobody was reading')) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      };
      assert.equal(await cut(), true);
      flooding = false;
      socket.resume();
      await closed;
      runner.close();
    } finally {
      flooding = false;
      await hub.close();
    }
  });
});

describe('the WebSocket server, sending to a peer that does not read', () => {
  it('cuts the connection once too much is waiting, and says why', async () => {
    let finished: (value: { code: number; reason: string; refusedAt: number }) => void = () => undefined;
    const outcome = new Promise<{ code: number; reason: string; refusedAt: number }>((resolve) => (finished = resolve));
    const server = createServer((_request, response) => response.writeHead(404).end());
    server.on('upgrade', (request, socket, head) => {
      assert.ok(isWebSocketUpgrade(request));
      socket.on('error', () => undefined);
      const ws = acceptWebSocket(request, socket, head, { maxBuffered: 256 * 1024, pingIntervalMs: 60_000 });
      // How many messages went out before one was refused. The close listener
      // runs inside the refused `send`, so the count is kept as they go.
      let accepted = 0;
      ws.onClose((code, reason) => finished({ code, reason, refusedAt: accepted }));
      const message = 'y'.repeat(64 * 1024);
      const push = (): void => {
        if (!ws.send(message)) return;
        accepted += 1;
        if (accepted < 10_000) setImmediate(push);
      };
      push();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    try {
      await new Promise((resolve) => socket.on('connect', resolve));
      // Completes the handshake and then reads nothing more.
      socket.pause();
      socket.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      const result = await outcome;
      assert.equal(result.code, 1013);
      assert.equal(result.reason, 'peer is not reading');
      assert.ok(result.refusedAt > 0 && result.refusedAt < 10_000, `stopped after ${result.refusedAt} messages, not after all of them`);
    } finally {
      socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
});
