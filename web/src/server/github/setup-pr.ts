/**
 * The pull request that makes a repository ready for Relay: the files the
 * studio compiled for a workflow (`.relay/config.json`, the compiled graph,
 * the GitHub Actions workflow), and the `.gitignore` lines for what Relay
 * keeps on a machine, on one branch of Relay's own, against the default
 * branch.
 *
 * It is opened with the person's own token, so the commit and the pull
 * request are theirs, and it only ever writes that branch: nothing reaches
 * the default branch until they merge it. Opening it again rebuilds the
 * branch on top of the default branch as it is then, and keeps the same pull
 * request.
 */
import type { GitHubRepository, PullRequestState, SetupFile, SetupFileStatus, SetupPullRequestInput, SetupPullRequestResult } from '@/lib/github-types';
import { BRAND, slugify } from '@/lib/brand';
import { ApiError } from '../errors';
import type { GitHubAppConfig } from '../env';
import { ask, call, refusal, repoPath } from './client';
import { reachableRepository } from './repositories';

/**
 * What `relay init` adds to `.gitignore` (`RELAY_IGNORE_ENTRIES` in the CLI's
 * `src/cli/onboarding.ts`): state that belongs to a machine, not to the
 * project. A test reads the CLI's list and fails when the two differ.
 */
export const RELAY_IGNORE_ENTRIES = ['.relay/runs/', '.relay/onboarding.json', '.relay/unattended.json', '.relay/STOP', '.relay/*.lock', '.relay/approvals/'] as const;

const IGNORE_HEADING = '# Relay state that belongs to this machine, not to the project';

/** The only places the studio writes. Everything else in a repository is the person's. */
const ALLOWED_PATHS = [/^\.relay\/config\.json$/, /^\.relay\/rules\.md$/, /^\.relay\/workflows\/[a-z0-9][a-z0-9._-]{0,99}\.json$/, /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/];
const MAX_FILES = 8;
const MAX_FILE_BYTES = 256_000;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;

