import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeArgs,
  claudeUsage,
  normalizeClaudeLine,
  CLAUDE_ALWAYS_DENIED,
  CLAUDE_READ_ONLY_DENIED,
} from '../src/agents/claude.ts';
import {
  buildCodexArgs,
  codexUsage,
  normalizeCodexLine,
  codexSandboxMode,
  CODEX_EXEC_ONLY_FLAGS,
} from '../src/agents/codex.ts';
import { describeEvent, type AgentCapability } from '../src/agents/types.ts';
import { AGENT_REGISTRY, AGENT_PROVIDERS, createHarnesses, isAgentProvider } from '../src/agents/index.ts';
import { ROLES, type Role } from '../src/storage/config.ts';

describe('claude command construction', () => {
  it('requests a machine-readable stream and a caller-chosen session id', () => {
    const args = buildClaudeArgs({ capability: 'write', sessionId: 'abc-123' });
    assert.ok(args.includes('-p'));
    assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), [
      '--output-format',
      'stream-json',
    ]);
    assert.ok(args.includes('--session-id'));
    assert.equal(args[args.indexOf('--session-id') + 1], 'abc-123');
  });

  it('resumes by session id instead of starting a new conversation', () => {
    const args = buildClaudeArgs({ capability: 'read_only', resumeSessionId: 'sess-9' });
    assert.equal(args[args.indexOf('--resume') + 1], 'sess-9');
    assert.ok(!args.includes('--session-id'));
  });

  it('always denies push and merge tooling', () => {
    for (const capability of ['read_only', 'write'] as const) {
      const args = buildClaudeArgs({ capability });
      for (const denied of CLAUDE_ALWAYS_DENIED) {
        assert.ok(args.includes(denied), `${capability} should deny ${denied}`);
      }
    }
  });

  it('denies edit tools for read-only roles only', () => {
    const readOnly = buildClaudeArgs({ capability: 'read_only' });
    const write = buildClaudeArgs({ capability: 'write' });

    for (const tool of CLAUDE_READ_ONLY_DENIED) {
      assert.ok(readOnly.includes(tool), `read-only should deny ${tool}`);
      assert.ok(!write.includes(tool), `write should allow ${tool}`);
    }
  });

  it('omits the model flag when no model is configured', () => {
    assert.ok(!buildClaudeArgs({ capability: 'write' }).includes('--model'));
    assert.ok(buildClaudeArgs({ capability: 'write', model: 'opus' }).includes('--model'));
  });

  it('serializes a JSON schema when structured output is requested', () => {
    const args = buildClaudeArgs({ capability: 'read_only', outputSchema: { type: 'object' } });
    assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}');
  });
});

describe('claude event normalization', () => {
  it('captures the session id from the init event', () => {
    const events = normalizeClaudeLine(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      'planner',
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'started');
    assert.equal(events[0]?.type === 'started' ? events[0].sessionId : undefined, 'sess-1');
  });

  it('ignores unrelated system and rate-limit lines', () => {
    assert.deepEqual(normalizeClaudeLine({ type: 'rate_limit_event' }, 'planner'), []);
    assert.deepEqual(normalizeClaudeLine({ type: 'system', subtype: 'other' }, 'planner'), []);
  });

  it('maps text, bash and edit blocks onto distinct event types', () => {
    const events = normalizeClaudeLine(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'working on it' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
          ],
        },
      },
      'implementer',
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ['message', 'command', 'file_changed', 'tool'],
    );
    assert.equal(describeEvent(events[1]!), '$ npm test');
    assert.equal(describeEvent(events[2]!), 'edited: src/app.ts');
  });

  it('treats a result with is_error as a failure even when subtype is success', () => {
    const events = normalizeClaudeLine(
      { type: 'result', subtype: 'success', is_error: true, result: 'context limit reached' },
      'planner',
    );
    assert.equal(events[0]?.type, 'failed');
  });

  it('extracts the final message from a successful result', () => {
    const events = normalizeClaudeLine(
      { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      'planner',
    );
    assert.equal(events[0]?.type, 'completed');
    assert.equal(events[0]?.type === 'completed' ? events[0].result : undefined, 'done');
  });
});

