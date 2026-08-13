/**
 * The fixture set, presented to the engine as an issue tracker.
 *
 * A run's first phase fetches an issue, and everything downstream is written
 * against `IssueProvider` rather than against GitHub — so an eval task can be
 * an issue without inventing a second entry point into the workflow. The
 * pipeline under measurement is byte-for-byte the one `relay run` drives.
 */
import type { Issue, IssueProvider } from '../github/types.ts';
import { fixtureIssueNumber } from './fixtures.ts';
import type { Fixture } from './types.ts';

export class FixtureIssueProvider implements IssueProvider {
  readonly name = 'fixture';

  private readonly issue: Issue;

  constructor(fixture: Fixture) {
    const number = fixtureIssueNumber(fixture.id);
    this.issue = {
      id: `fixture:${fixture.id}`,
      number,
      title: fixture.title,
      body: fixture.task.trim(),
      // Local, and deliberately not a URL anything could fetch: an agent that
      // followed a link out of an eval task would be reading a different task.
      url: `fixture://${fixture.id}`,
      state: 'open',
      author: null,
      labels: [fixture.kind],
      repository: null,
      comments: [],
    };
  }

  async getIssue(): Promise<Issue> {
    return structuredClone(this.issue);
  }

  async checkAvailability(): Promise<{ available: boolean; detail: string }> {
    return { available: true, detail: 'fixture' };
  }
}
