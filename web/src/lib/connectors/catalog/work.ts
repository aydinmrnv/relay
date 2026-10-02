// Where work is asked for, and where its result is recorded: issue trackers, code hosts and design handoff.
//
// Tracker actions act on the ticket the run is about, whatever step they are
// wired after, so "move to In Review" can follow Delivery directly.
//
// A trigger here hands the pipeline a ticket. An action here closes the loop in
// the place the work was asked for: the ticket moves, the pull request is linked,
// the person who asked can see why a run did or did not start. Opening, merging
// and branching are not actions here on purpose: Delivery does those, behind the
// guardrails, and an app node that could merge would walk around them.
import { defineConnector, FIELDS, PORTS, taskSample, type Connector } from '../types';

const BOT = '@relay-bot';
const COMMENT_FIELDS = [FIELDS.template('body', 'Comment', '{{run.summary}}')];
const NEW_ISSUE_FIELDS = [FIELDS.template('title', 'Title', '{{issue.title}}'), FIELDS.template('body', 'Description', '{{issue.body}}\n\nReported at {{issue.url}}')];
const LABEL = (def: string) => [FIELDS.text('label', 'Label', def)];
const IN_REVIEW = (def = 'In Review') => [FIELDS.text('state', 'State', def)];
const LINK_PR_HELP = 'Shows the pull request on the ticket, so nobody has to ask where the fix is.';

const ticketBody = 'Clicking Export twice on Safari 18 throws "TypeError: undefined is not an object (evaluating \'blob.size\')" and the download never starts.\n\nSteps: open any report, press Export, press it again before the first finishes.\nExpected: one CSV download. Actual: nothing, and the button stays disabled.';
const ticket = (id: string, url: string, extra: Record<string, unknown> = {}) =>
  taskSample(id, 'Export button does nothing on the second click in Safari', url, ticketBody, { assignee: 'relay-bot', author: 'you', labels: ['bug'], priority: 'high', ...extra });
const change = (number: number, url: string, extra: Record<string, unknown> = {}) => ({ number, title: 'Fix double-submit on the export button', branch: 'relay/eng-142-export-safari', url, author: 'relay-bot', ...extra });

