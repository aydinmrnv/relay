import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_REGISTRY } from '../src/agents/index.ts';
import { installHint, seatedAgentChecks, seatedAgents, type AgentCheck } from '../src/cli/checks.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';

function agents(installed: readonly string[]): AgentCheck[] {
  return AGENT_REGISTRY.map((entry) => ({
    entry,
    check: installed.includes(entry.name)
      ? { label: entry.label, status: 'ok' as const, detail: '1.0.0' }
      : { label: entry.label, status: 'fail' as const, detail: 'not found', hint: `install ${entry.name}` },
  }));
}

describe('doctor — which agents a run needs', () => {
  it('fails on a missing CLI that a role is seated on', () => {
    const rows = seatedAgentChecks(agents(['claude']), seatedAgents(DEFAULT_CONFIG));
    const codex = rows.find((row) => row.label === 'Codex');
    assert.equal(codex?.status, 'fail');
  });

  // Relay runs on one CLI as readily as on two, so a config that seats every
  // role on Claude Code must not be told it cannot run without Codex.
  it('only warns about a missing CLI that no role is seated on', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents = { planner: 'claude', planReviewer: 'claude', implementer: 'claude', codeReviewer: 'claude' };

    const rows = seatedAgentChecks(agents(['claude']), seatedAgents(config));
    const codex = rows.find((row) => row.label === 'Codex');
    assert.equal(codex?.status, 'warn');
    assert.match(codex?.hint ?? '', /install codex/);
    assert.match(codex?.hint ?? '', /no role in \.relay\/config\.json is seated on it/);
    assert.ok(rows.every((row) => row.status !== 'fail'));
  });

  it('judges every registered CLI when there is no config to ask', () => {
    const rows = seatedAgentChecks(agents(['claude']), undefined);
    assert.equal(rows.find((row) => row.label === 'Codex')?.status, 'fail');
  });
});

describe('doctor — what to run when a tool is missing', () => {
  it('names the install command for the platform it is running on', () => {
    assert.match(installHint('git', 'win32'), /winget install Git\.Git/);
    assert.match(installHint('git', 'darwin'), /xcode-select --install/);
    assert.match(installHint('gh', 'darwin'), /brew install gh/);
    assert.match(installHint('gh', 'win32'), /winget install GitHub\.cli/);
  });

  it('falls back to where the tool is published on a platform it has no command for', () => {
    assert.match(installHint('gh', 'freebsd'), /https:\/\/cli\.github\.com/);
  });

  it('still says something for a tool it knows nothing about', () => {
    assert.equal(installHint('mytool', 'linux'), 'Install mytool and make sure it is on your PATH.');
  });
});
