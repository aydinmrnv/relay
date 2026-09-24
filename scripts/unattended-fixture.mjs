#!/usr/bin/env node
/**
 * Builds — and afterwards checks — the fixture repository the GitHub Action is
 * exercised against in Relay's own CI.
 *
 * The acceptance criterion for the unattended work is that the Action "runs a
 * full pipeline in CI on a fixture repository", and a pipeline that stops
 * before delivery would not be one. So this makes a repository where every
 * phase can really happen: a git remote to push to, a `gh` that answers from a
 * file, a test suite that really runs, and a coding CLI that plugs in through
 * the config-harness seam. Nothing in Relay is stubbed; everything *around* it
 * is, which is the same boundary the product itself draws.
 *
 *   node scripts/unattended-fixture.mjs build  <dir>
 *   node scripts/unattended-fixture.mjs verify <dir>
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const fixtures = join(repoRoot, 'test', 'fixtures', 'unattended');

const [mode, target] = process.argv.slice(2);
if (mode === undefined || target === undefined) {
  process.stderr.write('usage: unattended-fixture.mjs <build|verify> <dir>\n');
  process.exit(2);
}
const dir = resolve(target);

const paths = {
  work: join(dir, 'work'),
  remote: join(dir, 'remote.git'),
  bin: join(dir, 'bin'),
  ghState: join(dir, 'gh-state.json'),
  agentLog: join(dir, 'agent-turns.jsonl'),
};

if (mode === 'build') build();
else if (mode === 'verify') verify();
else {
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}

function git(args, cwd = paths.work) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Relay Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@relay.invalid',
      GIT_COMMITTER_NAME: 'Relay Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@relay.invalid',
    },
  }).trim();
}

function build() {
  for (const path of [paths.work, paths.remote, paths.bin]) mkdirSync(path, { recursive: true });

  git(['init', '-q', '--bare', '-b', 'main'], paths.remote);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Relay Fixture']);
  git(['config', 'user.email', 'fixture@relay.invalid']);

  write('package.json', `${JSON.stringify({
    name: 'relay-unattended-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2)}\n`);
  write('README.md', '# Fixture\n\nA repository that exists to be worked on by a machine.\n');
  // Run state and the claim ledger are this machine's, not the project's —
  // the same line Relay's own .gitignore draws.
  write('.gitignore', ['.relay/runs/', '.relay/unattended.json', '.relay/*.lock', '.relay/STOP', ''].join('\n'));

  // Relay reads the remote's URL to learn which GitHub repository this is, so
  // the fetch URL has to be a real-looking GitHub one. `pushurl` is what sends
  // the actual push to a bare repository next door: it changes where `git push`
  // goes without changing what `git remote get-url` reports, so nothing in
  // Relay knows the difference and the push is a real push to a real repo.
  git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  git(['config', 'remote.origin.pushurl', paths.remote]);

  write('.relay/config.json', `${JSON.stringify({
    version: 1,
    // The config-harness seam: one scripted CLI in every seat, so the pipeline
    // is real and the model is not. `readOnly` is declared, so Relay will let it
    // hold the review seats — and really does pass the flag on those turns.
    harnesses: {
      scripted: {
        command: 'node',
        args: [join(fixtures, 'agent.mjs')],
        promptOn: 'stdin',
        stream: 'jsonl',
        map: { text: '$.message', sessionId: '$.session_id', usage: '$.usage' },
        // A reviewer that read ahead continues that same session on its own
        // turn, so the harness has to declare how. The fixture CLI ignores the
        // id; what matters is that the seam is exercised end to end.
        resume: ['--resume', '{sessionId}'],
        readOnly: ['--read-only'],
      },
    },
    agents: { planner: 'scripted', planReviewer: 'scripted', implementer: 'scripted', codeReviewer: 'scripted' },
    workflow: {
      triggerLabel: 'relay:go',
      // Two slots, so the refused issue is genuinely *considered* and refused
      // rather than merely never reached — the allowlist is what is under test.
      maxConcurrentRuns: 2,
      // The whole pipeline: a planner turn, an adversarial plan review, an
      // implementation, a code review. `deliver: merge` is deliberate — the
      // unattended ceiling has to be seen overriding it.
      review: 'standard',
      deliver: 'merge',
      runTests: true,
    },
    unattended: {
      enabled: true,
      authors: ['maintainer'],
      maxRunCostUsd: 5,
      maxDailyCostUsd: 20,
      pollSeconds: 5,
      deliver: 'pr',
    },
    timeouts: { planningMs: 120000, reviewMs: 120000, implementationMs: 120000, testsMs: 120000 },
  }, null, 2)}\n`);

  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial commit']);
  git(['push', '-q', 'origin', 'main']);

  // The tracker: two issues carrying the trigger label, applied by two
  // different people — one on the allowlist and one not. A run must happen for
  // the first and must not for the second.
  writeFileSync(
    paths.ghState,
    `${JSON.stringify(
      {
        issues: [
          {
            number: 142,
            title: 'Add a greeting helper',
            body: 'We need a `greet(name)` that returns `Hello, <name>!`, with a test.',
            url: 'https://github.com/acme/widgets/issues/142',
            state: 'open',
            author: 'reporter',
            labels: ['relay:go'],
            comments: [],
          },
          {
            number: 143,
            title: 'Something a stranger wants',
            body: 'Please do this.',
            url: 'https://github.com/acme/widgets/issues/143',
            state: 'open',
            author: 'stranger',
            labels: ['relay:go'],
            comments: [],
          },
        ],
        events: {
          142: [{ event: 'labeled', label: { name: 'relay:go' }, actor: { login: 'maintainer' } }],
          143: [{ event: 'labeled', label: { name: 'relay:go' }, actor: { login: 'stranger' } }],
        },
        calls: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // `gh` on PATH, answering from that file.
  const shim = join(paths.bin, 'gh');
  writeFileSync(shim, `#!/bin/sh\nexec node "${join(fixtures, 'gh.mjs')}" "$@"\n`, 'utf8');
  chmodSync(shim, 0o755);

  process.stdout.write(
    [
      `fixture built in ${dir}`,
      `  repository   ${paths.work}`,
      `  remote       ${paths.remote}`,
      `  gh shim      ${paths.bin}`,
      `  tracker      ${paths.ghState}`,
    ].join('\n') + '\n',
  );
}

/**
 * What the run has to have actually done. Every assertion here is one of the
 * issue's acceptance criteria, checked against artifacts rather than logs:
 * a branch that exists on the remote, a pull request the fixture `gh` really
 * created, a label that really came off, and a merge that really did not happen.
 */
