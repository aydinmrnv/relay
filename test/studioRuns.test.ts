import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunStreamRecord } from '../src/studio/protocol.ts';
import { StudioRuns, type RelayLauncher } from '../src/studio/runs.ts';

/**
 * A run long enough to lose its middle (S-26). `relay run --json` is played by
 * a script that prints as many notes as it is told to between the first line
 * and the summary.
 */

const LONG_RUN = `
const line = (value) => process.stdout.write(JSON.stringify({ schema: 1, command: 'run', ...value }) + '\\n');
line({ type: 'run_started', at: '2026-01-01T00:00:00.000Z', runId: 'r-long' });
const notes = Number(process.env.FAKE_NOTES ?? '0');
for (let index = 0; index < notes; index += 1) line({ type: 'note', at: '2026-01-01T00:00:01.000Z', message: 'note ' + index });
line({ type: 'summary', at: '2026-01-01T00:00:02.000Z', exitCode: 0, run: { runId: 'r-long', pullRequest: { url: 'https://github.com/acme/api/pull/7' } } });
`;

const CONFIG = { version: 1, agents: { planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' }, workflow: { review: 'standard', deliver: 'pr' } };

async function setup(notes: number, keep: { first: number; latest: number }): Promise<{ dir: string; runs: StudioRuns; done: () => Promise<void> }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'relay-studio-runs-')));
  const script = join(dir, 'long-run.mjs');
  await writeFile(script, LONG_RUN);
  const launcher: RelayLauncher = { command: process.execPath, args: [script] };
  process.env['FAKE_NOTES'] = String(notes);
  const runs = new StudioRuns(dir, launcher, () => undefined, { keep });
  return {
    dir,
    runs,
    done: async () => {
      delete process.env['FAKE_NOTES'];
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function follow(runs: StudioRuns, id: string, since = 0): Promise<RunStreamRecord[]> {
  return new Promise((resolve, reject) => {
    const records: RunStreamRecord[] = [];
    const unsubscribe = runs.subscribe(
      id,
      (record) => {
        records.push(record);
        if (record.type === 'exit') resolve(records);
      },
      since,
    );
    if (unsubscribe === undefined) reject(new Error('no such run'));
  });
}

const kind = (record: RunStreamRecord | undefined): unknown => (record?.type === 'engine' ? record.data['type'] : record?.type);

describe('a run longer than the companion holds', () => {
  it('numbers every record once, in order, for whoever follows it live', async () => {
    const { runs, done } = await setup(100, { first: 5, latest: 10 });
    try {
      const view = await runs.start({ workflow: { id: 'w', name: 'W' }, config: CONFIG, task: { kind: 'prompt', text: 'long' } });
      const live = await follow(runs, view.id);
      // run_started, 100 notes, summary, exit.
      assert.equal(live.length, 103);
      assert.deepEqual(live.map((record) => record.seq), live.map((_, index) => index), 'every record has its own number, with none repeated');
      assert.equal(kind(live.at(-2)), 'summary');
      assert.deepEqual(live.at(-1), { seq: 102, type: 'exit', code: 0, error: null });
    } finally {
      await done();
    }
  });

  it('replays the start, says what it no longer holds, and ends with the summary and the exit', async () => {
    const { runs, done } = await setup(100, { first: 5, latest: 10 });
    try {
      const view = await runs.start({ workflow: { id: 'w', name: 'W' }, config: CONFIG, task: { kind: 'prompt', text: 'long' } });
      await follow(runs, view.id);

      const replay = await follow(runs, view.id);
      assert.ok(replay.length < 103, 'the middle is gone');
      assert.ok(replay.length <= 5 + 1 + 20, 'and what is held is bounded');
      assert.equal(kind(replay[0]), 'run_started');
      assert.equal(replay[0]?.seq, 0);
      const seqs = replay.map((record) => record.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'numbers only go up');
      assert.equal(new Set(seqs).size, seqs.length, 'and none repeats');

      // The summary is what tells the studio the run succeeded and where its pull request is.
      const summary = replay.at(-2);
      assert.equal(kind(summary), 'summary');
      assert.equal(summary?.seq, 101);
      assert.equal((summary as unknown as { data: { run: { pullRequest: { url: string } } } }).data.run.pullRequest.url, 'https://github.com/acme/api/pull/7');
      assert.deepEqual(replay.at(-1), { seq: 102, type: 'exit', code: 0, error: null });

      const gap = replay[5] as { seq: number; type: 'engine'; data: { type: string; message: string } };
      assert.equal(gap.data.type, 'note');
      assert.match(gap.data.message, /^\d+ earlier lines of this run are no longer held/);
      const firstKept = replay[6]!.seq;
      assert.equal(gap.seq, firstKept - 1, 'numbered as the last record that is gone');
      assert.equal(Number(gap.data.message.split(' ')[0]), firstKept - 5, 'and it counts them');
    } finally {
      await done();
    }
  });

  it('picks a stream back up from where a follower left off, without the gap it had already passed', async () => {
    const { runs, done } = await setup(100, { first: 5, latest: 10 });
    try {
      const view = await runs.start({ workflow: { id: 'w', name: 'W' }, config: CONFIG, task: { kind: 'prompt', text: 'long' } });
      await follow(runs, view.id);

      const tail = await follow(runs, view.id, 100);
      assert.deepEqual(tail.map((record) => [record.seq, kind(record)]), [[100, 'note'], [101, 'summary'], [102, 'exit']]);

      // Asked from past the end, the stream still ends: on the exit record, once.
      const past = await follow(runs, view.id, 500);
      assert.deepEqual(past, [{ seq: 102, type: 'exit', code: 0, error: null }]);
    } finally {
      await done();
    }
  });

  it('holds a run of ordinary length whole', async () => {
    const { runs, done } = await setup(3, { first: 5, latest: 10 });
    try {
      const view = await runs.start({ workflow: { id: 'w', name: 'W' }, config: CONFIG, task: { kind: 'prompt', text: 'short' } });
      const live = await follow(runs, view.id);
      const replay = await follow(runs, view.id);
      assert.deepEqual(replay, live);
      assert.deepEqual(replay.map(kind), ['run_started', 'note', 'note', 'note', 'summary', 'exit']);
    } finally {
      await done();
    }
  });
});
