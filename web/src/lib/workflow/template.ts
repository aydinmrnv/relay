/**
 * `{{a.b.c}}` substitution. Arrays join with ", ", objects become JSON, and an
 * unknown path renders as an empty string rather than leaking the braces.
 */
export function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}/g, (_match, path: string) => {
    const value = lookup(context, path);
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map(String).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

export function lookup(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Every `{{path}}` a template mentions, for the inspector's variable hints. */
export function templateVariables(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}/g)].map((match) => match[1]!);
}

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