function verify() {
  const state = JSON.parse(readFileSync(paths.ghState, 'utf8'));
  const failures = [];
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  const allowed = state.issues.find((issue) => issue.number === 142);
  const refused = state.issues.find((issue) => issue.number === 143);

  // Whether the label came off #142 is read from the calls Relay made, not from
  // the labels #142 carries now: CI puts the label back after the run, to prove
  // a second pass starts nothing, so by now the labels only say who touched
  // them last. The call log says what Relay did and in what order — and the
  // removal has to come before the run delivered anything.
  const flagOf = (call, name) => (call.includes(name) ? call[call.indexOf(name) + 1] : undefined);
  const unlabelledAt = state.calls.findIndex(
    (call) => call[0] === 'issue' && call[1] === 'edit' && call[2] === '142' && flagOf(call, '--remove-label') === 'relay:go',
  );
  const pullRequestAt = state.calls.findIndex((call) => call[0] === 'pr' && call[1] === 'create');
  check(
    unlabelledAt !== -1 && (pullRequestAt === -1 || unlabelledAt < pullRequestAt),
    'the trigger label was not removed from #142 before the run started',
  );
  check(refused.labels.includes('relay:go'), 'the trigger label was taken off #143, which nobody was allowed to trigger');

  const pulls = state.pullRequests ?? [];
  check(pulls.length === 1, `expected exactly one pull request, got ${pulls.length}`);
  const pull = pulls[0];
  if (pull !== undefined) {
    check(pull.draft === true, 'the pull request was not opened as a draft');
    check(pull.base === 'main', `the pull request targets ${pull.base}, not main`);
    check(/^relay\//.test(pull.head ?? ''), `the pull request head is ${pull.head}, not a run branch`);
    check(/Closes #142/.test(pull.body ?? ''), 'the pull request does not close the issue it was started from');
  }

  check(
    !state.calls.some((call) => call[0] === 'pr' && call[1] === 'merge'),
    'something asked gh to merge — an unattended run must never merge',
  );
  check(
    (allowed.comments ?? []).length > 0,
    'the run posted no summary on the issue, so nobody watching the tracker would know it happened',
  );
  check(
    !state.calls.some((call) => call[0] === 'issue' && call[1] === 'edit' && call.includes('143')),
    'the refused issue was edited',
  );

  // The branch reached the remote, with the work on it.
  const branches = git(['branch', '--format=%(refname:short)'], paths.remote).split('\n').filter(Boolean);
  check(
    branches.some((branch) => branch.startsWith('relay/')),
    `no run branch was pushed — the remote has ${branches.join(', ') || 'nothing'}`,
  );
  const runBranch = branches.find((branch) => branch.startsWith('relay/'));
  if (runBranch !== undefined) {
    const files = git(['ls-tree', '-r', '--name-only', runBranch], paths.remote).split('\n');
    check(files.includes('src/greet.js'), 'the pushed branch does not carry the implementation');
    check(files.includes('test/greet.test.js'), 'the pushed branch does not carry the test');
  }
  const mainSha = git(['rev-parse', 'main'], paths.remote);
  const mainFiles = git(['ls-tree', '-r', '--name-only', 'main'], paths.remote).split('\n');
  check(!mainFiles.includes('src/greet.js'), `main moved (${mainSha}) — an unattended run must never merge`);

  // What Relay itself recorded about the run, which is the only account of it
  // that outlives the job log.
  const runs = readRuns();
  check(runs.length === 1, `expected exactly one run on disk, got ${runs.length}`);
  const run = runs[0];
  if (run !== undefined) {
    check(run.phase === 'COMPLETE', `the run ended ${run.phase}, not COMPLETE`);
    check(run.tests?.passed === true, 'the test suite did not pass, so the pipeline did not run its full length');
    check(run.trigger?.actor === 'maintainer', 'the run does not record who labelled the issue');
    check(run.trigger?.label === 'relay:go', 'the run does not record the label that started it');
    check(run.config.workflow.deliver === 'pr', `the run was given deliver: ${run.config.workflow.deliver}, not the pr ceiling`);
    check(run.merge == null, 'the run recorded a merge');
    const merge = run.delivery?.steps.find((step) => step.step === 'merge');
    check(merge?.status === 'skipped', `the merge step is ${merge?.status ?? 'missing'}, not skipped`);
    check(run.delivery?.reached === 'pr', `delivery reached ${run.delivery?.reached}, not pr`);
    for (const step of ['commit', 'push', 'pullRequest']) {
      const record = run.delivery?.steps.find((entry) => entry.step === step);
      check(record?.status === 'done', `delivery step ${step} is ${record?.status ?? 'missing'}, not done`);
    }
    // The `.relay/config.json` in the fixture asks for `merge`. The whole point
    // of the ceiling is that asking is not enough.
    check(
      JSON.parse(readFileSync(join(paths.work, '.relay', 'config.json'), 'utf8')).workflow.deliver === 'merge',
      'the fixture no longer asks for a merge, so the ceiling is not being tested',
    );
  }

  // The reviewers really did run read-only, and every phase really happened.
  if (existsSync(paths.agentLog)) {
    const turns = readFileSync(paths.agentLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    check(turns.some((turn) => turn.turn === 'plan'), 'no planning turn ran');
    check(turns.some((turn) => turn.turn === 'implement' && !turn.readOnly), 'no implementation turn ran');
    check(
      turns.filter((turn) => turn.turn === 'review').every((turn) => turn.readOnly),
      'a review turn ran with write access',
    );
  }

  if (failures.length > 0) {
    process.stderr.write(`${failures.map((line) => `  ✗ ${line}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('the unattended pipeline did what it promised\n');
}

/** Every run Relay recorded in the fixture repository. */
function readRuns() {
  const dir = join(paths.work, '.relay', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((entry) => join(dir, entry, 'state.json'))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')));
}

function write(relativePath, contents) {
  const path = join(paths.work, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}
