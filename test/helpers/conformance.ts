import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentCapability, AgentHarness, AgentSession } from '../../src/agents/types.ts';
import { classifyFailure } from '../../src/workflow/retry.ts';

/**
 * The harness conformance suite: the executable form of the contract written
 * in prose above `AgentHarness` in `src/agents/types.ts`.
 *
 * Each clause below asserts an obligation of the contract, never an
 * implementation detail: what events a turn emits, where the prompt travels,
 * what a failure looks like, how read-only is proven. A subject supplies a
 * harness factory and a directory of recorded stream fixtures (replayed by
 * `fake-cli.mjs`), so the whole suite runs hermetically, with no real CLI, no
 * network and no tokens — and a new harness is done when every clause passes.
 */
export interface ConformanceSubject {
  name: string;
  /** Builds the harness under test, pointed at the given executable. */
  create(binary: string): AgentHarness;
  /** Directory holding this CLI's recorded scenario fixtures. */
  fixtureDir: string;
  /** Final text of the success fixture's turn. */
  finalText: string;
  /** Final text of the resume fixture's turn. */
  resumeText: string;
  /** Whether the success fixture reports token usage. */
  reportsUsage: boolean;
  /**
   * Who enforces `read_only`, with the test proving which. `cli` means the
   * enforcement is visible on the argv (`proves` recognizes it and must NOT
   * match a write turn's argv); `harness` means the harness itself refuses the
   * turn before the CLI is ever spawned.
   */
  readOnly:
    | { enforcedBy: 'cli'; proves: (argv: readonly string[]) => boolean }
    | { enforcedBy: 'harness' };
}

export const CONFORMANCE_CLAUSES = [
  'a successful turn yields started, work events, completed, final text and usage',
  'the prompt arrives on stdin and never as an argv entry',
  'resume continues the same conversation without re-sending context',
  'cancel terminates in-flight work and resolves',
  'a killed process produces a failed event, not a hang or a throw',
  'a non-zero exit produces a failed event, not a hang or a throw',
  'a malformed stream produces a failed event, not a quiet success',
  'a missing executable fails the turn without throwing',
  'read_only is enforced, and the test proves by whom',
  'transient failures are classified as retryable',
  'auth failures are classified as terminal, never retried',
] as const;

export type ConformanceClause = (typeof CONFORMANCE_CLAUSES)[number];

export const PLAYER = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
// The exec bit does not survive every checkout, and a silent ENOEXEC would
// fail every clause with the least useful message available.
chmodSync(PLAYER, 0o755);

const PROMPT_MARKER = 'RELAY-CONFORMANCE-PROMPT';
const PROMPT = `${PROMPT_MARKER}: read the issue and do the work.`;
const RESUME_MARKER = 'RELAY-CONFORMANCE-FOLLOWUP';
const RESUME_PROMPT = `${RESUME_MARKER}: address the review findings.`;

/** How long any single settle may take before the clause fails as a hang. */
const SETTLE_MS = 4_000;

export interface TurnCapture {
  argv: string[];
  stdin: string;
}

export interface TurnResult {
  session: AgentSession;
  /** What the fixture player saw, absent when no process was ever spawned. */
  capture: TurnCapture | undefined;
}

function settleWithin<T>(promise: Promise<T>, label: string, ms = SETTLE_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new assert.AssertionError({ message: `${label} did not settle within ${ms}ms — the harness hung` })),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function readCapture(path: string): TurnCapture | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as TurnCapture;
}

interface Scratch {
  dir: string;
  capturePath: string;
}

async function openScenario(subject: ConformanceSubject, scenario: string): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-conformance-'));
  const capturePath = join(dir, 'capture.json');
  process.env['RELAY_HARNESS_FIXTURE'] = join(subject.fixtureDir, `${scenario}.json`);
  process.env['RELAY_HARNESS_CAPTURE'] = capturePath;
  return { dir, capturePath };
}

async function closeScenario(scratch: Scratch): Promise<void> {
  delete process.env['RELAY_HARNESS_FIXTURE'];
  delete process.env['RELAY_HARNESS_CAPTURE'];
  await rm(scratch.dir, { recursive: true, force: true });
}

/** Runs one scripted `start` turn against a recorded scenario. */
export async function runStart(
  subject: ConformanceSubject,
  scenario: string,
  capability: AgentCapability = 'write',
  prompt: string = PROMPT,
): Promise<TurnResult> {
  const scratch = await openScenario(subject, scenario);
  try {
    const harness = subject.create(PLAYER);
    const session = await settleWithin(
      harness.start({ prompt, cwd: scratch.dir, role: 'conformance', capability, timeoutMs: SETTLE_MS - 2_000 }),
      `${subject.name} ${scenario} turn`,
    );
    return { session, capture: readCapture(scratch.capturePath) };
  } finally {
    await closeScenario(scratch);
  }
}

