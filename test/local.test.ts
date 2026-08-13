import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

import { WorkflowEngine } from '../src/workflow/engine.ts';
import { branchNameFor, worktreePathFor } from '../src/git/worktree.ts';
import { renderIssueMarkdown } from '../src/github/types.ts';
import { issueHeadline, issueIdentity, issueTitle } from '../src/issues/identity.ts';
import {
  LocalIssueProvider,
  TASK_TEMPLATE,
  composeTaskInEditor,
  looksLikePath,
  parseTask,
  readTaskFile,
  taskFromPrompt,
  taskToIssue,
} from '../src/issues/local.ts';
import { ISSUE_PROVIDER_REGISTRY, ISSUE_TRACKER_REGISTRY } from '../src/issues/registry.ts';
import { resolveIssueSource } from '../src/cli/commands/run.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { RelayError } from '../src/util/errors.ts';
import { issueLinkFor } from '../src/workflow/delivery.ts';
import { pullRequestDraft } from '../src/workflow/publishRun.ts';
import { createRunState, type RunState } from '../src/workflow/state.ts';
import { buildEngineContext, happyPathHarnesses } from './helpers/engine.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;

beforeEach(async () => {
  repo = await createTempRepo({ withPackageJson: true });
  process.env['RELAY_HOME'] = repo.relayHome;
});

afterEach(async () => {
  delete process.env['RELAY_HOME'];
  await repo.cleanup();
});

describe('a task written as markdown', () => {
  it('takes the first heading as the title and everything else as the body', () => {
    const task = parseTask('# Fix the flaky timeout\n\nThe retry test fails on CI about once in ten.\n', {
      origin: './spec.md',
    });

    assert.equal(task.title, 'Fix the flaky timeout');
    assert.equal(task.body, 'The retry test fails on CI about once in ten.');
    assert.equal(task.number, undefined);
  });

  it('lets front matter override both, and reads labels and a number from it', () => {
    const task = parseTask(
      ['---', 'title: Rate-limit logins', 'issue: 142', 'labels: bug, security', '---', '', '# Ignored', '', 'Body.'].join('\n'),
      { origin: './spec.md' },
    );

    assert.equal(task.title, 'Rate-limit logins');
    assert.equal(task.number, 142);
    assert.deepEqual(task.labels, ['bug', 'security']);
    assert.equal(task.body, 'Body.');
  });

  it('reads a #123 out of the filename when the author put one there', async () => {
    await repo.writeFile('spec-#123.md', '# Fix the retry\n\nDetails.\n');
    const task = await readTaskFile('spec-#123.md', repo.root);

    assert.equal(task.number, 123);
    assert.equal(task.title, 'Fix the retry');
  });

  it('drops HTML comments, so the editor template can explain itself', () => {
    const task = parseTask(`${TASK_TEMPLATE}# Real title\n\nReal body.\n`, { origin: '--editor' });

    assert.equal(task.title, 'Real title');
    assert.equal(task.body, 'Real body.');
    assert.doesNotMatch(task.body, /Describe the work for Relay/);
  });

  it('falls back to the first line when there is no heading at all', () => {
    const task = parseTask('Logins should be rate limited per IP.\n\nMore detail.\n', { origin: './spec.md' });

    assert.equal(task.title, 'Logins should be rate limited per IP.');
    // The line stays in the body: a title lifted out of a two-line note would
    // leave the run with half a description.
    assert.match(task.body, /^Logins should be rate limited per IP\./);
  });

  it('treats a file that is only a heading as a one-line task, not an empty one', () => {
    const task = parseTask('# Fix the flaky timeout\n', { origin: './spec.md' });
    assert.equal(task.body, 'Fix the flaky timeout');
  });

  it('refuses a file with nothing in it', () => {
    assert.throws(
      () => parseTask('<!-- only a comment -->\n\n   \n', { origin: './spec.md' }),
      (error: unknown) => error instanceof RelayError && error.code === 'EMPTY_TASK',
    );
  });

  it('names both readings when there is no such issue and no such file', async () => {
    await assert.rejects(
      () => readTaskFile('./nope.md', repo.root),
      (error: unknown) =>
        error instanceof RelayError && error.code === 'TASK_NOT_FOUND' && /issue number/.test(error.hint ?? ''),
    );
  });
});

describe('a task written as a prompt', () => {
  it('derives a title and keeps the prompt as the whole description', () => {
    const task = taskFromPrompt('Fix the flaky timeout in the retry test');

    assert.equal(task.title, 'Fix the flaky timeout in the retry test');
    assert.equal(task.body, 'Fix the flaky timeout in the retry test');
    assert.equal(task.origin, '--prompt');
  });

  it('clips a title from a prompt long enough to be a paragraph', () => {
    const task = taskFromPrompt(`${'word '.repeat(40)}\n\nand more`);
    assert.ok(task.title.length <= 72, task.title);
    assert.ok(task.body.length > task.title.length);
  });

  it('refuses an empty prompt', () => {
    assert.throws(() => taskFromPrompt('   '), RelayError);
  });
});