/** The files, checked: only Relay's paths, each once, none too large. */
export function checkSetupFiles(files: readonly SetupFile[]): SetupFile[] {
  if (files.length === 0) throw new ApiError(400, 'NO_FILES', 'There is nothing to put in the pull request.');
  if (files.length > MAX_FILES) throw new ApiError(400, 'TOO_MANY_FILES', `A setup pull request carries at most ${MAX_FILES} files.`);
  const seen = new Set<string>();
  for (const file of files) {
    if (!ALLOWED_PATHS.some((pattern) => pattern.test(file.path)) || file.path.split('/').some((part) => part === '..' || part === '.')) {
      throw new ApiError(400, 'PATH_NOT_ALLOWED', `${file.path} is not one of Relay’s files. The setup pull request only writes under .relay/ and .github/workflows/.`);
    }
    if (seen.has(file.path)) throw new ApiError(400, 'DUPLICATE_PATH', `${file.path} is in the list twice.`);
    seen.add(file.path);
    if (Buffer.byteLength(file.content, 'utf8') > MAX_FILE_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', `${file.path} is larger than ${Math.round(MAX_FILE_BYTES / 1000)} KB.`);
  }
  return [...files];
}

/**
 * `.gitignore` with Relay's lines added, or `null` when it already has them
 * all. The same block `relay init` writes, so running it afterwards adds
 * nothing.
 */
export function withRelayIgnored(current: string | null): string | null {
  const text = current ?? '';
  const present = new Set(text.split('\n').map((line) => line.trim()));
  const missing = RELAY_IGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return null;
  const block = `${IGNORE_HEADING}\n${missing.join('\n')}\n`;
  if (text.length === 0) return block;
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}`;
}

/** Relay's branch for a workflow's setup: one per workflow, so two workflows' pull requests do not overwrite each other. */
export function setupBranch(name: string): string {
  return `${BRAND.slug}/setup-${slugify(name).slice(0, 60)}`;
}

/** A branch name as a path under `git/ref/heads/`: slashes kept, everything else encoded. */
function refPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A file on the default branch as text: `null` when it is not there, and
 * `undefined` when it is but GitHub sent no content (over a megabyte).
 */
async function readFile(config: GitHubAppConfig, token: string, repository: string, path: string, branch: string): Promise<string | null | undefined> {
  const answer = await ask(config, token, 'GET', `${repoPath(repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
  if (answer.status === 404) return null;
  if (answer.status !== 200) throw refusal(answer, `read ${path}`);
  const data = answer.data as { type?: unknown; encoding?: unknown; content?: unknown } | null;
  // A directory, a symlink or a submodule where the file goes: not something to write over.
  if (data === null || Array.isArray(data) || data.type !== 'file') throw new ApiError(409, 'PATH_TAKEN', `${path} in ${repository} is not a file, so ${BRAND.name} will not write over it.`);
  if (data.encoding !== 'base64' || typeof data.content !== 'string') return undefined;
  return Buffer.from(data.content, 'base64').toString('utf8');
}

const DESCRIBE: Record<string, string> = {
  '.relay/config.json': 'what the engine reads: the label, who may start a run, the agents and how far a run delivers',
  '.gitignore': 'keeps what Relay stores on a machine (run logs, locks, approvals) out of git',
};

function describe(path: string): string {
  if (DESCRIBE[path] !== undefined) return DESCRIBE[path];
  if (path.startsWith('.relay/workflows/')) return 'the workflow, compiled for the engine';
  if (path.startsWith('.github/workflows/')) return 'runs it on this repository’s GitHub Actions';
  return 'a Relay file';
}

function pullRequestBody(input: { name: string; repository: string; defaultBranch: string; branch: string; files: Array<{ path: string; status: SetupFileStatus }>; secrets: string[]; label: string | null }): string {
  const lines = [
    `This adds ${BRAND.name} to ${input.repository}, set up for **${oneLine(input.name, 80)}** in the ${BRAND.name} studio.`,
    '',
    '| File | | What it is for |',
    '|---|---|---|',
    ...input.files.filter((file) => file.status !== 'unchanged').map((file) => `| \`${file.path}\` | ${file.status} | ${describe(file.path)} |`),
    '',
    '### Before it can run',
    '',
  ];
  let step = 1;
  if (input.secrets.length > 0) {
    lines.push(`${step}. Add ${input.secrets.length === 1 ? 'this repository secret' : 'these repository secrets'}: ${input.secrets.map((name) => `\`${name}\``).join(', ')}. The studio’s install steps have the commands; ${BRAND.name} never sees them.`);
    step += 1;
  }
  lines.push(`${step}. Merge this pull request into \`${input.defaultBranch}\`.`);
  step += 1;
  if (input.label !== null) lines.push(`${step}. Put the label \`${input.label}\` on an issue, and the run starts on this repository’s Actions.`);
  lines.push('', `The branch \`${input.branch}\` belongs to ${BRAND.name}: opening this pull request again from the studio rebuilds it on top of \`${input.defaultBranch}\`.`);
  return lines.join('\n');
}

/** Makes the start label, if it is missing. Best effort: an app that may not touch issues still opens the pull request. */
async function ensureLabel(config: GitHubAppConfig, token: string, repository: string, label: string): Promise<'created' | 'exists' | 'skipped'> {
  try {
    const answer = await ask(config, token, 'POST', `${repoPath(repository)}/labels`, { name: label, color: '6d28d9', description: `Starts a ${BRAND.name} run` });
    if (answer.status === 201) return 'created';
    if (answer.status === 422) return 'exists';
    return 'skipped';
  } catch {
    return 'skipped';
  }
}

export async function openSetupPullRequest(config: GitHubAppConfig, token: string, input: SetupPullRequestInput): Promise<SetupPullRequestResult> {
  const files = checkSetupFiles(input.files);
  const name = oneLine(input.name, 80) || 'workflow';
  const label = input.label === undefined || input.label.trim().length === 0 ? null : oneLine(input.label, 50);
  const secrets = [...new Set((input.secrets ?? []).filter((secret) => SECRET_NAME.test(secret)))];

  const repo: GitHubRepository = await reachableRepository(config, token, input.repository);
  const repository = repo.repository;
  if (repo.archived) throw new ApiError(409, 'ARCHIVED', `${repository} is archived, so nothing can be pushed to it. Unarchive it on GitHub first.`);
  if (!repo.canPush) throw new ApiError(403, 'NO_PUSH', `You cannot push to ${repository}, so ${BRAND.name} cannot open a pull request there as you. Ask someone who can, or fork it.`);
  const base = repo.defaultBranch;

  const head = await call<{ object?: { sha?: unknown } }>(config, token, 'GET', `${repoPath(repository)}/git/ref/heads/${refPath(base)}`, `find ${base}`);
  const baseSha = head.object?.sha;
  if (typeof baseSha !== 'string') throw new ApiError(409, 'EMPTY_REPOSITORY', `${repository} has no commits on ${base} yet. Push one, then try again.`);

  // What goes in the commit, against what the default branch has now.
  const writes: SetupFile[] = [];
  const statuses: Array<{ path: string; status: SetupFileStatus }> = [];
  for (const file of files) {
    const current = await readFile(config, token, repository, file.path, base);
    const status: SetupFileStatus = current === null ? 'added' : current === file.content ? 'unchanged' : 'changed';
    statuses.push({ path: file.path, status });
    if (status !== 'unchanged') writes.push(file);
  }
  const ignore = await readFile(config, token, repository, '.gitignore', base);
  // A .gitignore too large for GitHub to send is left as it is: appending to a file Relay cannot read would replace it.
  const ignored = ignore === undefined ? null : withRelayIgnored(ignore);
  if (ignored !== null) {
    writes.push({ path: '.gitignore', content: ignored });
    statuses.push({ path: '.gitignore', status: ignore === null ? 'added' : 'changed' });
  }

  if (writes.length === 0) return { state: 'up-to-date', defaultBranch: base, files: statuses };

  const baseCommit = await call<{ tree?: { sha?: unknown } }>(config, token, 'GET', `${repoPath(repository)}/git/commits/${baseSha}`, `read ${base}`);
  if (typeof baseCommit.tree?.sha !== 'string') throw new ApiError(502, 'GITHUB_ERROR', `GitHub did not say what ${base} holds. Try again in a minute.`);
  const tree = await call<{ sha: string }>(config, token, 'POST', `${repoPath(repository)}/git/trees`, 'write the files', {
    base_tree: baseCommit.tree.sha,
    tree: writes.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
  });

  const branch = setupBranch(name);
  const existing = await ask(config, token, 'GET', `${repoPath(repository)}/git/ref/heads/${refPath(branch)}`);
  if (existing.status !== 200 && existing.status !== 404) throw refusal(existing, `find the branch ${branch}`);
  const existingSha = existing.status === 200 ? (existing.data as { object?: { sha?: unknown } } | null)?.object?.sha : undefined;
  // Pressed again with nothing new: the branch already holds exactly these files on this base, so it is left alone.
  let current = false;
  if (typeof existingSha === 'string') {
    const tip = await ask(config, token, 'GET', `${repoPath(repository)}/git/commits/${existingSha}`);
    const tipData = tip.data as { tree?: { sha?: unknown }; parents?: Array<{ sha?: unknown }> } | null;
    current = tip.status === 200 && tipData?.tree?.sha === tree.sha && tipData.parents?.length === 1 && tipData.parents[0]?.sha === baseSha;
  }
  if (!current) {
    const commit = await call<{ sha: string }>(config, token, 'POST', `${repoPath(repository)}/git/commits`, 'commit the files', {
      message: `Set up ${BRAND.name}: ${name}\n\nAdded from the ${BRAND.name} studio: ${statuses
        .filter((file) => file.status !== 'unchanged')
        .map((file) => file.path)
        .join(', ')}.`,
      tree: tree.sha,
      parents: [baseSha],
    });
    if (existing.status === 404) {
      await call(config, token, 'POST', `${repoPath(repository)}/git/refs`, `create the branch ${branch}`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    } else {
      // Relay's own branch, rebuilt on the default branch as it is now.
      await call(config, token, 'PATCH', `${repoPath(repository)}/git/refs/heads/${refPath(branch)}`, `update the branch ${branch}`, { sha: commit.sha, force: true });
    }
  }

  const title = `Set up ${BRAND.name}: ${name}`;
  const body = pullRequestBody({ name, repository, defaultBranch: base, branch, files: statuses, secrets, label });
  const open = await call<Array<{ number?: unknown; html_url?: unknown }>>(config, token, 'GET', `${repoPath(repository)}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${branch}`)}&base=${encodeURIComponent(base)}`, 'look for an open pull request');
  const found = Array.isArray(open) ? open.find((entry) => typeof entry.number === 'number' && typeof entry.html_url === 'string') : undefined;
  let number: number;
  let url: string;
  let state: 'opened' | 'updated';
  if (found !== undefined) {
    number = found.number as number;
    url = found.html_url as string;
    state = 'updated';
    await call(config, token, 'PATCH', `${repoPath(repository)}/pulls/${number}`, 'update the pull request', { title, body });
  } else {
    const made = await call<{ number: number; html_url: string }>(config, token, 'POST', `${repoPath(repository)}/pulls`, 'open the pull request', { title, head: branch, base, body, maintainer_can_modify: true });
    number = made.number;
    url = made.html_url;
    state = 'opened';
  }

  const labelState = label === null ? 'none' : await ensureLabel(config, token, repository, label);
  return { state, number, url, branch, defaultBranch: base, files: statuses, label: labelState };
}

export async function pullRequestState(config: GitHubAppConfig, token: string, repository: string, number: number): Promise<PullRequestState> {
  const pull = await call<{ number?: unknown; html_url?: unknown; state?: unknown; merged?: unknown; merged_at?: unknown }>(config, token, 'GET', `${repoPath(repository)}/pulls/${number}`, `read pull request #${number}`);
  const merged = pull.merged === true || (typeof pull.merged_at === 'string' && pull.merged_at.length > 0);
  return { number, url: typeof pull.html_url === 'string' ? pull.html_url : '', state: merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open' };
}
