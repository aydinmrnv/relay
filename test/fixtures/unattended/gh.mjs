#!/usr/bin/env node
/**
 * A `gh` that answers from a JSON file instead of from GitHub.
 *
 * Relay never talks to GitHub itself — it drives the user's own `gh`, which
 * owns the credentials. That indirection is what lets the whole unattended
 * pipeline be exercised end to end in CI with no token and no network: put this
 * on PATH as `gh` and the tracker becomes a file on disk.
 *
 * It implements only the subcommands Relay actually invokes, and it fails
 * loudly on anything else — a fixture that quietly succeeded on a command
 * nobody taught it would make the test prove less than it appears to.
 *
 * State lives in RELAY_FIXTURE_GH_STATE:
 *   { "issues": [ … ], "events": { "142": [ … ] }, "calls": [ … ] }
 */
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.RELAY_FIXTURE_GH_STATE;
if (statePath === undefined) {
  process.stderr.write('fixture gh: RELAY_FIXTURE_GH_STATE is not set\n');
  process.exit(97);
}

const argv = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, 'utf8'));
state.calls ??= [];
state.calls.push(argv);

const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

function save() {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function done(stdout = '') {
  save();
  if (stdout.length > 0) process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
  process.exit(0);
}

function fail(message, code = 1) {
  save();
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const issueBy = (number) => state.issues.find((issue) => String(issue.number) === String(number));

const [group, action, ...rest] = argv;

if (group === 'auth' && action === 'status') {
  done('Logged in to github.com account fixture-bot (keyring)');
}

if (group === 'issue' && action === 'list') {
  const label = flag('--label');
  const matching = state.issues.filter(
    (issue) => issue.state === 'open' && (label === undefined || issue.labels.includes(label)),
  );
  done(
    JSON.stringify(
      matching.map((issue) => ({
        number: issue.number,
        title: issue.title,
        labels: issue.labels.map((name) => ({ name })),
        createdAt: issue.createdAt ?? '2026-08-25T09:00:00Z',
        url: issue.url,
        author: { login: issue.author },
        state: issue.state,
      })),
    ),
  );
}

if (group === 'issue' && action === 'view') {
  const issue = issueBy(rest[0]);
  if (issue === undefined) fail(`could not resolve to an Issue with the number of ${rest[0]}`);
  done(
    JSON.stringify({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      state: issue.state,
      author: { login: issue.author },
      labels: issue.labels.map((name) => ({ name })),
      comments: issue.comments ?? [],
    }),
  );
}

if (group === 'issue' && action === 'edit') {
  const issue = issueBy(rest[0]);
  if (issue === undefined) fail(`could not resolve to an Issue with the number of ${rest[0]}`);
  const remove = flag('--remove-label');
  if (remove !== undefined) {
    if (!issue.labels.includes(remove)) fail(`'${remove}' was not found on this issue`);
    issue.labels = issue.labels.filter((name) => name !== remove);
  }
  done(issue.url);
}

if (group === 'issue' && action === 'comment') {
  const issue = issueBy(rest[0]);
  if (issue === undefined) fail(`could not resolve to an Issue with the number of ${rest[0]}`);
  issue.comments ??= [];
  issue.comments.push({
    author: { login: 'fixture-bot' },
    createdAt: '2026-08-25T12:30:00Z',
    body: readFileSync(0, 'utf8'),
  });
  done(`${issue.url}#issuecomment-1`);
}

if (group === 'api') {
  // `gh api <path> …` puts the path where a subcommand would be.
  const path = action ?? '';
  const events = /issues\/(\d+)\/events$/.exec(path);
  if (events !== null) done(JSON.stringify(state.events?.[events[1]] ?? []));
  // Team membership: nothing in the fixture belongs to a team, and a 404 is
  // exactly what GitHub answers for "not a member".
  if (/^orgs\//.test(path)) fail('gh: Not Found (HTTP 404)', 1);
  fail(`fixture gh: unsupported api path ${path}`, 97);
}

if (group === 'pr' && action === 'create') {
  const head = flag('--head');
  if (state.pullRequests?.some((pr) => pr.head === head)) {
    fail(`a pull request for branch "${head}" already exists: ${state.pullRequests.find((pr) => pr.head === head).url}`);
  }
  state.pullRequests ??= [];
  const number = 900 + state.pullRequests.length;
  const pr = {
    number,
    url: `https://github.com/acme/widgets/pull/${number}`,
    head,
    base: flag('--base'),
    title: flag('--title'),
    body: readFileSync(0, 'utf8'),
    draft: argv.includes('--draft'),
  };
  state.pullRequests.push(pr);
  done(pr.url);
}

fail(`fixture gh: unsupported command \`gh ${argv.join(' ')}\``, 97);
