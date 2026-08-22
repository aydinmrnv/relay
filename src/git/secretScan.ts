import { open, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { SECRET_PATTERNS } from '../util/redact.ts';
import { git } from './repository.ts';

/**
 * The scan that runs between commit and push: nothing leaves this machine
 * unread. Delivery commits everything in the worktree, and a `.env` an agent
 * wrote while reproducing a bug, a key pasted into a fixture, or a token found
 * in a log would otherwise ride that commit to a remote — where, for a public
 * repository, a pushed secret is a leaked secret regardless of the follow-up.
 *
 * Three detectors, in order of confidence:
 *  - the high-signal patterns shared with `src/util/redact.ts` (vendor token
 *    prefixes, key blocks) — the same shapes that guard the event log;
 *  - filenames that should never be committed at all (`.env`, `id_rsa`,
 *    `*.pem`, credential JSON), reported without reading a byte;
 *  - an entropy heuristic for the keys that have no recognizable prefix.
 *
 * A finding names the rule, the file and the line — never the matched text.
 * The secret must not appear in the delivery record, the observer output or
 * `events.jsonl`; printing it there would be the leak the scan exists to stop.
 *
 * Overrides are explicit: `--allow-secret <path>` is the deliberate one-off,
 * `.relay/secretsignore` is the repeatable one. Suppressed findings are counted,
 * not erased.
 */

export interface SecretFinding {
  /** Path relative to the worktree root, as git reports it. */
  file: string;
  /** 1-based line of the match, or null when the filename itself is the finding. */
  line: number | null;
  /** The rule that matched — e.g. `github-token` — never the matched text. */
  rule: string;
}

export interface SecretScanResult {
  findings: SecretFinding[];
  /** Files whose names and contents were inspected. */
  scanned: number;
  /** Findings suppressed by `--allow-secret` or `.relay/secretsignore`. */
  suppressed: number;
}

export interface SecretScanOptions {
  /** The run's worktree. */
  worktree: string;
  /** The commit the run branched from; the scan covers everything since. */
  baseSha: string;
  /** Glob patterns from `.relay/secretsignore`. */
  ignore?: readonly string[];
  /** Paths (or globs) the user allowed through with `--allow-secret`. */
  allow?: readonly string[];
  signal?: AbortSignal;
}

/** Content larger than this is scanned only up to the cap. */
const MAX_CONTENT_BYTES = 1_000_000;

/**
 * Scans everything the run changed relative to its base — committed or not,
 * tracked or untracked — because `git add -A` at commit time takes all of it.
 */
export async function scanForSecrets(options: SecretScanOptions): Promise<SecretScanResult> {
  const signalOpt = options.signal ? { signal: options.signal } : {};

  // The same staging `snapshotDiff` does: after it, one cached diff against the
  // base names every file the run touched, including untracked ones. Deleted
  // files are excluded — there is nothing left to leak.
  await git(['add', '-A'], { cwd: options.worktree, ...signalOpt });
  const names = await git(['diff', '--cached', '--name-only', '--diff-filter=d', '-M', options.baseSha], {
    cwd: options.worktree,
    ...signalOpt,
  });
  const files = names.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

  const allow = (options.allow ?? []).map(normalizePattern);
  const ignore = (options.ignore ?? []).map(normalizePattern);

  const findings: SecretFinding[] = [];
  let suppressed = 0;
  const record = (finding: SecretFinding, entropyOnly: boolean): void => {
    if (matchesAny(finding.file, allow) || matchesAny(finding.file, ignore)) {
      suppressed += 1;
      return;
    }
    // Lockfiles and minified bundles are walls of high-entropy strings that no
    // one typed; only the heuristic detector skips them. A recognizable token
    // prefix in a lockfile is still a token and is still reported.
    if (entropyOnly && isEntropyExempt(finding.file)) return;
    findings.push(finding);
  };

  for (const file of files) {
    const filenameRule = neverCommitRule(file);
    if (filenameRule !== undefined) record({ file, line: null, rule: filenameRule }, false);

    const content = await readHead(join(options.worktree, file), MAX_CONTENT_BYTES);
    // A NUL byte marks a binary file; line-oriented pattern matching on it
    // would be noise. Its name was still checked above.
    if (content === undefined || content.includes('\u0000')) continue;

    for (const hit of scanContent(content)) {
      record({ file, line: hit.line, rule: hit.rule }, hit.rule === ENTROPY_RULE);
    }
  }

  return { findings, scanned: files.length, suppressed };
}

/** Reads `.relay/secretsignore`: one glob per line, `#` comments, blanks skipped. */
export async function readSecretsIgnore(repoRoot: string): Promise<string[]> {
  try {
    const contents = await readFile(join(repoRoot, '.relay', 'secretsignore'), 'utf8');
    return contents
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Content detectors
// ---------------------------------------------------------------------------

export const ENTROPY_RULE = 'high-entropy string';

export interface ContentHit {
  line: number;
  rule: string;
}

/**
 * Finds credential-shaped content. High-signal patterns only: in the event log
 * a false positive costs one redacted word, here it blocks a delivery.
 */
export function scanContent(content: string): ContentHit[] {
  const hits: ContentHit[] = [];
  const seen = new Set<string>();
  const add = (line: number, rule: string): void => {
    const key = `${line}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ line, rule });
  };

  const patternLines = new Set<number>();
  for (const { id, pattern, highSignal } of SECRET_PATTERNS) {
    if (!highSignal) continue;
    // A fresh regex per use: the shared ones are `/g` and carry lastIndex.
    const fresh = new RegExp(pattern.source, pattern.flags);
    for (const match of content.matchAll(fresh)) {
      const line = lineAt(content, match.index ?? 0);
      patternLines.add(line);
      add(line, id);
    }
  }

  // The heuristic corroborates nothing a pattern already named: one line, one
  // finding, reported under the most specific rule that saw it.
  for (const hit of entropyHits(content)) {
    if (!patternLines.has(hit.line)) add(hit.line, hit.rule);
  }

  return hits.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/**
 * The heuristic for keys with no recognizable prefix. Two tiers:
 *
 *  - 32+ characters at entropy ≥ 4.5 bits/char is flagged anywhere: prose and
 *    identifiers rarely exceed ~4.2, random base64 of that length sits ~4.7+.
 *  - 24+ characters at entropy ≥ 3.8 is flagged only on a line that also says
 *    `secret`, `token`, `key`, `password` or `credential` — the keyword is the
 *    corroboration a shorter string needs.
 *
 * Pure hex is excluded (git SHAs and content hashes saturate diffs), as are
 * strings sitting next to an `integrity`/`sha512-…` marker.
 */
function entropyHits(content: string): ContentHit[] {
  const hits: ContentHit[] = [];
  const lines = content.split('\n');
  const keyword = /secret|token|passwd|password|credential|api[_-]?key|private[_-]?key/i;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/integrity|sha256-|sha384-|sha512-/i.test(line)) continue;

    for (const match of line.matchAll(/[A-Za-z0-9+/=_-]{24,}/g)) {
      const candidate = match[0]!;
      if (!/[0-9]/.test(candidate) || !/[A-Za-z]/.test(candidate)) continue;
      if (/^[0-9a-fA-F]+$/.test(candidate)) continue;
      // Paths and URLs share the base64 alphabet; more than one separator in a
      // candidate means it is almost certainly one of those, not a key.
      if ((candidate.match(/\//g) ?? []).length > 1) continue;

      const entropy = shannonEntropy(candidate);
      const strong = candidate.length >= 32 && entropy >= 4.5;
      const corroborated = entropy >= 3.8 && keyword.test(line);
      if (strong || corroborated) {
        hits.push({ line: i + 1, rule: ENTROPY_RULE });
        break; // One finding per line: the location is the report, not the count.
      }
    }
  }
  return hits;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ---------------------------------------------------------------------------
// Filename detectors
// ---------------------------------------------------------------------------

const NEVER_COMMIT_BASENAMES = new Set([
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials.json',
  'service-account.json',
  'service_account.json',
  'client_secret.json',
  'application_default_credentials.json',
  '.netrc',
  '.htpasswd',
]);

/** `.env.example` and friends are templates, published on purpose. */
const ENV_TEMPLATE_SUFFIXES = ['example', 'sample', 'template', 'dist'];

const NEVER_COMMIT_EXTENSIONS = new Set(['.pem', '.p12', '.pfx']);

/** Why this filename should never be committed, or undefined when it may be. */
export function neverCommitRule(path: string): string | undefined {
  const name = basename(path);

  if (NEVER_COMMIT_BASENAMES.has(name)) return `never-commit filename (${name})`;

  if (name.startsWith('.env.')) {
    const suffix = name.slice('.env.'.length);
    if (!ENV_TEMPLATE_SUFFIXES.includes(suffix)) return `never-commit filename (${name})`;
  }

  const extension = extname(name).toLowerCase();
  if (NEVER_COMMIT_EXTENSIONS.has(extension)) return `never-commit filename (*${extension})`;

  return undefined;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/** Files the entropy heuristic ignores: machine-written walls of hashes. */
const ENTROPY_EXEMPT_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'Podfile.lock',
  'go.sum',
]);

const ENTROPY_EXEMPT_SUFFIXES = ['.min.js', '.min.css', '.map', '.svg'];

function isEntropyExempt(path: string): boolean {
  const name = basename(path);
  return ENTROPY_EXEMPT_BASENAMES.has(name) || ENTROPY_EXEMPT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Gitignore-lite matching, shared by `--allow-secret` and `.relay/secretsignore`:
 * `**` crosses directories, `*` and `?` do not, a pattern without a slash
 * matches the basename, a trailing slash matches everything under a directory.
 */
export function matchesIgnorePattern(pattern: string, path: string): boolean {
  const normalizedPath = normalizePattern(path);
  let normalized = normalizePattern(pattern);
  if (normalized.length === 0) return false;

  if (normalized.endsWith('/')) normalized += '**';

  const subject = normalized.includes('/') ? normalizedPath : basename(normalizedPath);
  return globToRegExp(normalized).test(subject);
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesIgnorePattern(pattern, path));
}

function normalizePattern(value: string): string {
  let out = value.replace(/\\/g, '/').trim();
  while (out.startsWith('./')) out = out.slice(2);
  if (out.startsWith('/')) out = out.slice(1);
  return out;
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
        // `**/` also matches zero directories: `**/x.pem` matches `x.pem`.
        if (glob[i + 1] === '/') i += 1;
        continue;
      }
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

/** 1-based line number of a character offset. */
function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Reads at most `limit` bytes, so a gigabyte artifact cannot stall delivery or
 * exhaust memory. A file that cannot be read is skipped: it will not commit
 * either, and the commit step owns that failure.
 */
async function readHead(path: string, limit: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}
