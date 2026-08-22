import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import type {
  AgentEvent,
  AgentHarness,
  AgentRunOptions,
  AgentSession,
  AvailabilityResult,
  ResumeOptions,
} from '../../src/agents/types.ts';
import { makeEvent } from '../../src/agents/types.ts';
import type { ConformanceSubject } from './conformance.ts';

/**
 * A harness that violates every clause of the contract on purpose.
 *
 * It exists to prove the conformance suite has teeth: for each scenario the
 * suite replays, this harness does the specific wrong thing — lies about a
 * crashed process, re-sends context on resume, puts the prompt on argv, hangs
 * through a cancel, throws past the boundary, misclassifies its errors — and
 * `test/conformanceBroken.test.ts` asserts that every clause catches it.
 */
class BrokenHarness implements AgentHarness {
  readonly name = 'broken';

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, detail: 'broken on purpose' };
  }

  /** The scenario the suite is replaying, read the same way the player reads it. */
  private scenario(): string {
    const fixture = process.env['RELAY_HARNESS_FIXTURE'];
    return fixture === undefined ? 'none' : basename(fixture, '.json');
  }

  private capture(argv: string[], stdin: string): void {
    const path = process.env['RELAY_HARNESS_CAPTURE'];
    if (path !== undefined) writeFileSync(path, JSON.stringify({ argv, stdin }));
  }

  async start(options: AgentRunOptions): Promise<AgentSession> {
    switch (this.scenario()) {
      case 'success':
        // Prompt on argv, nothing on stdin, no started event, no usage, no
        // final text: one turn, five violations.
        this.capture(['run', options.prompt], '');
        return this.session(options, {
          ok: true,
          text: '',
          events: [
            makeEvent('message', options.role, { text: 'did some work' }),
            makeEvent('completed', options.role, {}),
          ],
          sessionId: 'broken-session',
        });

      case 'hang':
        // Never emits started, never settles. cancel() below resolves without
        // actually terminating anything.
        return new Promise<AgentSession>(() => {});

      case 'killed':
      case 'nonzero':
        // The process died; the harness reports a success anyway.
        return this.session(options, { ok: true, text: 'all good', events: [] });

      case 'malformed':
        // A throw across the harness boundary, which the contract forbids.
        throw new Error('broken harness leaked a stream parse error');

      case 'transient':
        // A retryable outage reworded so retry.ts reads it as terminal.
        return this.session(options, { ok: false, text: '', events: [], error: 'invalid api key' });

      case 'auth':
        // An auth failure reworded so retry.ts would happily retry it.
        return this.session(options, { ok: false, text: '', events: [], error: '429 too many requests, retry soon' });

      default:
        // Covers the missing-executable clause: the binary does not exist and
        // the harness claims the turn went fine.
        return this.session(options, { ok: true, text: 'ran nothing, reporting success', events: [] });
    }
  }

  async resume(_sessionId: string, prompt: string, options: ResumeOptions): Promise<AgentSession> {
    // Re-sends the whole context on stdin and never tells the CLI which
    // session to continue.
    this.capture(['--continue'], `RELAY-CONFORMANCE-PROMPT: the entire prior context\n${prompt}`);
    return this.session({ ...options, prompt }, {
      ok: true,
      text: 'Follow-up complete.',
      events: [makeEvent('completed', options.role, { result: 'Follow-up complete.' })],
      sessionId: 'a-different-session',
    });
  }

  async cancel(): Promise<void> {
    // Resolves happily while the "work" from the hang scenario runs forever.
  }

  private session(
    options: AgentRunOptions,
    fields: { ok: boolean; text: string; events: AgentEvent[]; error?: string; sessionId?: string },
  ): AgentSession {
    return {
      provider: this.name,
      role: options.role,
      ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
      ok: fields.ok,
      text: fields.text,
      events: fields.events,
      ...(fields.error === undefined ? {} : { error: fields.error }),
      exitCode: fields.ok ? 0 : 1,
      durationMs: 1,
      timedOut: false,
      aborted: false,
      invocation: { command: 'broken', args: [] },
    };
  }
}

/** A conformance subject wrapping the broken harness. Fixtures are never read. */
export function brokenSubject(fixtureDir: string): ConformanceSubject {
  return {
    name: 'broken',
    create: () => new BrokenHarness(),
    fixtureDir,
    finalText: 'Wired the flux capacitor; tests pass.',
    resumeText: 'Follow-up complete.',
    reportsUsage: true,
    readOnly: { enforcedBy: 'cli', proves: (argv) => argv.includes('--read-only') },
  };
}
