import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runInteractive } from '../process/interactive.ts';
import { RelayError } from '../util/errors.ts';
import { oneLine, slugify } from '../util/text.ts';
import type { Issue, IssueProvider } from '../github/types.ts';

/**
 * A task that came from this machine rather than a tracker.
 *
 * The pipeline never needed a tracker — it needed a title, a body and maybe some
 * comments. This is that, from a markdown file, a `--prompt`, or `$EDITOR`. It
 * is persisted with the run so a resume works from what the run *started* with,
 * even if the file it came from has since been edited or deleted.
 */
export interface LocalTask {
  title: string;
  body: string;
  /** Where it came from, for the record: a path, `--prompt`, or `--editor`. */
  origin: string;
  /** A `#123` from the filename or front matter, when the author put one there. */
  number?: number;
  labels?: string[];
  /** Absolute path of the file it was read from, when it came from one. */
  path?: string;
}

/** Anything larger is a repository, not a task, and would blow out every prompt. */
const MAX_TASK_BYTES = 512 * 1024;

/** How long a derived title is allowed to be before it stops being a title. */
const TITLE_LENGTH = 72;

/**
 * Reads a task written as markdown.
 *
 * The rules are the ones a person would guess: the first heading is the title,
 * everything else is the body, and front matter — if there is any — wins over
 * both. HTML comments are dropped, which is what makes the `--editor` template
 * able to explain itself without ending up in the prompt.
 */
export function parseTask(
  text: string,
  options: { origin: string; path?: string; fallbackTitle?: string },
): LocalTask {
  const stripped = stripComments(text);
  if (stripped.trim().length === 0) {
    throw new RelayError(`${options.origin} describes no work.`, {
      code: 'EMPTY_TASK',
      hint: 'A task needs a description. The first markdown heading is used as its title.',
    });
  }

  const { frontMatter, rest: raw } = splitFrontMatter(stripped);
  // An empty heading carries nothing, and the `--editor` template leaves one
  // behind whenever somebody writes their title on a line of their own.
  const rest = raw.replace(/^[ \t]{0,3}#{1,6}[ \t]*(\r?\n|$)/gm, '');

  const heading = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(rest);
  const body = heading === null ? rest : `${rest.slice(0, heading.index)}${rest.slice(heading.index + heading[0].length)}`;

  // Front matter is explicit, a heading is structural, and the first line is a
  // guess — in that order, because only the last of the three can be wrong.
  const title =
    frontMatter['title'] ??
    heading?.[1]?.trim() ??
    firstLine(rest) ??
    options.fallbackTitle ??
    titleFromFilename(options.path) ??
    'Untitled task';

  const number = issueNumberIn(frontMatter, options.path);
  const labels = frontMatter['labels'];

  return {
    title: oneLine(title, TITLE_LENGTH),
    // A file that is nothing but a heading is a one-line task, not an empty
    // one: the title is the whole description, and saying so beats refusing it.
    body: body.trim().length > 0 ? body.trim() : title.trim(),
    origin: options.origin,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(number === undefined ? {} : { number }),
    ...(labels === undefined ? {} : { labels: splitList(labels) }),
  };
}

/** `relay run ./spec.md` — the file is the issue. */
export async function readTaskFile(path: string, cwd: string = process.cwd()): Promise<LocalTask> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);

  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw new RelayError(`${path} is not a file.`, { code: 'BAD_TASK_FILE' });
    }
    size = info.size;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError(`There is no issue and no file at ${path}.`, {
      code: 'TASK_NOT_FOUND',
      hint: 'Pass an issue number (142), a path to a markdown file, or `--prompt "…"`.',
      cause: error,
    });
  }

  if (size > MAX_TASK_BYTES) {
    throw new RelayError(`${path} is ${Math.round(size / 1024)}KB, which is too large to be a task description.`, {
      code: 'TASK_TOO_LARGE',
      hint: `Relay reads up to ${MAX_TASK_BYTES / 1024}KB. Point it at the spec, not the repository.`,
    });
  }

  return parseTask(await readFile(absolute, 'utf8'), {
    origin: path,
    path: absolute,
  });
}

/** `relay run --prompt "Fix the flaky timeout"` — the prompt is the issue. */
export function taskFromPrompt(prompt: string): LocalTask {
  if (prompt.trim().length === 0) {
    throw new RelayError('--prompt was empty, so there is nothing to work on.', { code: 'EMPTY_TASK' });
  }
  // The prompt is the whole body, not just what is left after the title is taken
  // out of it: a one-line prompt would otherwise become a run with no
  // description at all.
  return {
    title: oneLine(firstLine(prompt) ?? prompt, TITLE_LENGTH),
    body: prompt.trim(),
    origin: '--prompt',
  };
}

/** What `$EDITOR` opens on. HTML comments so the guidance is not the title. */
export const TASK_TEMPLATE = `<!--
Describe the work for Relay, in markdown.

  The first heading is the title. Everything below it is the description,
  and it is what every agent in the run reads first.

Lines inside HTML comments like this one are ignored. Save an empty file
to abort — nothing is started.
-->

#

`;

export interface ComposeOptions {
  cwd: string;
  /** Overrides `$VISUAL` / `$EDITOR`. */
  editor?: string;
  /** Hands the terminal to the editor. Injected so this is testable without one. */
  launch?: (command: string, args: readonly string[], options: { cwd?: string }) => Promise<{ ok: boolean }>;
}

