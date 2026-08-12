import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canResumeAfterFailure, classifyFailure, retryDelayMs, sleep } from '../src/workflow/retry.ts';
import { makeEvent, type AgentEvent, type AgentSession } from '../src/agents/types.ts';

function failedSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    provider: 'claude',
    role: 'planner',
    sessionId: 'session-1',
    ok: false,
    text: '',
    events: [],
    exitCode: 1,
    durationMs: 10,
    timedOut: false,
    aborted: false,
    invocation: { command: 'claude', args: [] },
    ...overrides,
  };
}

describe('transient failure classification', () => {
  it('retries the failures that are about the connection, not the work', () => {
    for (const error of [
      'claude exited with code 1: API Error: 429 rate_limit_error',
      'codex exited with code 1: too many requests, please slow down',
      'claude exited with code 1: {"type":"overloaded_error"}',
      'codex exited with code 1: stream disconnected before completion',
      'claude exited with code 7: request failed: ECONNRESET',
      'codex exited with code 1: 503 Service Unavailable',
      'claude exited with code 1: fetch failed',
      'codex exited with code 1: upstream error: Bad Gateway',
    ]) {
      assert.equal(classifyFailure(failedSession({ error })), 'retryable', `should retry: ${error}`);
    }
  });

  it('never retries an authentication failure, however it is phrased', () => {
    for (const error of [
      'claude exited with code 1: 401 Unauthorized',
      'codex exited with code 1: not authenticated, run `codex login`',
      'claude exited with code 1: invalid API key',
      'codex exited with code 1: 403 Forbidden',
      'Executable not found: claude',
    ]) {
      assert.equal(classifyFailure(failedSession({ error })), 'terminal', `should not retry: ${error}`);
    }
  });

  it('treats an unrecognized failure as terminal rather than burning tokens on it', () => {
    assert.equal(classifyFailure(failedSession({ error: 'codex exited with code 1' })), 'terminal');

    const silent = failedSession();
    delete silent.error;
    assert.equal(classifyFailure(silent), 'terminal');
  });

  it('never retries cancellation', () => {
    assert.equal(classifyFailure(failedSession({ aborted: true, error: 'rate limit' })), 'terminal');
  });

  it('retries a timeout only when the turn produced nothing', () => {
    const silent = failedSession({ timedOut: true, error: 'claude timed out after 1200s' });
    assert.equal(classifyFailure(silent), 'retryable');

    const working: AgentEvent[] = [makeEvent('tool', 'planner', { tool: 'Read' })];
    assert.equal(classifyFailure(failedSession({ timedOut: true, events: working })), 'terminal');
    assert.equal(classifyFailure(failedSession({ timedOut: true, text: 'half an answer' })), 'terminal');
  });

  it('mentioning both a limit and an auth error resolves to terminal', () => {
    assert.equal(classifyFailure(failedSession({ error: '401 Unauthorized (rate limit exceeded)' })), 'terminal');
  });
});

describe('resuming after a transient failure', () => {
  it('resumes only a session the CLI actually reported', () => {
    assert.equal(canResumeAfterFailure(failedSession()), false);

    const started = failedSession({ events: [makeEvent('started', 'planner', { sessionId: 'session-1' })] });
    assert.equal(canResumeAfterFailure(started), true);

    // A session id Relay generated but the CLI never confirmed is not resumable.
    const unconfirmed = { ...started };
    delete unconfirmed.sessionId;
    assert.equal(canResumeAfterFailure(unconfirmed), false);
  });
});

describe('retry backoff', () => {
  it('grows exponentially and stays inside the jitter band', () => {
    for (const [attempt, base] of [
      [1, 2_000],
      [2, 4_000],
      [3, 8_000],
    ] as const) {
      assert.equal(retryDelayMs(attempt, () => 0.5), base);
      assert.equal(retryDelayMs(attempt, () => 0), base * 0.75);
      assert.equal(retryDelayMs(attempt, () => 1), base * 1.25);
    }
  });

  it('caps the delay so a run cannot stall for an hour', () => {
    assert.ok(retryDelayMs(20, () => 1) <= 75_000);
  });

  it('jitters, so two agents that hit the same limit do not retry in lockstep', () => {
    const delays = new Set(Array.from({ length: 20 }, () => retryDelayMs(3)));
    assert.ok(delays.size > 1);
  });

  it('returns immediately when the run is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    await sleep(60_000, controller.signal);
    assert.ok(Date.now() - startedAt < 1_000);
  });
});
