/**
 * `{{a.b.c}}` substitution, and the path lookup under it. The engine fills a
 * real run's messages with the same two functions (`./engine/expression`), so
 * a message reads the same in a test run and a real one.
 */
export { lookup, renderTemplate } from './engine/expression';

/** The variables the inspector offers, grouped by where they come from. */
export const VARIABLE_HINTS: Array<{ group: string; variables: Array<{ path: string; description: string }> }> = [
  {
    group: 'Issue',
    variables: [
      { path: 'issue.key', description: 'Ticket key, e.g. ENG-142' },
      { path: 'issue.title', description: 'Ticket title' },
      { path: 'issue.url', description: 'Link to the ticket' },
      { path: 'issue.assignee', description: 'Who it is assigned to' },
      { path: 'issue.labels', description: 'Labels, comma separated' },
      { path: 'issue.body', description: 'Ticket description' },
    ],
  },
  {
    group: 'Run',
    variables: [
      { path: 'run.id', description: 'Run id' },
      { path: 'run.status', description: 'succeeded, failed, refused…' },
      { path: 'run.branch', description: 'Branch the work landed on' },
      { path: 'run.prUrl', description: 'Pull request URL, once opened' },
      { path: 'run.cost', description: 'Reported cost, e.g. $2.14' },
      { path: 'run.tests', description: 'passed / failed / skipped' },
      { path: 'run.summary', description: 'The run summary Relay writes' },
      { path: 'run.codeReviewer', description: 'Which model reviewed the diff' },
      { path: 'run.diff', description: '+120 −34 across 6 files' },
    ],
  },
  {
    group: 'Workflow',
    variables: [
      { path: 'workflow.name', description: 'This workflow’s name' },
      { path: 'workflow.repository', description: 'owner/repo' },
      { path: 'product.name', description: 'The product name from settings' },
    ],
  },
];