/**
 * `relay run --editor` — writes the task in the editor the user already lives
 * in, the way `git commit` does.
 *
 * The best way to write a good task description is in a real editor, and the
 * one worth opening is the one they already configured. An empty buffer aborts,
 * which is the convention every one of these flows already follows.
 */
export async function composeTaskInEditor(options: ComposeOptions): Promise<LocalTask | undefined> {
  const [command, ...args] = resolveEditor(options.editor);
  if (command === undefined) {
    throw new RelayError('No editor is configured, so `--editor` has nothing to open.', {
      code: 'NO_EDITOR',
      hint: 'Set $EDITOR (for example `export EDITOR=vim`), or use `relay run --prompt "…"`.',
    });
  }

  const directory = await mkdtemp(join(tmpdir(), 'relay-task-'));
  const path = join(directory, 'RELAY_TASK.md');

  try {
    await writeFile(path, TASK_TEMPLATE, 'utf8');
    const launch = options.launch ?? runInteractive;
    const result = await launch(command, [...args, path], { cwd: options.cwd });
    if (!result.ok) {
      throw new RelayError(`\`${command}\` exited without saving, so nothing was started.`, { code: 'EDITOR_FAILED' });
    }

    const text = await readFile(path, 'utf8');
    // An empty buffer is how every editor-driven flow says "cancel".
    if (stripComments(text).trim().length === 0) return undefined;

    return parseTask(text, { origin: '--editor' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface LocalIssueProviderOptions {
  /** Directory a relative path is resolved against. */
  cwd: string;
  /**
   * The task, when the command already resolved one. A `--prompt` or an
   * `--editor` buffer has no path to re-read, so the run carries the task
   * itself and this hands it straight back.
   */
  task?: LocalTask;
}

/**
 * The issue provider with no binary, no auth and nothing to sign into.
 *
 * Everything downstream of `getIssue` — the plan, the review, the diff, the
 * tests, the pull request — is indifferent to where an issue came from, so this
 * is the whole of what "work that has no ticket" needs.
 */
export class LocalIssueProvider implements IssueProvider {
  readonly name = 'local';

  private readonly cwd: string;
  private readonly task: LocalTask | undefined;

  constructor(options: LocalIssueProviderOptions) {
    this.cwd = options.cwd;
    this.task = options.task;
  }

  async getIssue(ref: string): Promise<Issue> {
    return taskToIssue(this.task ?? (await readTaskFile(ref, this.cwd)));
  }

  async listIssues(): Promise<null> { return null; }

  async checkAvailability(): Promise<{ available: boolean; detail: string }> {
    return { available: true, detail: 'always available — no install, no sign-in' };
  }
}

/** Projects a local task onto the same `Issue` every other provider produces. */
export function taskToIssue(task: LocalTask): Issue {
  return {
    id: `local:${task.number ?? slugify(task.title, 'task')}`,
    number: task.number ?? null,
    title: task.title,
    body: task.body,
    url: task.path === undefined ? '' : pathToFileURL(task.path).href,
    state: 'open',
    author: null,
    labels: task.labels ?? [],
    repository: null,
    comments: [],
  };
}

/**
 * Whether a reference names a file rather than a tracker issue. Deliberately
 * loose: anything that is not a tracker reference is tried as a path, and the
 * error for a missing file names both readings.
 */
export function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.(md|markdown|txt)$/i.test(value.trim());
}

function resolveEditor(override?: string): string[] {
  const configured =
    override ??
    process.env['VISUAL'] ??
    process.env['EDITOR'] ??
    (process.platform === 'win32' ? 'notepad' : 'vi');
  // `EDITOR="code -w"` is common enough to be worth honouring. Nothing is run
  // through a shell, so an editor path containing spaces is not supported —
  // which is the same trade `git` makes for `core.editor` without a shell.
  return configured.trim().split(/\s+/).filter((part) => part.length > 0);
}

/** Drops `<!-- … -->` blocks, so the template can explain itself. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** Reads `---`-delimited `key: value` front matter, and nothing more clever. */
function splitFrontMatter(text: string): { frontMatter: Record<string, string>; rest: string } {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (match?.[1] === undefined) return { frontMatter: {}, rest: text };

  const frontMatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line.trim());
    if (pair?.[1] === undefined) continue;
    const value = (pair[2] ?? '').trim().replace(/^["'](.*)["']$/, '$1');
    if (value.length > 0) frontMatter[pair[1].toLowerCase()] = value;
  }

  return { frontMatter, rest: text.slice(match[0].length) };
}

/** `#123` from front matter or the filename — the author's own cross-reference. */
function issueNumberIn(frontMatter: Record<string, string>, path?: string): number | undefined {
  const declared = frontMatter['number'] ?? frontMatter['issue'];
  const fromFilename = path === undefined ? undefined : /#(\d+)/.exec(basename(path))?.[1];
  const raw = declared ?? fromFilename;
  if (raw === undefined) return undefined;

  const parsed = Number.parseInt(raw.replace(/^#/, ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function splitList(value: string): string[] {
  return value
    .replace(/^\[(.*)\]$/, '$1')
    .split(',')
    .map((part) => part.trim().replace(/^["'](.*)["']$/, '$1'))
    .filter((part) => part.length > 0);
}

function firstLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function titleFromFilename(path?: string): string | undefined {
  if (path === undefined) return undefined;
  const name = basename(path)
    .replace(/\.[^.]+$/, '')
    .replace(/#\d+/g, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return name.length > 0 ? name : undefined;
}