describe('claude usage reporting', () => {
  const RESULT = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    total_cost_usd: 0.1234,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      output_tokens: 250,
    },
  };

  it('counts cached and cache-creation tokens as billed input', () => {
    assert.deepEqual(claudeUsage(RESULT), { inputTokens: 1110, outputTokens: 250, costUsd: 0.1234 });
  });

  it('attaches usage to the completed event', () => {
    const events = normalizeClaudeLine(RESULT, 'planner');
    assert.equal(events[0]?.type, 'completed');
    assert.deepEqual(events[0]?.type === 'completed' ? events[0].usage : undefined, {
      inputTokens: 1110,
      outputTokens: 250,
      costUsd: 0.1234,
    });
  });

  it('still reports usage for a failed turn, which was billed all the same', () => {
    const events = normalizeClaudeLine({ ...RESULT, is_error: true }, 'planner');
    assert.equal(events[0]?.type, 'failed');
    assert.equal(events[0]?.type === 'failed' ? events[0].usage?.outputTokens : undefined, 250);
  });

  it('reports nothing rather than zeros when the line carries no counts', () => {
    assert.equal(claudeUsage({ type: 'result', subtype: 'success' }), undefined);
    assert.equal(claudeUsage({ usage: { input_tokens: 'lots' } }), undefined);
  });

  it('keeps token counts when only the cost is missing', () => {
    assert.deepEqual(claudeUsage({ usage: { input_tokens: 5, output_tokens: 7 } }), {
      inputTokens: 5,
      outputTokens: 7,
    });
  });

  it('drops negative and fractional token counts instead of corrupting the total', () => {
    assert.equal(claudeUsage({ usage: { input_tokens: -500, output_tokens: 12.7 } }), undefined);
    assert.deepEqual(claudeUsage({ usage: { input_tokens: 40, cache_read_input_tokens: -30, output_tokens: 1.5 } }), {
      inputTokens: 40,
      outputTokens: 0,
    });
  });

  it('ignores a negative cost, which would refund the run total', () => {
    assert.deepEqual(claudeUsage({ usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: -1.5 }), {
      inputTokens: 5,
      outputTokens: 7,
    });
  });
});

describe('codex command construction', () => {
  it('maps capability onto the sandbox policy', () => {
    assert.equal(codexSandboxMode('read_only'), 'read-only');
    assert.equal(codexSandboxMode('write'), 'workspace-write');
  });

  it('uses --sandbox on a fresh exec', () => {
    const args = buildCodexArgs({ capability: 'write' });
    assert.equal(args[0], 'exec');
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.ok(args.includes('--json'));
  });

  it('sets the sandbox via config override when resuming, since resume has no --sandbox flag', () => {
    const args = buildCodexArgs({ capability: 'read_only', resumeSessionId: 'thread-7' });
    assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'thread-7']);
    assert.ok(!args.includes('--sandbox'));
    assert.ok(args.includes('sandbox_mode="read-only"'));
  });

  it('passes no exec-only flag to resume', () => {
    // `codex exec resume` takes a narrower option set than `codex exec`, and
    // rejects the difference with exit 2 before doing any work.
    const args = buildCodexArgs({
      capability: 'write',
      resumeSessionId: 'thread-7',
      lastMessageFile: '/tmp/last.txt',
      outputSchemaFile: '/tmp/schema.json',
      model: 'gpt-5',
    });

    for (const flag of CODEX_EXEC_ONLY_FLAGS) {
      assert.ok(!args.includes(flag), `resume must not pass ${flag}`);
    }
  });

  it('only passes flags that codex exec resume documents', () => {
    const RESUME_SUPPORTED = new Set([
      '--last', '--all', '-c', '--config', '--enable', '--disable', '-i', '--image',
      '--strict-config', '-m', '--model', '--skip-git-repo-check', '--ephemeral',
      '--ignore-user-config', '--ignore-rules', '--output-schema', '--json',
      '-o', '--output-last-message',
    ]);

    const args = buildCodexArgs({
      capability: 'read_only',
      resumeSessionId: 'thread-7',
      lastMessageFile: '/tmp/last.txt',
      outputSchemaFile: '/tmp/schema.json',
      model: 'gpt-5',
    });

    for (const arg of args) {
      if (arg.startsWith('-') && arg !== '-') {
        assert.ok(RESUME_SUPPORTED.has(arg), `codex exec resume does not accept ${arg}`);
      }
    }
  });

  it('never leaves approvals interactive', () => {
    for (const args of [buildCodexArgs({ capability: 'write' }), buildCodexArgs({ capability: 'write', resumeSessionId: 't' })]) {
      assert.ok(args.includes('approval_policy="never"'));
    }
  });

  it('reads the prompt from stdin', () => {
    assert.equal(buildCodexArgs({ capability: 'write' }).at(-1), '-');
  });

  it('passes through the last-message and schema file paths', () => {
    const args = buildCodexArgs({
      capability: 'read_only',
      lastMessageFile: '/tmp/last.txt',
      outputSchemaFile: '/tmp/schema.json',
    });
    assert.equal(args[args.indexOf('--output-last-message') + 1], '/tmp/last.txt');
    assert.equal(args[args.indexOf('--output-schema') + 1], '/tmp/schema.json');
  });
});