export const WORK_CONNECTORS: Connector[] = [
  defineConnector({
    id: 'github-issues',
    name: 'GitHub Issues',
    category: 'issues',
    description: 'Issues in a GitHub repository. The one tracker an exported workflow can listen to today, because the Action fires on the issue event itself.',
    auth: 'app',
    icon: { si: 'SiGithub', color: '#181717' },
    docsUrl: 'https://docs.github.com/rest/issues',
    tags: ['issues', 'labels', 'open source'],
    popular: true,
    uses: [
      'A maintainer adds a label and the issue comes back as a draft pull request.',
      'A refused run explains itself on the issue, where the person who asked will look.',
    ],
    triggers: [
      { id: 'issue-labelled', name: 'Label added', description: 'Someone adds the trigger label to an issue. The usual way to say “this one is for the agents”.', outputs: PORTS.issueOut, fields: LABEL('agent:go'), sample: ticket('acme/api#1287', 'https://github.com/acme/api/issues/1287', { labels: ['bug', 'agent:go'] }) },
      { id: 'issue-assigned', name: 'Assigned to the bot', description: 'An issue is assigned to the bot account.', outputs: PORTS.issueOut, fields: [FIELDS.text('assignee', 'Assigned to', BOT)], sample: ticket('acme/api#1287', 'https://github.com/acme/api/issues/1287') },
      { id: 'issue-comment', name: 'Asked in a comment', description: 'A comment mentions the bot, as in “@relay-bot take this one”. The comment is added to the task.', outputs: PORTS.issueOut, fields: [FIELDS.text('mention', 'Mention', BOT)], sample: ticket('acme/api#1287', 'https://github.com/acme/api/issues/1287', { comment: '@relay-bot take this one, the repro is in the description' }) },
      { id: 'issue-opened', name: 'Issue opened', description: 'A new issue is opened. Pair it with a triage step rather than running the pipeline on everything.', outputs: PORTS.issueOut, fields: [FIELDS.text('label', 'Only with label', '')], sample: ticket('acme/api#1288', 'https://github.com/acme/api/issues/1288', { assignee: '' }) },
    ],
    actions: [
      { id: 'comment', name: 'Comment', description: 'Comment on the issue, for example why a run did not start.', inputs: PORTS.anyIn, fields: COMMENT_FIELDS },
      { id: 'add-label', name: 'Add label', description: 'Add a label, such as agent-ready after triage.', inputs: PORTS.anyIn, fields: LABEL('agent-ready') },
      { id: 'remove-label', name: 'Remove label', description: 'Take a label off, so it can be added again to retry.', inputs: PORTS.anyIn, fields: LABEL('agent:go') },
      { id: 'create-issue', name: 'Create issue', description: 'File an issue, for work a triage step decided a person should do.', inputs: PORTS.anyIn, outputs: PORTS.issueOut, fields: [...NEW_ISSUE_FIELDS, FIELDS.text('repo', 'Repository', 'acme/api'), FIELDS.text('labels', 'Labels', 'bug')] },
      { id: 'assign', name: 'Assign', description: 'Hand the issue to a person.', inputs: PORTS.anyIn, fields: [FIELDS.text('assignee', 'Assignee', '@me')] },
      { id: 'close-issue', name: 'Close issue', description: 'Close the issue with a reason.', inputs: PORTS.anyIn, fields: [FIELDS.select('reason', 'Reason', [{ value: 'completed', label: 'Completed' }, { value: 'not_planned', label: 'Not planned' }])] },
    ],
  }),
  defineConnector({
    id: 'linear',
    name: 'Linear',
    category: 'issues',
    description: 'Issues in Linear. Assign one to the bot like you would to a teammate.',
    auth: 'oauth',
    icon: { si: 'SiLinear', color: '#5E6AD2' },
    docsUrl: 'https://developers.linear.app/docs',
    tags: ['issues', 'cycles', 'triage'],
    popular: true,
    uses: [
      'Assign a ticket to the bot; it moves to In Review with a draft PR attached.',
      'New tickets are priced before anyone picks them up, and the small ones are labelled for the agents.',
      'A fix that needs a person becomes a ticket with the stack trace in it.',
    ],
    triggers: [
      { id: 'issue-assigned', name: 'Assigned to the bot', description: 'An issue is assigned to the bot user.', outputs: PORTS.issueOut, fields: [FIELDS.text('assignee', 'Assigned to', BOT), FIELDS.text('team', 'Team key', 'ENG')], sample: ticket('ENG-142', 'https://linear.app/acme/issue/ENG-142') },
      { id: 'issue-labelled', name: 'Label added', description: 'A label is added to an issue.', outputs: PORTS.issueOut, fields: LABEL('agent:go'), sample: ticket('ENG-142', 'https://linear.app/acme/issue/ENG-142', { labels: ['bug', 'agent:go'] }) },
      { id: 'issue-state-changed', name: 'Moved to a state', description: 'An issue enters a workflow state, such as a “Ready for agent” column.', outputs: PORTS.issueOut, fields: [FIELDS.text('state', 'State', 'Ready for agent')], sample: ticket('ENG-142', 'https://linear.app/acme/issue/ENG-142') },
      { id: 'issue-created', name: 'Issue created', description: 'A new issue lands in a team. Good for triage, not for running the pipeline on everything.', outputs: PORTS.issueOut, fields: [FIELDS.text('team', 'Team key', 'ENG')], sample: ticket('ENG-143', 'https://linear.app/acme/issue/ENG-143', { assignee: '' }) },
      { id: 'comment-mention', name: 'Asked in a comment', description: 'A comment mentions the bot. The comment is added to the task.', outputs: PORTS.issueOut, fields: [FIELDS.text('mention', 'Mention', BOT)], sample: ticket('ENG-142', 'https://linear.app/acme/issue/ENG-142', { comment: '@relay-bot can you take this? Keep the fix to the export handler.' }) },
    ],
    actions: [
      { id: 'update-state', name: 'Move to state', description: 'Move the issue, e.g. to In Progress when a run starts and In Review when its PR opens.', inputs: PORTS.anyIn, fields: IN_REVIEW() },
      { id: 'attach-pr', name: 'Attach pull request', description: LINK_PR_HELP, inputs: PORTS.changeIn },
      { id: 'comment', name: 'Comment', description: 'Comment on the issue, for example why a run did not start.', inputs: PORTS.anyIn, fields: COMMENT_FIELDS },
      { id: 'add-label', name: 'Add label', description: 'Add a label, such as agent-ready after triage.', inputs: PORTS.anyIn, fields: LABEL('agent-ready') },
      { id: 'create-issue', name: 'Create issue', description: 'File an issue, for work a person should do or to track a request that came from elsewhere.', inputs: PORTS.anyIn, outputs: PORTS.issueOut, fields: [...NEW_ISSUE_FIELDS, FIELDS.text('team', 'Team key', 'ENG')] },
      { id: 'assign', name: 'Assign', description: 'Hand the issue to a person.', inputs: PORTS.anyIn, fields: [FIELDS.text('assignee', 'Assignee', 'me')] },
    ],
  }),
  defineConnector({
    id: 'jira',
    name: 'Jira',
    category: 'issues',
    description: 'Jira Cloud issues. Transition a ticket or assign it to the bot to start a run.',
    auth: 'oauth',
    icon: { si: 'SiJira', color: '#0052CC' },
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
    tags: ['issues', 'sprints', 'atlassian'],
    popular: true,
    uses: [
      'Move a ticket to “Ready for agent” and it comes back in Code Review with the PR in the development panel.',
      'Support escalations become Jira bugs with the reproduction steps filled in.',
    ],
    triggers: [
      { id: 'issue-transitioned', name: 'Moved to a status', description: 'An issue moves to a status, such as a “Ready for agent” column on the board.', outputs: PORTS.issueOut, fields: [FIELDS.text('status', 'Status', 'Ready for agent'), FIELDS.text('project', 'Project key', 'PROJ')], sample: ticket('PROJ-1187', 'https://acme.atlassian.net/browse/PROJ-1187') },
      { id: 'issue-assigned', name: 'Assigned to the bot', description: 'An issue is assigned to the bot user.', outputs: PORTS.issueOut, fields: [FIELDS.text('assignee', 'Assigned to', BOT)], sample: ticket('PROJ-1187', 'https://acme.atlassian.net/browse/PROJ-1187') },
      { id: 'issue-labelled', name: 'Label added', description: 'A label is added to an issue.', outputs: PORTS.issueOut, fields: LABEL('agent-go'), sample: ticket('PROJ-1187', 'https://acme.atlassian.net/browse/PROJ-1187', { labels: ['bug', 'agent-go'] }) },
      { id: 'issue-created', name: 'Issue created', description: 'A new issue is created in a project. Pair it with a triage step.', outputs: PORTS.issueOut, fields: [FIELDS.text('project', 'Project key', 'PROJ'), FIELDS.text('type', 'Issue type', 'Bug')], sample: ticket('PROJ-1188', 'https://acme.atlassian.net/browse/PROJ-1188', { assignee: '' }) },
    ],
    actions: [
      { id: 'transition', name: 'Transition issue', description: 'Move the issue to a status, e.g. Code Review once its PR opens.', inputs: PORTS.anyIn, fields: [FIELDS.text('status', 'Status', 'Code Review')] },
      { id: 'link-pr', name: 'Link pull request', description: LINK_PR_HELP, inputs: PORTS.changeIn },
      { id: 'comment', name: 'Comment', description: 'Comment on the issue.', inputs: PORTS.anyIn, fields: COMMENT_FIELDS },
      { id: 'add-label', name: 'Add label', description: 'Add a label.', inputs: PORTS.anyIn, fields: LABEL('agent-ready') },
      { id: 'create-issue', name: 'Create issue', description: 'File an issue in a project.', inputs: PORTS.anyIn, outputs: PORTS.issueOut, fields: [...NEW_ISSUE_FIELDS, FIELDS.text('project', 'Project key', 'PROJ'), FIELDS.text('type', 'Issue type', 'Bug')] },
      { id: 'assign', name: 'Assign', description: 'Hand the issue to a person.', inputs: PORTS.anyIn, fields: [FIELDS.text('assignee', 'Assignee', 'me')] },
    ],
  }),
  defineConnector({
    id: 'shortcut',
    name: 'Shortcut',
    category: 'issues',
    description: 'Stories in Shortcut. Give one to the bot as its owner, or move it to a workflow state.',
    auth: 'api-key',
    icon: { si: 'SiShortcut', color: '#58B1E4' },
    docsUrl: 'https://developer.shortcut.com/api/rest/v3',
    tags: ['stories', 'iterations'],
    uses: ['Make the bot a story’s owner and the story comes back with a pull request linked.'],
    triggers: [
      { id: 'story-assigned', name: 'Bot made owner', description: 'The bot is added as an owner of a story.', outputs: PORTS.issueOut, fields: [FIELDS.text('assignee', 'Owner', BOT)], sample: ticket('sc-3141', 'https://app.shortcut.com/acme/story/3141') },
      { id: 'story-state-changed', name: 'Moved to a state', description: 'A story enters a workflow state.', outputs: PORTS.issueOut, fields: [FIELDS.text('state', 'State', 'Ready for agent')], sample: ticket('sc-3141', 'https://app.shortcut.com/acme/story/3141') },
      { id: 'story-labelled', name: 'Label added', description: 'A label is added to a story.', outputs: PORTS.issueOut, fields: LABEL('agent:go'), sample: ticket('sc-3141', 'https://app.shortcut.com/acme/story/3141', { labels: ['bug', 'agent:go'] }) },
    ],
    actions: [
      { id: 'move-story', name: 'Move to state', description: 'Move the story, e.g. to In Review.', inputs: PORTS.anyIn, fields: IN_REVIEW() },
      { id: 'link-pr', name: 'Link pull request', description: LINK_PR_HELP, inputs: PORTS.changeIn },
      { id: 'comment', name: 'Comment', description: 'Comment on the story.', inputs: PORTS.anyIn, fields: COMMENT_FIELDS },
      { id: 'create-story', name: 'Create story', description: 'Create a story.', inputs: PORTS.anyIn, outputs: PORTS.issueOut, fields: [...NEW_ISSUE_FIELDS, FIELDS.select('type', 'Type', [{ value: 'bug', label: 'Bug' }, { value: 'feature', label: 'Feature' }, { value: 'chore', label: 'Chore' }])] },
    ],
  }),
  defineConnector({
    id: 'notion',
    name: 'Notion',
    category: 'issues',
    description: 'A Notion database used as a tracker. A row moving to a status is the ticket.',
    auth: 'oauth',
    icon: { si: 'SiNotion', color: '#000000' },
    docsUrl: 'https://developers.notion.com/',
    tags: ['database', 'tracker', 'specs'],
    uses: ['Small teams that track work in a Notion database set a row to “Ready for agent” and get the PR link written back to it.'],
    triggers: [
      { id: 'property-changed', name: 'Status changed', description: 'A row’s status property changes to a value.', outputs: PORTS.issueOut, fields: [FIELDS.text('database', 'Database', 'Engineering tasks'), FIELDS.text('property', 'Property', 'Status'), FIELDS.text('value', 'New value', 'Ready for agent')], sample: ticket('a1b2c3d4', 'https://www.notion.so/acme/a1b2c3d4') },
      { id: 'database-row-added', name: 'Row added', description: 'A row is added to the database.', outputs: PORTS.issueOut, fields: [FIELDS.text('database', 'Database', 'Engineering tasks')], sample: ticket('a1b2c3d5', 'https://www.notion.so/acme/a1b2c3d5', { assignee: '' }) },
    ],
    actions: [
      { id: 'update-property', name: 'Set status', description: 'Set a property on the row, e.g. Status to In Review.', inputs: PORTS.anyIn, fields: [FIELDS.text('property', 'Property', 'Status'), FIELDS.template('value', 'Value', 'In Review')] },
      { id: 'link-pr', name: 'Link pull request', description: 'Write the PR URL into a property on the row.', inputs: PORTS.changeIn, fields: [FIELDS.text('property', 'URL property', 'PR'), FIELDS.template('value', 'Value', '{{run.prUrl}}')] },
      { id: 'add-comment', name: 'Add comment', description: 'Comment on the row.', inputs: PORTS.anyIn, fields: [FIELDS.template('body', 'Comment', '{{run.summary}}')] },
    ],
  }),
  defineConnector({
    id: 'github',
    name: 'GitHub',
    category: 'source-control',
    description: 'Pull requests and pushes on GitHub, where delivered work lands.',
    auth: 'app',
    icon: { si: 'SiGithub', color: '#181717' },
    docsUrl: 'https://docs.github.com/rest',
    tags: ['git', 'pull requests', 'repos'],
    popular: true,
    uses: [
      'Ask the owning team for review as soon as an agent’s pull request opens.',
      'When the fix merges, tell the channel or the customer it has shipped.',
    ],
    triggers: [
      { id: 'pr-merged', name: 'Pull request merged', description: 'A pull request is merged, optionally only ones with a label. The moment to say a fix has shipped.', outputs: PORTS.changeOut, fields: [FIELDS.text('base', 'Into branch', 'main'), FIELDS.text('label', 'Only with label', 'relay')], sample: change(412, 'https://github.com/acme/api/pull/412', { merged: true }) },
      { id: 'pr-opened', name: 'Pull request opened', description: 'A pull request is opened against a branch.', outputs: PORTS.changeOut, fields: [FIELDS.text('base', 'Base branch', 'main')], sample: change(412, 'https://github.com/acme/api/pull/412') },
      { id: 'push', name: 'Push to branch', description: 'Commits land on a branch, optionally only when certain paths change.', outputs: PORTS.changeOut, fields: [FIELDS.text('branch', 'Branch', 'main'), FIELDS.text('paths', 'Only when these paths change', 'src/api/**')], sample: change(0, 'https://github.com/acme/api/compare/3f2a1c0...9b7e44d', { title: 'Merge pull request #412 from acme/relay/eng-142-export-safari' }) },
    ],
    actions: [
      { id: 'request-review', name: 'Request review', description: 'Ask people or a team to review the pull request.', inputs: PORTS.changeIn, fields: [FIELDS.text('reviewers', 'Reviewers', '@acme/platform')] },
      { id: 'comment', name: 'Comment', description: 'Comment on the pull request.', inputs: PORTS.anyIn, fields: COMMENT_FIELDS },
      { id: 'add-label', name: 'Add label', description: 'Label the pull request.', inputs: PORTS.changeIn, fields: LABEL('agent') },
    ],
  }),
  defineConnector({
    id: 'gitlab',
    name: 'GitLab',
    category: 'source-control',
    description: 'Issues and merge requests on GitLab.com or self-managed.',
    auth: 'token',
    icon: { si: 'SiGitlab', color: '#FC6D26' },
    docsUrl: 'https://docs.gitlab.com/ee/api/',
    tags: ['git', 'merge requests', 'self-hosted'],
    uses: ['Teams on GitLab label an issue for the agents and hear back on the issue when the merge request opens.'],
    triggers: [
      { id: 'issue-labelled', name: 'Issue labelled', description: 'A label is added to an issue.', outputs: PORTS.issueOut, fields: LABEL('agent::go'), sample: ticket('acme/api#93', 'https://gitlab.com/acme/api/-/issues/93', { labels: ['bug', 'agent::go'] }) },
      { id: 'issue-assigned', name: 'Issue assigned to the bot', description: 'An issue is assigned to the bot user.', outputs: PORTS.issueOut, fields: [FIELDS.text('assignee', 'Assigned to', BOT)], sample: ticket('acme/api#93', 'https://gitlab.com/acme/api/-/issues/93') },
      { id: 'mr-merged', name: 'Merge request merged', description: 'A merge request is merged into a branch.', outputs: PORTS.changeOut, fields: [FIELDS.text('target', 'Into branch', 'main')], sample: change(88, 'https://gitlab.com/acme/api/-/merge_requests/88', { merged: true }) },
    ],
    actions: [
      { id: 'comment', name: 'Comment', description: 'Post a note on the issue or merge request.', inputs: PORTS.anyIn, fields: COMMENT_FIELDS },
      { id: 'add-label', name: 'Add label', description: 'Add a label.', inputs: PORTS.anyIn, fields: LABEL('agent::ready') },
    ],
  }),
  defineConnector({
    id: 'bitbucket',
    name: 'Bitbucket',
    category: 'source-control',
    description: 'Pull requests on Bitbucket Cloud, usually alongside Jira.',
    auth: 'oauth',
    icon: { si: 'SiBitbucket', color: '#0052CC' },
    docsUrl: 'https://developer.atlassian.com/cloud/bitbucket/rest/',
    tags: ['git', 'atlassian', 'pull requests'],
    uses: ['Close the loop on a Jira ticket when the Bitbucket pull request for it merges.'],
    triggers: [{ id: 'pr-merged', name: 'Pull request merged', description: 'A pull request is merged.', outputs: PORTS.changeOut, fields: [FIELDS.text('destination', 'Into branch', 'main')], sample: change(57, 'https://bitbucket.org/acme/api/pull-requests/57', { merged: true }) }],
    actions: [{ id: 'comment', name: 'Comment', description: 'Comment on the pull request.', inputs: PORTS.anyIn, fields: COMMENT_FIELDS }],
  }),
  defineConnector({
    id: 'azure-devops',
    name: 'Azure DevOps',
    category: 'source-control',
    description: 'Work items in Azure Boards and pull requests in Azure Repos.',
    auth: 'token',
    icon: { lucide: 'Workflow', color: '#0078D4' },
    docsUrl: 'https://learn.microsoft.com/rest/api/azure/devops/',
    tags: ['work items', 'boards', 'microsoft'],
    uses: ['Assign a Bug work item to the bot; it moves to Resolved-pending-review with the PR linked.'],
    triggers: [
      { id: 'work-item-assigned', name: 'Work item assigned to the bot', description: 'A work item is assigned to the bot identity.', outputs: PORTS.issueOut, fields: [FIELDS.text('assignee', 'Assigned to', 'relay-bot@acme.com'), FIELDS.text('type', 'Work item type', 'Bug')], sample: ticket('AB#4410', 'https://dev.azure.com/acme/api/_workitems/edit/4410') },
      { id: 'work-item-created', name: 'Work item created', description: 'A work item is created. Pair it with a triage step.', outputs: PORTS.issueOut, fields: [FIELDS.text('type', 'Work item type', 'Bug')], sample: ticket('AB#4411', 'https://dev.azure.com/acme/api/_workitems/edit/4411', { assignee: '' }) },
    ],
    actions: [
      { id: 'update-state', name: 'Set state', description: 'Move the work item to a state.', inputs: PORTS.anyIn, fields: IN_REVIEW('Resolved') },
      { id: 'link-pr', name: 'Link pull request', description: LINK_PR_HELP, inputs: PORTS.changeIn },
      { id: 'comment', name: 'Comment', description: 'Add a discussion comment to the work item.', inputs: PORTS.anyIn, fields: COMMENT_FIELDS },
    ],
  }),
  defineConnector({
    id: 'figma',
    name: 'Figma',
    category: 'design',
    description: 'Design handoff. A frame marked ready for development is a ticket with the design attached.',
    auth: 'oauth',
    icon: { si: 'SiFigma', color: '#F24E1E' },
    docsUrl: 'https://www.figma.com/developers/api',
    tags: ['design', 'dev mode', 'handoff'],
    popular: true,
    uses: ['A designer marks a small UI change ready for dev, and the implementing PR is posted back on the frame.'],
    triggers: [
      { id: 'dev-mode-ready', name: 'Marked ready for dev', description: 'A frame is marked ready for development in Dev Mode. The frame link goes into the task.', outputs: PORTS.issueOut, fields: [FIELDS.text('fileKey', 'File', 'Settings redesign')], sample: taskSample('node_12:34', 'Empty state for the inbox', 'https://www.figma.com/design/abc/Inbox?node-id=12-34', 'Implement the empty state in frame "Inbox / Empty" at 1440 and 390 widths. Use existing tokens; the illustration is exported in the frame.', { author: 'design@acme.com' }) },
      { id: 'comment-added', name: 'Asked in a comment', description: 'A comment on a frame mentions the bot.', outputs: PORTS.issueOut, fields: [FIELDS.text('mention', 'Mention', '@relay')], sample: taskSample('cmt_1901', 'Tighten the padding on the settings cards', 'https://www.figma.com/design/abc/Settings?node-id=4-2', '@relay the cards should use space-4 like the frame, not space-6.', { author: 'design@acme.com' }) },
    ],
    actions: [
      { id: 'link-pr', name: 'Reply with the pull request', description: 'Reply on the frame’s thread with the implementing PR, so design can review the preview.', inputs: PORTS.changeIn, fields: [FIELDS.template('body', 'Comment', 'Implemented in {{run.prUrl}}. Preview is on the PR.')] },
    ],
  }),
];
