/**
 * The fixture set, presented to the engine as an issue tracker.
 *
 * A run's first phase fetches an issue, and everything downstream is written
 * against `IssueProvider` rather than against GitHub — so an eval task can be
 * an issue without inventing a second entry point into the workflow. The
 * pipeline under measurement is byte-for-byte the one `relay run` drives.
 */
import type { Issue, IssueProvider } from '../github/types.ts';
import type { Fixture } from './types.ts';

export class FixtureIssueProvider implements IssueProvider {
  readonly name = 'fixture';

  private readonly issue: Issue;

  constructor(fixture: Fixture) {
    this.issue = {
      id: `fixture:${fixture.id}`,
      // A fixture has no tracker behind it and therefore no number. Naming
      // comes from the title, exactly as it does for a spec file or a
      // `--prompt`, so a branch reads `relay/version-comparison-…-x7f2q3`
      // rather than carrying an issue number nothing could be looked up by.
      number: null,
      title: fixture.title,
      body: fixture.task.trim(),
      // No URL: `renderIssueMarkdown` omits the line rather than printing an
      // empty one, and an agent that followed a link out of an eval task would
      // be reading a different task.
      url: '',
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

  async listIssues(): Promise<null> { return null; }

  async checkAvailability(): Promise<{ available: boolean; detail: string }> {
    return { available: true, detail: 'fixture' };
  }
}
