/**
 * One made-up ticket, used by every example on the public pages, so the hero,
 * the walkthrough and the sign-in panel tell the same story with the same
 * numbers. The label and the branch prefix are the product's real defaults.
 *
 * A module of its own, with no "use client": the server-rendered showcase
 * reads it too, and a value imported from a client module is not a value there.
 */
export const SAMPLE = {
  issue: '#142',
  title: 'Fix the flaky retry test',
  repository: 'acme/api',
  label: 'relay:go',
  branch: 'relay/142-fix-the-flaky-retry-test',
  pullRequest: '#143',
  cost: '$1.84',
} as const;