describe('codex event normalization', () => {
  it('captures the thread id as the session id', () => {
    const events = normalizeCodexLine({ type: 'thread.started', thread_id: 'thread-1' }, 'implementer');
    assert.equal(events[0]?.type, 'started');
    assert.equal(events[0]?.type === 'started' ? events[0].sessionId : undefined, 'thread-1');
  });

  it('maps agent messages, reasoning and commands', () => {
    const message = normalizeCodexLine(
      { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      'implementer',
    );
    assert.equal(message[0]?.type, 'message');

    const reasoning = normalizeCodexLine(
      { type: 'item.completed', item: { type: 'reasoning', text: 'considering options' } },
      'implementer',
    );
    assert.equal(reasoning[0]?.type, 'thinking');

    const command = normalizeCodexLine(
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 1 } },
      'implementer',
    );
    assert.equal(command[0]?.type, 'command');
    assert.equal(describeEvent(command[0]!), '$ npm test → exit 1');
  });

  it('reports a command only once, on completion', () => {
    const started = normalizeCodexLine(
      { type: 'item.started', item: { type: 'command_execution', command: 'npm test' } },
      'implementer',
    );
    assert.deepEqual(started, []);
  });

  it('expands a multi-file change into one event per path', () => {
    const events = normalizeCodexLine(
      {
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'a.ts', kind: 'edit' }, { path: 'b.ts', kind: 'add' }] },
      },
      'implementer',
    );
    assert.deepEqual(
      events.map((event) => (event.type === 'file_changed' ? event.path : '')),
      ['a.ts', 'b.ts'],
    );
  });

  it('surfaces failed turns as failures', () => {
    const events = normalizeCodexLine({ type: 'turn.failed', error: { message: 'sandbox denied' } }, 'implementer');
    assert.equal(events[0]?.type, 'failed');
    assert.equal(events[0]?.type === 'failed' ? events[0].error : '', 'sandbox denied');
  });

  it('ignores turn.started and unknown lines', () => {
    assert.deepEqual(normalizeCodexLine({ type: 'turn.started' }, 'x'), []);
    assert.deepEqual(normalizeCodexLine({ type: 'something.else' }, 'x'), []);
  });
});

describe('codex usage reporting', () => {
  const COMPLETED = {
    type: 'turn.completed',
    usage: { input_tokens: 2000, cached_input_tokens: 1800, output_tokens: 400 },
  };

  it('does not double-count cached input, which codex already includes', () => {
    assert.deepEqual(codexUsage(COMPLETED), { inputTokens: 2000, outputTokens: 400 });
  });

  it('reports no cost, because codex publishes none', () => {
    assert.equal(codexUsage(COMPLETED)?.costUsd, undefined);
  });

  it('attaches usage to the completed event', () => {
    const events = normalizeCodexLine(COMPLETED, 'implementer');
    assert.equal(events[0]?.type, 'completed');
    assert.equal(events[0]?.type === 'completed' ? events[0].usage?.inputTokens : undefined, 2000);
  });

  it('attaches usage to a failed turn as well', () => {
    const events = normalizeCodexLine(
      { type: 'turn.failed', error: { message: 'sandbox denied' }, usage: { input_tokens: 12, output_tokens: 3 } },
      'implementer',
    );
    assert.equal(events[0]?.type, 'failed');
    assert.deepEqual(events[0]?.type === 'failed' ? events[0].usage : undefined, {
      inputTokens: 12,
      outputTokens: 3,
    });
  });

  it('reports nothing when a turn carries no usage block', () => {
    assert.equal(codexUsage({ type: 'turn.completed' }), undefined);
    const event = normalizeCodexLine({ type: 'turn.completed' }, 'x')[0];
    assert.equal(event?.type, 'completed');
    assert.equal(event?.type === 'completed' ? event.usage : 'missing', undefined);
  });

  it('drops negative and fractional token counts instead of corrupting the total', () => {
    assert.equal(codexUsage({ usage: { input_tokens: -2000, output_tokens: 0.5 } }), undefined);
    assert.deepEqual(codexUsage({ usage: { input_tokens: 900, output_tokens: -4 } }), {
      inputTokens: 900,
      outputTokens: 0,
    });
  });
});