describe('a task written in $EDITOR', () => {
  it('opens the template and reads back whatever was saved', async () => {
    const opened: string[] = [];
    const task = await composeTaskInEditor({
      cwd: repo.root,
      editor: 'fake-editor --wait',
      launch: async (command, args) => {
        opened.push([command, ...args.slice(0, -1)].join(' '));
        await writeFile(args[args.length - 1]!, '# Written in an editor\n\nWith a real body.\n', 'utf8');
        return { ok: true };
      },
    });

    assert.deepEqual(opened, ['fake-editor --wait'], 'the editor keeps the arguments it was configured with');
    assert.equal(task?.title, 'Written in an editor');
    assert.equal(task?.origin, '--editor');
  });

  it('treats an empty buffer as "changed my mind", the way git commit does', async () => {
    const task = await composeTaskInEditor({
      cwd: repo.root,
      editor: 'fake-editor',
      launch: async (_command, args) => {
        await writeFile(args[args.length - 1]!, '', 'utf8');
        return { ok: true };
      },
    });

    assert.equal(task, undefined);
  });

  it('starts nothing when the editor exits badly', async () => {
    await assert.rejects(
      () =>
        composeTaskInEditor({
          cwd: repo.root,
          editor: 'fake-editor',
          launch: async () => ({ ok: false }),
        }),
      (error: unknown) => error instanceof RelayError && error.code === 'EDITOR_FAILED',
    );
  });
});

describe('identity without a number', () => {
  it('names a numbered issue exactly as it always has', () => {
    const issue = { number: 142, title: 'Add rate limiting' };

    assert.equal(issueIdentity(issue), 142);
    assert.equal(branchNameFor(issueIdentity(issue), 'x7f2q3'), 'relay/142-x7f2q3');
    assert.equal(issueHeadline(issue), '#142 Add rate limiting');
    assert.equal(issueTitle(issue), 'Add rate limiting (#142)');
  });

  it('names a task without one after its title', () => {
    const issue = { number: null, title: 'Fix the flaky timeout' };

    assert.equal(issueIdentity(issue), 'fix-the-flaky-timeout');
    assert.equal(branchNameFor(issueIdentity(issue), 'x7f2q3'), 'relay/fix-the-flaky-timeout-x7f2q3');
    // No `#null` reaches a terminal, a commit subject or a pull request title.
    assert.equal(issueHeadline(issue), 'Fix the flaky timeout');
    assert.equal(issueTitle(issue), 'Fix the flaky timeout');
  });

  it('survives a title that is punctuation, unicode and slashes', () => {
    const branch = branchNameFor(issueIdentity({ number: null, title: '  ¡Fix™ the/retry… test!  ' }), 'x7f2q3');

    assert.match(branch, /^relay\/[a-z0-9._-]+$/, branch);
    assert.ok(!branch.includes('..'), branch);
    assert.ok(!/[-.]-/.test(branch.slice('relay/'.length)), branch);
  });

  it('falls back rather than producing a nameless branch', () => {
    assert.equal(branchNameFor(issueIdentity({ number: null, title: '###' }), 'x7f2q3'), 'relay/issue-x7f2q3');
  });

  it('is collision-safe: the run\'s short id is what separates two runs', () => {
    const issue = { number: null, title: 'Fix the flaky timeout' };
    const first = branchNameFor(issueIdentity(issue), 'x7f2q3');
    const second = branchNameFor(issueIdentity(issue), 'k4m8p2');

    assert.notEqual(first, second);
    const repoInfo = { owner: 'acme', name: 'widgets', root: '/repo' };
    assert.notEqual(
      worktreePathFor(repoInfo, issueIdentity(issue), 'x7f2q3'),
      worktreePathFor(repoInfo, issueIdentity(issue), 'k4m8p2'),
    );
  });
});

