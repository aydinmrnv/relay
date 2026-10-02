import type { BuiltinRecording } from './types';

/**
 * The recordings that ship with the studio, served from `public/recordings`.
 *
 * Each is a real run of Relay on its own repository, exported with
 * `relay recording` and not edited afterwards: the pull request it names is
 * the one that run opened. They are files rather than database rows so the
 * replay works on a deployment with no database at all.
 */
export const BUILTIN_RECORDINGS: readonly BuiltinRecording[] = [
  {
    slug: 'open-the-product',
    title: '`relay` on its own should open the product, not print a help dump',
    blurb: 'The plan was still contested when its two review rounds ran out, the code was approved in its second round, and the suite passed.',
    repository: 'aydinmrnv/relay',
    pullRequest: 43,
    outcome: 'passed',
    minutes: 17,
    costUsd: 6.26,
  },
  {
    slug: 'shell-completions',
    title: 'Shell completions and a man page',
    blurb: 'The code review ended in approval, and then Relay’s own run of the test suite failed. The run reports the exit code, not the approval.',
    repository: 'aydinmrnv/relay',
    pullRequest: 61,
    outcome: 'checks-failed',
    minutes: 18,
    costUsd: 5.44,
  },
  {
    slug: 'project-conventions',
    // The issue's own title, apostrophe and all.
    title: "Teach the agents this project's conventions instead of assuming a generic repo",
    blurb: 'A run that failed: the code reviewer never returned a verdict Relay could read, so the diff went unreviewed, and the receipts say so.',
    repository: 'aydinmrnv/relay',
    pullRequest: 49,
    outcome: 'failed',
    minutes: 17,
    costUsd: 7.12,
  },
];

export function builtinRecording(slug: string): BuiltinRecording | undefined {
  return BUILTIN_RECORDINGS.find((recording) => recording.slug === slug);
}

/** Where a built-in recording's file is served from. */
export function builtinRecordingUrl(slug: string): string {
  return `/recordings/${slug}.json`;
}