describe('harness registry', () => {
  it('exposes a unique, non-empty name for every registered CLI', () => {
    assert.ok(AGENT_REGISTRY.length >= 2);
    const names = AGENT_REGISTRY.map((entry) => entry.name);
    assert.deepEqual(names, AGENT_PROVIDERS);
    assert.equal(new Set(names).size, names.length);
    for (const entry of AGENT_REGISTRY) {
      assert.ok(entry.name.length > 0);
      assert.ok(entry.label.length > 0);
    }
  });

  it('builds one harness per registered name, reporting that name back', () => {
    const harnesses = createHarnesses();
    assert.deepEqual(Object.keys(harnesses).sort(), [...AGENT_PROVIDERS].sort());
    for (const entry of AGENT_REGISTRY) {
      assert.equal(harnesses[entry.name]?.name, entry.name);
    }
  });

  it('passes each provider only its own configured model', () => {
    const first = AGENT_REGISTRY[0]!;
    const harness = first.create({ defaultModel: 'some-model' });
    // The harness owns its model; Relay only asserts construction is accepted.
    assert.equal(harness.name, first.name);
  });

  it('recognizes exactly the registered names', () => {
    for (const name of AGENT_PROVIDERS) assert.ok(isAgentProvider(name));
    assert.equal(isAgentProvider('gemini'), false);
    assert.equal(isAgentProvider(undefined), false);
    assert.equal(isAgentProvider(42), false);
  });

  it('declares its read-only enforcement, for relay doctor to report', () => {
    for (const entry of AGENT_REGISTRY) {
      assert.ok(['os-sandbox', 'deny-list'].includes(entry.enforcement.readOnly), entry.name);
      assert.ok(entry.enforcement.detail.length > 0, `${entry.name} must say what enforces read-only`);
    }
  });
});

/**
 * The Safety claim, asserted against the argv each harness actually builds
 * rather than in prose: `git push`, `git merge`, `gh pr create` and
 * `gh pr merge` are closed to every agent in every role.
 *
 * The suite is parameterized over `AGENT_REGISTRY`, and the first test fails
 * for any registered harness with no entry in the assertion table — a future
 * harness cannot ship without stating, and proving, how it denies these.
 */
describe('the deny list in the constructed argv, per harness and role', () => {
  /** The capability each role runs with, mirroring `src/workflow/phases/`. */
  const ROLE_CAPABILITY: Record<Role, AgentCapability> = {
    planner: 'read_only',
    planReviewer: 'read_only',
    implementer: 'write',
    codeReviewer: 'read_only',
  };

  const DENIED_COMMANDS = ['git push', 'git merge', 'gh pr create', 'gh pr merge'] as const;

  const DENY_ASSERTIONS: Record<string, (args: readonly string[], capability: AgentCapability) => void> = {
    // Claude denies by name: every forbidden command must appear in the
    // --disallowed-tools list, and read-only roles lose the edit tools too.
    claude: (args, capability) => {
      for (const command of DENIED_COMMANDS) {
        assert.ok(args.includes(`Bash(${command}:*)`), `claude argv must deny \`${command}\``);
      }
      if (capability === 'read_only') {
        for (const tool of CLAUDE_READ_ONLY_DENIED) {
          assert.ok(args.includes(tool), `read-only claude argv must deny ${tool}`);
        }
      }
    },
    // Codex denies by sandbox: read-only turns cannot write at all, and
    // workspace-write turns have no network to push or open anything with.
    // The argv must select that sandbox and must not weaken it.
    codex: (args, capability) => {
      const mode = capability === 'write' ? 'workspace-write' : 'read-only';
      const viaFlag = args.includes('--sandbox') && args[args.indexOf('--sandbox') + 1] === mode;
      const viaConfig = args.includes(`sandbox_mode="${mode}"`);
      assert.ok(viaFlag || viaConfig, `codex argv must select the ${mode} sandbox`);
      assert.ok(args.includes('approval_policy="never"'), 'codex must never wait on an approval prompt');
      assert.ok(
        !args.some((arg) => /network_access\s*=\s*true|danger|bypass/i.test(arg)),
        'codex argv must not weaken its sandbox',
      );
    },
  };

  it('has assertions for every registered harness, so a new one cannot omit them', () => {
    for (const entry of AGENT_REGISTRY) {
      assert.ok(
        Object.hasOwn(DENY_ASSERTIONS, entry.name),
        `no deny-list assertions for harness "${entry.name}" — add them to this table before registering it`,
      );
    }
  });

  for (const entry of AGENT_REGISTRY) {
    for (const role of ROLES) {
      it(`${entry.name} as ${role} (${ROLE_CAPABILITY[role]})`, async () => {
        // A no-op binary: the harness spawns it and records the exact argv it
        // would have handed the real CLI, without needing that CLI installed.
        const harness = entry.create({ binary: 'true' });
        const turn = { prompt: 'noop', cwd: process.cwd(), role, capability: ROLE_CAPABILITY[role], timeoutMs: 30_000 };

        const started = await harness.start(turn);
        DENY_ASSERTIONS[entry.name]!(started.invocation.args, ROLE_CAPABILITY[role]);

        // Resume builds a different argv shape; the denial must survive it.
        const resumed = await harness.resume('00000000-0000-0000-0000-000000000000', 'noop', turn);
        DENY_ASSERTIONS[entry.name]!(resumed.invocation.args, ROLE_CAPABILITY[role]);
      });
    }
  }
});