describe('the local provider', () => {
  it('needs nothing installed and nothing signed into', async () => {
    const provider = new LocalIssueProvider({ cwd: repo.root });
    const availability = await provider.checkAvailability();

    assert.equal(availability.available, true);
    assert.equal(provider.name, 'local');
  });

  it('is in the registry, and is not a tracker', () => {
    assert.ok(ISSUE_PROVIDER_REGISTRY.some((entry) => entry.name === 'local'));
    assert.ok(!ISSUE_TRACKER_REGISTRY.some((entry) => entry.name === 'local'));
    // Nothing about it can be asked "are you installed?" — that is the point.
    assert.deepEqual(
      ISSUE_TRACKER_REGISTRY.map((entry) => entry.name),
      ['github'],
    );
  });

  it('reads a file as an issue, relative to where relay was run', async () => {
    await repo.writeFile('spec.md', '# Fix the flaky timeout\n\nIt fails on CI.\n');
    const issue = await new LocalIssueProvider({ cwd: repo.root }).getIssue('./spec.md');

    assert.equal(issue.title, 'Fix the flaky timeout');
    assert.equal(issue.number, null);
    assert.equal(issue.state, 'open');
    assert.match(issue.id, /^local:/);
    assert.match(issue.url, /^file:\/\/.*spec\.md$/);
  });

  it('hands back a task it was given, without touching the disk', async () => {
    const task = taskFromPrompt('Fix the flaky timeout');
    const issue = await new LocalIssueProvider({ cwd: repo.root, task }).getIssue('ignored');

    assert.equal(issue.title, 'Fix the flaky timeout');
    assert.equal(issue.url, '', 'a prompt has no file and so no URL to invent');
  });

  it('renders an issue.md with no number and no empty URL line', () => {
    const markdown = renderIssueMarkdown(taskToIssue(taskFromPrompt('Fix the flaky timeout\n\nDetails.')));

    assert.match(markdown, /^# Fix the flaky timeout/);
    assert.doesNotMatch(markdown, /#null/);
    assert.doesNotMatch(markdown, /- URL:/);
    assert.match(markdown, /## Description/);
  });
});

describe('what `relay run` decides to work from', () => {
  it('reads a tracker reference as a tracker reference', async () => {
    for (const ref of ['142', '#142', 'acme/widgets#142', 'https://github.com/acme/widgets/issues/142']) {
      assert.deepEqual(await resolveIssueSource(ref, {}, repo.root), { kind: 'tracker', ref });
    }
  });

  it('prefers the issue over a file that happens to share its name', async () => {
    await repo.writeFile('142', '# Not this\n\nBody.\n');
    assert.deepEqual(await resolveIssueSource('142', {}, repo.root), { kind: 'tracker', ref: '142' });
  });

  it('reads anything else as a path', async () => {
    await repo.writeFile('spec.md', '# From a file\n\nBody.\n');
    const source = await resolveIssueSource('./spec.md', {}, repo.root);

    assert.equal(source?.kind, 'local');
    assert.equal(source?.kind === 'local' ? source.task.title : undefined, 'From a file');
    assert.equal(source?.kind === 'local' ? source.task.origin : undefined, './spec.md');
  });

  it('takes a prompt', async () => {
    const source = await resolveIssueSource(undefined, { prompt: 'Fix the flaky timeout' }, repo.root);
    assert.equal(source?.kind === 'local' ? source.task.origin : undefined, '--prompt');
  });

  it('says plainly that --editor needs a terminal, rather than failing inside one', async () => {
    await assert.rejects(
      () => resolveIssueSource(undefined, { editor: true }, repo.root),
      (error: unknown) => error instanceof RelayError && error.code === 'NOT_A_TTY',
    );
  });

  it('refuses to guess when given nothing, or more than one thing', async () => {
    await assert.rejects(
      () => resolveIssueSource(undefined, {}, repo.root),
      (error: unknown) => error instanceof RelayError && error.code === 'NO_ISSUE_REF',
    );
    await assert.rejects(
      () => resolveIssueSource('142', { prompt: 'x' }, repo.root),
      (error: unknown) => error instanceof RelayError && error.code === 'BAD_FLAG',
    );
  });

  it('knows a path when it sees one', () => {
    assert.equal(looksLikePath('./spec.md'), true);
    assert.equal(looksLikePath('docs/plan.md'), true);
    assert.equal(looksLikePath('spec.md'), true);
    assert.equal(looksLikePath('142'), false);
    assert.equal(looksLikePath('acme/widgets#142'), true, 'a slug is tried as a path only after the parser refuses it');
  });
});

describe('delivering work that has no ticket', () => {
  /** A finished run whose issue came from a file rather than a tracker. */
  function localRun(): RunState {
    const state = createRunState({
      runId: '20260812T203625-bg6pcf',
      shortId: 'bg6pcf',
      issueRef: './spec.md',
      task: { title: 'Fix the flaky timeout', body: 'It fails on CI.', origin: './spec.md' },
      repository: { root: '/repo', owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      config: structuredClone(DEFAULT_CONFIG),
      now: new Date('2026-08-12T10:00:00Z'),
    });
    state.issue = {
      id: 'local:fix-the-flaky-timeout',
      number: null,
      title: 'Fix the flaky timeout',
      url: '',
      state: 'open',
    };
    state.workspace = {
      path: '/worktree',
      branch: 'relay/fix-the-flaky-timeout-bg6pcf',
      baseSha: 'b'.repeat(40),
      baseRef: 'refs/heads/main',
      baseBranch: 'main',
    };
    state.diff = { fileCount: 1, additions: 4, deletions: 1, files: [], patchFile: 'p', at: 'x' };
    state.planApproved = true;
    return state;
  }

  it('opens a pull request with no Closes line and no (#null) in the title', () => {
    const draft = pullRequestDraft(localRun());

    assert.equal(draft.title, 'Fix the flaky timeout');
    assert.equal(draft.head, 'relay/fix-the-flaky-timeout-bg6pcf');
    assert.equal(draft.base, 'main');
    assert.doesNotMatch(draft.body, /Closes/);
    assert.doesNotMatch(draft.body, /#null|undefined/);
  });

  it('records the missing issue link as a skip with a reason, not a failure', () => {
    const state = localRun();
    state.pullRequest = { url: 'https://x/pull/9', number: 9, base: 'main', head: 'b', createdByRun: true, at: 'x' };

    const link = issueLinkFor(state);
    assert.equal(link?.status, 'skipped');
    assert.match(link?.detail ?? '', /\.\/spec\.md has no tracker issue to close/);
  });

  it('still records the link when there is an issue to close', () => {
    const state = localRun();
    state.issue = { ...state.issue!, number: 142 };
    state.pullRequest = { url: 'https://x/pull/9', number: 9, base: 'main', head: 'b', createdByRun: true, at: 'x' };

    assert.deepEqual(issueLinkFor(state), { status: 'done', detail: 'closes #142' });
    assert.match(pullRequestDraft(state).body, /Closes #142/);
  });

  it('has nothing to say before a pull request exists', () => {
    assert.equal(issueLinkFor(localRun()), undefined);
  });
});

describe('a whole run from a file', () => {
  it('produces a real issue.md, a branch named after the title, and a complete run', async () => {
    await repo.writeFile('spec.md', '# Fix the flaky timeout\n\nThe retry test fails on CI about once in ten.\n');
    await repo.commit('add spec');

    const task = await readTaskFile('spec.md', repo.root);
    const { context, store, state } = buildEngineContext(repo, happyPathHarnesses());
    state.issueRef = 'spec.md';
    state.task = task;
    state.shortId = 'x7f2q3';
    context.issueProvider = new LocalIssueProvider({ cwd: repo.root, task });

    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.issue?.number, null);
    assert.equal(final.issue?.id, 'local:fix-the-flaky-timeout');
    assert.equal(final.workspace?.branch, 'relay/fix-the-flaky-timeout-x7f2q3');

    const issueMarkdown = await store.readArtifact('issue.md');
    assert.match(issueMarkdown ?? '', /# Fix the flaky timeout/);
    assert.match(issueMarkdown ?? '', /fails on CI about once in ten/);

    // The run's own record says what it was about, without inventing a number.
    const summary = await store.readArtifact('summary.md');
    assert.match(summary ?? '', /\*\*Fix the flaky timeout\*\*/);
    assert.doesNotMatch(summary ?? '', /#null/);

    // …and the work is really on that branch.
    assert.match(await repo.git('log', '-1', '--format=%s', final.workspace!.branch), /Fix the flaky timeout/);
  });

  it('carries the task so a resume needs neither the file nor a tracker', async () => {
    const task = taskFromPrompt('Fix the flaky timeout in the retry test');
    const { context, state } = buildEngineContext(repo, happyPathHarnesses());
    state.issueRef = '--prompt';
    state.task = task;
    context.issueProvider = new LocalIssueProvider({ cwd: repo.root, task });

    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.deepEqual(
      JSON.parse(JSON.stringify(final.task)),
      { title: 'Fix the flaky timeout in the retry test', body: 'Fix the flaky timeout in the retry test', origin: '--prompt' },
      'the prompt survives the process that created it',
    );
  });
});

// The other half of the promise: none of the above changed anything for a
// numbered GitHub issue, which is what every existing run on disk is.
describe('numbered issues are untouched', () => {
  it('still names its branch and worktree after the number', () => {
    assert.equal(branchNameFor(142, 'test01'), 'relay/142-test01');
    assert.match(worktreePathFor({ owner: 'acme', name: 'widgets', root: '/r' }, 142, 'test01'), /issue-142-test01$/);
  });

  it('still runs end to end and still closes its issue', async () => {
    const { context, store } = buildEngineContext(repo, happyPathHarnesses());
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.issue?.number, 142);
    assert.match(final.workspace?.branch ?? '', /^relay\/142-/);
    assert.match((await store.readArtifact('issue.md')) ?? '', /# Issue #142:/);
  });
});