/** Runs one scripted `resume` turn against a recorded scenario. */
export async function runResume(
  subject: ConformanceSubject,
  scenario: string,
  sessionId: string,
  prompt: string = RESUME_PROMPT,
): Promise<TurnResult> {
  const scratch = await openScenario(subject, scenario);
  try {
    const harness = subject.create(PLAYER);
    const session = await settleWithin(
      harness.resume(sessionId, prompt, {
        cwd: scratch.dir,
        role: 'conformance',
        capability: 'write',
        timeoutMs: SETTLE_MS - 2_000,
      }),
      `${subject.name} resumed turn`,
    );
    return { session, capture: readCapture(scratch.capturePath) };
  } finally {
    await closeScenario(scratch);
  }
}

const WORK_EVENT_TYPES = new Set(['message', 'thinking', 'tool', 'command', 'file_changed']);

function assertFailedProperly(session: AgentSession, what: string): void {
  assert.equal(session.ok, false, `${what} must not report ok`);
  assert.ok((session.error ?? '').length > 0, `${what} must carry an error message`);
  assert.ok(
    session.events.some((event) => event.type === 'failed'),
    `${what} must produce a failed event`,
  );
}

/**
 * Checks one clause of the contract against one subject, throwing an
 * AssertionError (and never hanging) when the harness violates it. The
 * per-clause entry point exists so a deliberately broken harness can be shown
 * to fail every clause individually.
 */
