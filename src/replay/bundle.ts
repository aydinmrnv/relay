import type { ExitCode } from '../cli/exit.ts';
import { exitCodeForRun } from '../cli/exit.ts';
import { runToJson, type RunJson } from '../cli/runJson.ts';
import type { RunStreamLine } from '../cli/runStream.ts';
import type { Landing } from '../git/commit.ts';
import type { ReviewRound } from '../reviews/types.ts';
import type { LoggedEvent } from '../storage/runs.ts';
import { RelayError } from '../util/errors.ts';
import { redact, SECRET_PATTERNS } from '../util/redact.ts';
import { isTerminal, phaseLabel } from '../workflow/phases.ts';
import type { RunState } from '../workflow/state.ts';
import { receiptsFor, type Receipt } from './receipts.ts';
import { rebuildStream } from './stream.ts';

/**
 * A finished run as one file: enough to play it back somewhere else.
 *
 * The studio plays a recording on its canvas the way it plays a live run — the
 * `stream` is the same lines `relay run --json` prints — and shows what the
 * run actually produced beside it: the plan, each review and its answers, the
 * patches, the test log, and the receipts.
 *
 * A recording is made to be shown to other people, so it is cleaned on the way
 * out. Paths on this machine become placeholders, anything shaped like a
 * credential is redacted, and what a notification was sent to is left out.
 * What it does not do is hide the work: the issue, the plan and the diff are
 * the point. Export a run only from a repository you would show.
 */

/** Bumped when a field is removed, renamed or changes meaning; adding one is not a bump. */
export const BUNDLE_VERSION = 1;

/** A patch larger than this is cut, and says so. A recording is for reading, not for `git apply`. */
export const MAX_PATCH_CHARS = 200_000;
export const MAX_TEST_LOG_CHARS = 60_000;

export interface RunBundlePatch {
  /** `implementation`, then `revision-round-1`, … in the order the run captured them. */
  label: string;
  patch: string;
  truncated: boolean;
}

export interface RunBundle {
  bundle: typeof BUNDLE_VERSION;
  exportedAt: string;
  relayVersion: string;
  /** What `relay run` exited with. */
  exitCode: ExitCode;
  /** The run as `relay status --json` reports it, without this machine's paths. */
  run: RunJson;
  /** The `relay run --json` stream, rebuilt from the run's event log with its recorded times. */
  stream: RunStreamLine[];
  artifacts: {
    issue: string | null;
    plan: string | null;
    /** The implementer's own account of what it did. */
    implementationNotes: string | null;
    reviews: ReviewRound[];
    patches: RunBundlePatch[];
    testLog: string | null;
  };
  receipts: Receipt[];
  /** What the export changed on the way out, so nobody has to guess. */
  cleaned: { secrets: number; paths: number; patchesOmitted: boolean };
}

export interface BundleInputs {
  state: RunState;
  events: readonly LoggedEvent[];
  landing: Landing;
  relayVersion: string;
  now?: Date;
  issue?: string;
  plan?: string;
  implementationNotes?: string;
  testLog?: string;
  patches: ReadonlyArray<{ label: string; patch: string }>;
  planRevised?: Readonly<Record<number, boolean>>;
  /** False leaves the patches out: the receipts still say what changed, without the code. */
  includePatches?: boolean;
  /** This machine's home directory, replaced with `~` wherever it appears. */
  home?: string;
}

