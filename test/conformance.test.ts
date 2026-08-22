import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_REGISTRY } from '../src/agents/index.ts';
import { CLAUDE_READ_ONLY_DENIED } from '../src/agents/claude.ts';
import { ConfigHarness, type HarnessConfig } from '../src/agents/configHarness.ts';
import {
  CONFORMANCE_CLAUSES,
  checkConformanceClause,
  runStart,
  type ConformanceSubject,
} from './helpers/conformance.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/harness', import.meta.url));

/**
 * Contract facts per shipped CLI: where its recorded fixtures live, what the
 * success fixture says, and how its read-only enforcement shows on the argv.
 * Registering a harness without adding a row here fails the suite, which is
 * the point — the suite is how you know a new harness is done.
 */
const SHIPPED: Record<string, Omit<ConformanceSubject, 'name' | 'create'>> = {
  claude: {
    fixtureDir: join(FIXTURES, 'claude'),
    finalText: 'Wired the flux capacitor; tests pass.',
    resumeText: 'Follow-up complete.',
    reportsUsage: true,
    readOnly: {
      enforcedBy: 'cli',
      proves: (argv) => argv.includes('--disallowed-tools') && CLAUDE_READ_ONLY_DENIED.every((tool) => argv.includes(tool)),
    },
  },
  codex: {
    fixtureDir: join(FIXTURES, 'codex'),
    finalText: 'Wired the flux capacitor; tests pass.',
    resumeText: 'Follow-up complete.',
    reportsUsage: true,
    readOnly: {
      enforcedBy: 'cli',
      proves: (argv) => argv[argv.indexOf('--sandbox') + 1] === 'read-only',
    },
  },
};

/** The issue's own example, run through the same suite as the shipped CLIs. */
export const MYTOOL_CONFIG: HarnessConfig = {
  command: 'mytool',
  args: ['run', '--json'],
  promptOn: 'stdin',
  stream: 'jsonl',
  map: { text: '$.message', usage: '$.usage', sessionId: '$.session', error: '$.error' },
  resume: ['--session', '{sessionId}'],
  readOnly: ['--sandbox', 'read-only'],
};

const MYTOOL_SUBJECT: ConformanceSubject = {
  name: 'mytool',
  create: (binary) => new ConfigHarness('mytool', MYTOOL_CONFIG, { binary }),
  fixtureDir: join(FIXTURES, 'mytool'),
  finalText: 'Wired the flux capacitor; tests pass.',
  resumeText: 'Follow-up complete.',
  reportsUsage: true,
  readOnly: {
    enforcedBy: 'cli',
    proves: (argv) => argv.includes('--sandbox') && argv.includes('read-only'),
  },
};

describe('harness conformance', () => {
  it('has a conformance subject for every registered harness', () => {
    for (const entry of AGENT_REGISTRY) {
      assert.ok(
        SHIPPED[entry.name] !== undefined,
        `"${entry.name}" is registered but has no conformance subject — add fixtures under test/fixtures/harness/${entry.name} and a row in SHIPPED`,
      );
    }
  });

  for (const entry of AGENT_REGISTRY) {
    const spec = SHIPPED[entry.name];
    if (spec === undefined) continue;
    const subject: ConformanceSubject = {
      name: entry.name,
      create: (binary) => entry.create({ binary }),
      ...spec,
    };
    describe(entry.name, () => {
      for (const clause of CONFORMANCE_CLAUSES) {
        it(clause, async () => {
          await checkConformanceClause(subject, clause);
        });
      }
    });
  }

  // The acceptance criterion in its own words: a config-defined harness runs a
  // real turn end to end, under exactly the contract the shipped CLIs hold.
  describe('a config-defined harness (the issue\'s "mytool" example)', () => {
    for (const clause of CONFORMANCE_CLAUSES) {
      it(clause, async () => {
        await checkConformanceClause(MYTOOL_SUBJECT, clause);
      });
    }
  });

  describe('a config-defined harness without readOnly flags', () => {
    const { readOnly: _dropped, ...rest } = MYTOOL_CONFIG;
    const withoutReadOnly: HarnessConfig = { ...rest };
    const subject: ConformanceSubject = {
      ...MYTOOL_SUBJECT,
      name: 'mytool-no-readonly',
      create: (binary) => new ConfigHarness('mytool', withoutReadOnly, { binary }),
      readOnly: { enforcedBy: 'harness' },
    };

    it('read_only is enforced by the harness refusing the turn', async () => {
      await checkConformanceClause(subject, 'read_only is enforced, and the test proves by whom');
    });

    it('still runs write turns end to end', async () => {
      const { session } = await runStart(subject, 'success', 'write');
      assert.equal(session.ok, true);
      assert.equal(session.text, subject.finalText);
    });
  });
});