export async function checkConformanceClause(subject: ConformanceSubject, clause: ConformanceClause): Promise<void> {
  switch (clause) {
    case 'a successful turn yields started, work events, completed, final text and usage': {
      const { session } = await runStart(subject, 'success');
      assert.equal(session.ok, true, `success fixture must succeed (error: ${session.error ?? 'none'})`);
      assert.equal(session.text, subject.finalText, 'the final text is the artifact Relay parses');
      assert.ok(session.sessionId !== undefined && session.sessionId.length > 0, 'a session id must be reported');

      const types = session.events.map((event) => event.type);
      assert.equal(types[0], 'started', `the first event must be started (got ${types.join(' → ')})`);
      const completedAt = types.indexOf('completed');
      assert.ok(completedAt !== -1, 'a successful turn must emit completed');
      assert.equal(types.filter((type) => type === 'completed').length, 1, 'exactly one completed');
      assert.ok(
        types.slice(1, completedAt).some((type) => WORK_EVENT_TYPES.has(type)),
        'work events must appear between started and completed',
      );
      assert.ok(
        types.slice(completedAt + 1).every((type) => type === 'notice'),
        'nothing but notices may follow completed',
      );

      if (subject.reportsUsage) {
        assert.ok(session.usage !== undefined, 'the CLI reported usage, so the session must carry it');
        assert.ok(session.usage.inputTokens > 0 || session.usage.outputTokens > 0, 'usage must carry real counts');
      }
      return;
    }

    case 'the prompt arrives on stdin and never as an argv entry': {
      const { capture } = await runStart(subject, 'success');
      assert.ok(capture !== undefined, 'the CLI was never invoked, so nothing proves prompt delivery');
      assert.equal(capture.stdin, PROMPT, 'the prompt must arrive on stdin, verbatim and alone');
      for (const arg of capture.argv) {
        assert.ok(!arg.includes(PROMPT_MARKER), `the prompt leaked into argv: ${arg}`);
      }
      return;
    }

    case 'resume continues the same conversation without re-sending context': {
      const first = await runStart(subject, 'success');
      const sessionId = first.session.sessionId;
      assert.ok(sessionId !== undefined && sessionId.length > 0, 'start must report a session id to resume');

      const second = await runResume(subject, 'resume', sessionId);
      assert.ok(second.capture !== undefined, 'the CLI was never invoked for the resumed turn');
      assert.ok(
        second.capture.argv.includes(sessionId),
        `the CLI must be handed the session id on argv (got: ${second.capture.argv.join(' ')})`,
      );
      assert.equal(second.capture.stdin, RESUME_PROMPT, 'only the new prompt travels — context is not re-sent');
      assert.ok(!second.capture.stdin.includes(PROMPT_MARKER), 'the first prompt must not be re-sent');
      assert.equal(second.session.ok, true, `the resumed turn must succeed (error: ${second.session.error ?? 'none'})`);
      assert.equal(second.session.text, subject.resumeText);
      assert.equal(second.session.sessionId, sessionId, 'the conversation must stay the same conversation');
      return;
    }

    case 'cancel terminates in-flight work and resolves': {
      const scratch = await openScenario(subject, 'hang');
      try {
        const harness = subject.create(PLAYER);
        let sawStarted: () => void;
        const started = new Promise<void>((resolve) => {
          sawStarted = resolve;
        });
        const turn = harness.start({
          prompt: PROMPT,
          cwd: scratch.dir,
          role: 'conformance',
          capability: 'write',
          timeoutMs: 60_000,
          onEvent: (event) => {
            if (event.type === 'started') sawStarted();
          },
        });
        // Prevent an unhandled rejection racing the assertions below.
        turn.catch(() => {});

        await settleWithin(started, `${subject.name} started event`);
        await settleWithin(harness.cancel(), `${subject.name} cancel()`);
        const session = await settleWithin(turn, `${subject.name} cancelled turn`);

        assert.equal(session.ok, false, 'a cancelled turn must not report ok');
        assert.equal(session.aborted, true, 'a cancelled turn must report aborted');
        assert.ok((session.error ?? '').length > 0, 'a cancelled turn must carry an error message');
      } finally {
        await closeScenario(scratch);
      }
      return;
    }

    case 'a killed process produces a failed event, not a hang or a throw': {
      const { session } = await runStart(subject, 'killed');
      assertFailedProperly(session, 'a turn whose process was killed');
      return;
    }

    case 'a non-zero exit produces a failed event, not a hang or a throw': {
      const { session } = await runStart(subject, 'nonzero');
      assertFailedProperly(session, 'a turn whose process exited non-zero');
      return;
    }

    case 'a malformed stream produces a failed event, not a quiet success': {
      const { session } = await runStart(subject, 'malformed');
      assertFailedProperly(session, 'a turn whose stream was malformed');
      return;
    }

    case 'a missing executable fails the turn without throwing': {
      // No fixture: the process never starts. Stale env from another scenario
      // is cleared so nothing can accidentally respond.
      delete process.env['RELAY_HARNESS_FIXTURE'];
      delete process.env['RELAY_HARNESS_CAPTURE'];
      const dir = await mkdtemp(join(tmpdir(), 'relay-conformance-'));
      try {
        const harness = subject.create(join(dir, 'no-such-binary'));
        const session = await settleWithin(
          harness.start({ prompt: PROMPT, cwd: dir, role: 'conformance', capability: 'write', timeoutMs: 4_000 }),
          `${subject.name} turn with a missing executable`,
        );
        assertFailedProperly(session, 'a turn whose executable is missing');
        assert.equal(classifyFailure(session), 'terminal', 'a missing executable is not worth retrying');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return;
    }

    case 'read_only is enforced, and the test proves by whom': {
      if (subject.readOnly.enforcedBy === 'cli') {
        const readOnly = await runStart(subject, 'success', 'read_only');
        assert.ok(readOnly.capture !== undefined, 'the CLI was never invoked, so nothing proves enforcement');
        assert.ok(
          subject.readOnly.proves(readOnly.capture.argv),
          `the read-only enforcement must be visible on the argv (got: ${readOnly.capture.argv.join(' ')})`,
        );
        const write = await runStart(subject, 'success', 'write');
        assert.ok(write.capture !== undefined);
        assert.ok(
          !subject.readOnly.proves(write.capture.argv),
          'a write turn must not carry the read-only flags, or the proof proves nothing',
        );
      } else {
        const { session, capture } = await runStart(subject, 'success', 'read_only');
        assertFailedProperly(session, 'a read_only turn the harness cannot enforce');
        assert.match(session.error ?? '', /read.?only/i, 'the refusal must say it is about read-only');
        assert.equal(capture, undefined, 'the harness must refuse before the CLI is ever spawned');
      }
      return;
    }

    case 'transient failures are classified as retryable': {
      const { session } = await runStart(subject, 'transient');
      assert.equal(session.ok, false, 'the transient fixture must fail the turn');
      assert.equal(
        classifyFailure(session),
        'retryable',
        `retry.ts must retry this failure (error: ${session.error ?? 'none'})`,
      );
      return;
    }

    case 'auth failures are classified as terminal, never retried': {
      const { session } = await runStart(subject, 'auth');
      assert.equal(session.ok, false, 'the auth fixture must fail the turn');
      assert.equal(
        classifyFailure(session),
        'terminal',
        `retry.ts must not retry an auth failure (error: ${session.error ?? 'none'})`,
      );
      return;
    }
  }
}