export function buildRunBundle(inputs: BundleInputs): RunBundle {
  const { state } = inputs;
  if (!isTerminal(state.phase)) {
    throw new RelayError(`Run ${state.runId} is still running (${phaseLabel(state.phase)}).`, {
      code: 'RUN_NOT_FINISHED',
      hint: `A recording is of a finished run. Follow it with \`relay watch ${state.shortId}\`, or stop it with \`relay stop ${state.shortId}\`.`,
    });
  }

  // Receipts are read from the run as it was recorded, before anything is cleaned.
  const receipts = receiptsFor({ state, events: inputs.events, patches: inputs.patches, ...(inputs.planRevised === undefined ? {} : { planRevised: inputs.planRevised }) });
  const exitCode = exitCodeForRun(state, inputs.landing);
  // Where a notification went is this repository's business, not the recording's.
  const run: RunJson = { ...runToJson(state, { landing: inputs.landing }), notification: null };
  const stream = rebuildStream(state, inputs.events, run, exitCode);

  const counts = { secrets: 0, paths: 0 };
  const paths = pathScrubber(
    [
      [state.workspace?.path, '<worktree>'],
      [state.repository.root, '<repo>'],
      [inputs.home, '~'],
    ],
    counts,
  );
  // Prose is redacted in full. Code and logs lose only what is near-certainly a
  // credential: the looser shapes would rewrite `TOKEN=…` in a diff, and a diff
  // that no longer says what it changed is not worth showing.
  const prose = (text: string): string => paths(countingRedact(text, false, counts));
  const code = (text: string): string => paths(countingRedact(text, true, counts));

  const includePatches = inputs.includePatches !== false;
  const patches: RunBundlePatch[] = includePatches
    ? inputs.patches.map((entry) => {
        const truncated = entry.patch.length > MAX_PATCH_CHARS;
        return { label: entry.label, patch: code(truncated ? `${entry.patch.slice(0, MAX_PATCH_CHARS)}\n… cut at ${MAX_PATCH_CHARS.toLocaleString('en-US')} characters\n` : entry.patch), truncated };
      })
    : [];

  return {
    bundle: BUNDLE_VERSION,
    exportedAt: (inputs.now ?? new Date()).toISOString(),
    relayVersion: inputs.relayVersion,
    exitCode,
    run: mapStrings(run, prose),
    stream: mapStrings(stream, prose),
    artifacts: {
      issue: inputs.issue === undefined ? null : prose(inputs.issue),
      plan: inputs.plan === undefined ? null : prose(inputs.plan),
      implementationNotes: inputs.implementationNotes === undefined ? null : prose(inputs.implementationNotes),
      reviews: mapStrings(state.reviews, prose),
      patches,
      testLog: inputs.testLog === undefined ? null : code(tail(inputs.testLog, MAX_TEST_LOG_CHARS)),
    },
    receipts: mapStrings(receipts, prose),
    cleaned: { ...counts, patchesOmitted: !includePatches && inputs.patches.length > 0 },
  };
}

/** The end of a long log, which is where a suite says how it went. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `… ${(text.length - max).toLocaleString('en-US')} earlier characters cut\n${text.slice(-max)}`;
}

function countingRedact(text: string, highSignalOnly: boolean, counts: { secrets: number }): string {
  if (!highSignalOnly) {
    for (const { pattern } of SECRET_PATTERNS) counts.secrets += text.match(pattern)?.length ?? 0;
    return redact(text);
  }
  let out = text;
  for (const { pattern, replacement, highSignal } of SECRET_PATTERNS) {
    if (!highSignal) continue;
    counts.secrets += out.match(pattern)?.length ?? 0;
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Replaces this machine's directories with placeholders, longest first so a worktree inside the repository is named as one. */
function pathScrubber(pairs: ReadonlyArray<readonly [string | undefined, string]>, counts: { paths: number }): (text: string) => string {
  const known = pairs
    .filter((pair): pair is readonly [string, string] => pair[0] !== undefined && pair[0].length >= 4)
    .map(([from, to]) => [from.replace(/[\\/]+$/, ''), to] as const)
    .sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [from, to] of known) {
      if (!out.includes(from)) continue;
      const parts = out.split(from);
      counts.paths += parts.length - 1;
      out = parts.join(to);
    }
    return out;
  };
}

/** Applies `change` to every string inside a JSON-shaped value. */
function mapStrings<T>(value: T, change: (text: string) => string): T {
  if (typeof value === 'string') return change(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, change);
    return out as T;
  }
  return value;
}
