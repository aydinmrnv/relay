import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { confirmClosedIssue, resolvePickedIssue } from '../src/cli/issuePicker.ts';
import type { IssueProvider, IssueSummary } from '../src/github/types.ts';
import { ScriptedPrompter } from './helpers/scriptedPrompter.ts';
import type { Issue } from '../src/github/types.ts';

const issue = (number: number): IssueSummary => ({ number, title: `Issue ${number}`, labels: ['ready'], createdAt: '2026-08-12T00:00:00Z', url: '', author: null, state: 'open' });
function provider(result: IssueSummary[] | null, calls: { count: number }): IssueProvider {
  return {
    name: 'test',
    async getIssue() { throw new Error('not used'); },
    async listIssues() { calls.count += 1; return result; },
    async checkAvailability() { return { available: true, detail: 'test' }; },
  };
}

describe('issue picker', () => {
  it('returns a single match without prompting', async () => {
    const calls = { count: 0 }; const prompt = new ScriptedPrompter([]);
    assert.equal(await resolvePickedIssue(provider([issue(4)], calls), {}, prompt), '4');
    assert.deepEqual(prompt.asked, []);
  });

  it('selects among multiple matches through PromptSession', async () => {
    const calls = { count: 0 }; const prompt = new ScriptedPrompter(['8']);
    assert.equal(await resolvePickedIssue(provider([issue(4), issue(8)], calls), {}, prompt), '8');
    assert.deepEqual(prompt.offered, [['4', '8']]);
  });

  it('asks for a number when listing is unsupported', async () => {
    const calls = { count: 0 }; const prompt = new ScriptedPrompter(['12']);
    assert.equal(await resolvePickedIssue(provider(null, calls), {}, prompt), '12');
    assert.match(prompt.asked[0]!, /cannot list/i);
  });

  it('never calls the provider when non-interactive', async () => {
    const calls = { count: 0 };
    assert.equal(await resolvePickedIssue(provider([issue(4)], calls), { mine: true }, new ScriptedPrompter([], false)), undefined);
    assert.equal(calls.count, 0);
  });
});

describe('closed issue confirmation', () => {
  const closed: Issue = { id: 'github:a/b#9', number: 9, title: 'Closed', body: '', url: '', state: 'closed', author: null, labels: [], repository: null, comments: [] };

  it('defaults to not starting, but --yes proceeds silently', async () => {
    const prompt = new ScriptedPrompter([]);
    assert.equal(await confirmClosedIssue(closed, false, prompt), false);
    assert.equal(prompt.asked.length, 1);
    const yes = new ScriptedPrompter([]);
    assert.equal(await confirmClosedIssue(closed, true, yes), true);
    assert.equal(yes.asked.length, 0);
  });

  it('requires --yes non-interactively', async () => {
    await assert.rejects(confirmClosedIssue(closed, false, new ScriptedPrompter([], false)), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'CLOSED_ISSUE_NOT_CONFIRMED');
  });
});
