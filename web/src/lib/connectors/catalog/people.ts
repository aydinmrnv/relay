// Requests from people, and where they hear back: chat, support desks, email.
//
// Two jobs. A person asks for a fix where they already are: an emoji on a bug
// report in Slack, a support ticket tagged bug. And a person is told what
// happened, in the place they asked, in words that fit that audience: a thread
// reply for the teammate, an internal note for the support agent, never a pull
// request link sent straight to a customer.
import { defineConnector, FIELDS, PORTS, taskSample, type Connector } from '../types';

const SHARE_PR = FIELDS.template('text', 'Message', '{{issue.title}}: a draft PR is ready for review. {{run.prUrl}}');
const RUN_SUMMARY = FIELDS.template('text', 'Summary', '{{run.status}}: {{issue.title}}. {{run.prUrl}} ({{run.cost}})');
const report = (id: string, title: string, url: string, reporter: string, body: string, extra: Record<string, unknown> = {}) => taskSample(id, title, url, body, { reporter, author: reporter, ...extra });
const customerBug = (id: string, url: string, extra: Record<string, unknown> = {}) =>
  report(id, 'CSV export downloads an empty file for large reports', url, 'customer@bigco.example', 'Customer on the Business plan: exporting the "All orders" report (about 40k rows) downloads a 0-byte CSV. Smaller reports work. Started this week.\n\nSteps from the agent: Reports → All orders → Export CSV. Browser: Chrome 129.', { labels: ['bug'], priority: 'high', ...extra });

export const PEOPLE_CONNECTORS: Connector[] = [
  /* ---------------------------------------------------------------- */
  /* Chat                                                              */
  /* ---------------------------------------------------------------- */
  defineConnector({
    id: 'slack',
    name: 'Slack',
    category: 'chat',
    description: 'Ask for a fix where the bug was reported, and hear back in the same thread.',
    auth: 'oauth',
    icon: { lucide: 'Hash', color: '#4A154B' },
    docsUrl: 'https://api.slack.com/',
    tags: ['chat', 'notifications', 'bug reports'],
    popular: true,
    // What an incoming webhook can do comes first: that is the connection that exists today, and the first line is what the card shows.
    uses: [
      'Ask the channel for review when an agent\'s pull request opens.',
      'Tell #builds why a red build was not fixed automatically.',
      'React with :robot_face: to a bug report in #bugs and the thread gets the draft PR.',
    ],
    triggers: [
      { id: 'reaction-added', name: 'Emoji reaction added', description: 'Someone reacts to a message with a chosen emoji. The message and its thread become the task.', outputs: PORTS.issueOut, fields: [FIELDS.text('channel', 'Channel', '#bugs'), FIELDS.text('reaction', 'Emoji', 'robot_face')], sample: report('1726912345.000200', 'Export button does nothing on the second click in Safari', 'https://acme.slack.com/archives/C01ABC/p1726912345000200', 'jane', 'From #bugs, reported by Jane: "Export does nothing if you click it twice on Safari. Console says blob.size is undefined." 2 replies confirm it on Safari 18.') },
      { id: 'app-mentioned', name: 'Bot mentioned', description: 'Someone mentions the bot with a request, as in "@relay add rate limiting to the webhook endpoint".', outputs: PORTS.issueOut, fields: [FIELDS.text('channel', 'Channel', '#eng')], sample: report('1726912400.000300', 'Add rate limiting to the webhook endpoint', 'https://acme.slack.com/archives/C01ABC/p1726912400000300', 'sam', '@relay add rate limiting to the webhook endpoint, 100 requests a minute per API key, 429 with Retry-After.') },
    ],
    actions: [
      { id: 'reply-in-thread', name: 'Reply in thread', description: 'Reply under the message that started the run, so the person who asked sees it.', inputs: PORTS.anyIn, fields: [FIELDS.template('text', 'Reply', 'Draft PR ready for review: {{run.prUrl}}')] },
      { id: 'share-pr', name: 'Ask for review', description: 'Post the pull request to a channel for review.', inputs: PORTS.changeIn, fields: [FIELDS.text('channel', 'Channel', '#eng', true), SHARE_PR] },
      { id: 'post-message', name: 'Post message', description: 'Post to a channel, for example why a run was refused.', inputs: PORTS.anyIn, fields: [FIELDS.text('channel', 'Channel', '#eng', true), FIELDS.template('text', 'Message', '{{issue.title}}')] },
      { id: 'post-run-summary', name: 'Post run summary', description: 'Post how a finished run went: outcome, PR, tests and cost.', inputs: PORTS.runIn, fields: [FIELDS.text('channel', 'Channel', '#eng', true), RUN_SUMMARY] },
      { id: 'add-reaction', name: 'Add reaction', description: 'React to the message that started the run, e.g. :eyes: when picked up.', inputs: PORTS.anyIn, fields: [FIELDS.text('reaction', 'Emoji', 'eyes')] },
      { id: 'send-dm', name: 'Send direct message', description: 'Message one person, such as the owner of the code that broke.', inputs: PORTS.anyIn, fields: [FIELDS.text('user', 'User', '@jane', true), FIELDS.template('text', 'Message', '{{issue.title}}: {{run.prUrl}}')] },
    ],
  }),
  defineConnector({
    id: 'discord',
    name: 'Discord',
    category: 'chat',
    description: 'Community bug reports from a forum channel, and replies back in the post.',
    auth: 'app',
    icon: { si: 'SiDiscord', color: '#5865F2' },
    docsUrl: 'https://discord.com/developers/docs',
    tags: ['community', 'bug reports'],
    popular: true,
    uses: ['Post an agent\'s pull request to #maintainers when a fix is up.', 'A moderator reacts to a post in #bug-reports and the reporter hears back in that post when a fix is up.'],
    triggers: [
      { id: 'reaction-added', name: 'Reaction added', description: 'A moderator reacts to a message or forum post with a chosen emoji.', outputs: PORTS.issueOut, fields: [FIELDS.text('channel', 'Channel', '#bug-reports'), FIELDS.text('reaction', 'Emoji', 'robot')], sample: report('1287654321', 'Login loops after a password reset', 'https://discord.com/channels/1/2/1287654321', 'kai', 'After resetting my password the login page keeps redirecting to itself. Clearing cookies fixes it. Happens on Firefox and Chrome.') },
      { id: 'forum-post-created', name: 'Forum post created', description: 'A new post in a forum channel. Pair it with a triage step: most posts are not bugs.', outputs: PORTS.issueOut, fields: [FIELDS.text('channel', 'Forum channel', '#bug-reports')], sample: report('1287654999', 'Crash when importing a 2 GB project', 'https://discord.com/channels/1/3/1287654999', 'mira', 'Importing a large project crashes the desktop app with "out of memory". Log attached.') },
    ],
    actions: [
      { id: 'reply-to-thread', name: 'Reply in the post', description: 'Reply in the post or thread that started the run.', inputs: PORTS.anyIn, fields: [FIELDS.template('text', 'Reply', 'Thanks! A fix is in review and will ship in the next release.')] },
      { id: 'share-pr', name: 'Share pull request', description: 'Post the pull request to a channel for the maintainers.', inputs: PORTS.changeIn, fields: [FIELDS.text('channel', 'Channel', '#maintainers', true), SHARE_PR] },
      { id: 'send-message', name: 'Send message', description: 'Post to a channel.', inputs: PORTS.anyIn, fields: [FIELDS.text('channel', 'Channel', '#maintainers', true), FIELDS.template('text', 'Message', '{{issue.title}}')] },
    ],
  }),
  defineConnector({
    id: 'microsoft-teams',
    name: 'Microsoft Teams',
    category: 'chat',
    description: 'Ask the bot in a channel, and post results where the team works.',
    auth: 'oauth',
    icon: { lucide: 'Users', color: '#6264A7' },
    docsUrl: 'https://learn.microsoft.com/graph/teams-concept-overview',
    tags: ['chat', 'microsoft', 'notifications'],
    uses: ['Post agent pull requests to the engineering channel for review.'],
    triggers: [{ id: 'bot-mentioned', name: 'Bot mentioned', description: 'Someone mentions the bot with a request.', outputs: PORTS.issueOut, sample: report('19:abc@thread.tacv2', 'Timesheet export returns 500', 'https://teams.microsoft.com/l/message/19%3Aabc/1726912345', 'ola', '@Relay the timesheet export returns a 500 for March. Stack trace from the logs is in the thread.') }],
    actions: [
      { id: 'reply', name: 'Reply to message', description: 'Reply to the message that started the run.', inputs: PORTS.anyIn, fields: [FIELDS.template('text', 'Reply', 'Draft PR ready for review: {{run.prUrl}}')] },
      { id: 'post-message', name: 'Post channel message', description: 'Post to a channel.', inputs: PORTS.anyIn, fields: [FIELDS.text('team', 'Team', 'Engineering', true), FIELDS.text('channel', 'Channel', 'General', true), FIELDS.template('text', 'Message', '{{issue.title}}: {{run.prUrl}}')] },
      { id: 'post-run-summary', name: 'Post run summary', description: 'Post how a finished run went.', inputs: PORTS.runIn, fields: [FIELDS.text('channel', 'Channel', 'General', true), RUN_SUMMARY] },
    ],
  }),

  /* ---------------------------------------------------------------- */
  /* Support                                                           */
  /* ---------------------------------------------------------------- */
  defineConnector({
    id: 'zendesk',
    name: 'Zendesk',
    category: 'support',
    description: 'Tickets tagged as bugs, and internal notes so support knows where the fix is.',
    auth: 'oauth',
    icon: { si: 'SiZendesk', color: '#03363D' },
    docsUrl: 'https://developer.zendesk.com/api-reference/',
    tags: ['support', 'tickets', 'bug reports'],
    uses: [
      'A ticket tagged bug waits for an engineer\'s approval, then the support agent gets an internal note with the PR.',
      'Tickets without steps to reproduce get a note asking for them, instead of a guess.',
    ],
    triggers: [
      { id: 'ticket-tagged', name: 'Ticket tagged', description: 'A support agent adds a tag, such as bug.', outputs: PORTS.issueOut, fields: [FIELDS.text('tag', 'Tag', 'bug')], sample: customerBug('T-9022', 'https://acme.zendesk.com/agent/tickets/9022') },
      { id: 'ticket-escalated', name: 'Ticket escalated', description: 'A ticket is raised to urgent or moved to an escalation group.', outputs: PORTS.issueOut, fields: [FIELDS.text('group', 'Group', 'Escalations')], sample: customerBug('T-9023', 'https://acme.zendesk.com/agent/tickets/9023', { priority: 'urgent' }) },
      { id: 'ticket-created', name: 'Ticket created', description: 'Any new ticket in a group. Put a triage step after it: most tickets are not bugs.', outputs: PORTS.issueOut, fields: [FIELDS.text('group', 'Group', 'Tier 2')], sample: customerBug('T-9021', 'https://acme.zendesk.com/agent/tickets/9021') },
    ],
    actions: [
      { id: 'add-internal-note', name: 'Add internal note', description: 'A private note the support agent sees and the customer does not.', inputs: PORTS.anyIn, fields: [FIELDS.template('body', 'Note', 'Engineering has a fix in review: {{run.prUrl}}. Not shipped yet; don\'t promise a date.')] },
      { id: 'add-tags', name: 'Add tags', description: 'Tag the ticket, e.g. fix-in-review, so support can find them all.', inputs: PORTS.anyIn, fields: [FIELDS.text('tags', 'Tags', 'fix-in-review')] },
      { id: 'reply-to-customer', name: 'Reply to customer', description: 'A public reply. Use it once the fix has shipped, from a merged-PR trigger, not when a PR opens.', inputs: PORTS.anyIn, fields: [FIELDS.template('body', 'Reply', 'Thanks for your patience: this is fixed and live now.')] },
    ],
  }),
  defineConnector({
    id: 'intercom',
    name: 'Intercom',
    category: 'support',
    description: 'Conversations tagged as bugs, and notes for the teammate handling them.',
    auth: 'oauth',
    icon: { si: 'SiIntercom', color: '#6AFDEF' },
    docsUrl: 'https://developers.intercom.com/docs',
    tags: ['support', 'conversations', 'bug reports'],
    uses: ['A conversation tagged Bug becomes a tracked ticket and, after approval, a fix PR noted on the conversation.'],
    triggers: [
      { id: 'conversation-tagged', name: 'Conversation tagged', description: 'A teammate tags a conversation, such as Bug.', outputs: PORTS.issueOut, fields: [FIELDS.text('tag', 'Tag', 'Bug')], sample: customerBug('conv_1190', 'https://app.intercom.com/a/inbox/abc/inbox/conversation/1190') },
      { id: 'ticket-created', name: 'Ticket created', description: 'A back-office ticket is created from a conversation.', outputs: PORTS.issueOut, fields: [FIELDS.text('type', 'Ticket type', 'Bug report')], sample: customerBug('tkt_402', 'https://app.intercom.com/a/tickets/abc/402') },
    ],
    actions: [
      { id: 'add-note', name: 'Add internal note', description: 'A note the teammate sees and the customer does not.', inputs: PORTS.anyIn, fields: [FIELDS.template('body', 'Note', 'Fix in review: {{run.prUrl}}. Not shipped yet.')] },
      { id: 'tag-conversation', name: 'Tag conversation', description: 'Tag the conversation, e.g. Fix in review.', inputs: PORTS.anyIn, fields: [FIELDS.text('tag', 'Tag', 'Fix in review')] },
      { id: 'reply', name: 'Reply to customer', description: 'A public reply. Use it once the fix has shipped.', inputs: PORTS.anyIn, fields: [FIELDS.template('body', 'Reply', 'Good news: this is fixed and live now. Thanks for reporting it!')] },
    ],
  }),
  defineConnector({
    id: 'plain',
    name: 'Plain',
    category: 'support',
    description: 'Support threads labelled as bugs, for B2B and developer-tool teams.',
    auth: 'api-key',
    icon: { lucide: 'MessageSquare', color: '#0F0F0F' },
    docsUrl: 'https://www.plain.com/docs/api-reference',
    tags: ['support', 'b2b', 'threads'],
    uses: ['A thread labelled Bug gets a fix PR noted on the thread, and the thread snoozes until it ships.'],
    triggers: [{ id: 'thread-labeled', name: 'Thread labelled', description: 'A label is added to a thread, such as Bug.', outputs: PORTS.issueOut, fields: [FIELDS.text('label', 'Label', 'Bug')], sample: report('th_01H9Y', 'Webhook signatures fail after rotating the signing key', 'https://app.plain.com/workspace/w_1/thread/th_01H9Y', 'ops@customer.example', 'After rotating the webhook signing key in settings, every delivery fails signature checks for about an hour. Old key still used by some workers?', { labels: ['bug'] }) }],
    actions: [
      { id: 'add-note', name: 'Add note', description: 'An internal note on the thread.', inputs: PORTS.anyIn, fields: [FIELDS.template('text', 'Note', 'Fix in review: {{run.prUrl}}')] },
      { id: 'set-status', name: 'Set status', description: 'Snooze the thread until the fix ships, or mark it done.', inputs: PORTS.anyIn, fields: [FIELDS.select('status', 'Status', [{ value: 'SNOOZED', label: 'Snoozed' }, { value: 'TODO', label: 'Todo' }, { value: 'DONE', label: 'Done' }], 'SNOOZED')] },
      { id: 'reply', name: 'Reply to customer', description: 'A public reply. Use it once the fix has shipped.', inputs: PORTS.anyIn, fields: [FIELDS.template('text', 'Reply', 'This is fixed and live now. Thanks for the detailed report!')] },
    ],
  }),
  defineConnector({
    id: 'freshdesk',
    name: 'Freshdesk',
    category: 'support',
    description: 'Tickets tagged as bugs, and private notes for the agent handling them.',
    auth: 'api-key',
    icon: { lucide: 'Headset', color: '#25C16F' },
    docsUrl: 'https://developers.freshdesk.com/api/',
    tags: ['support', 'tickets', 'bug reports'],
    uses: ['A ticket tagged bug gets a fix PR after approval, with a private note for the support agent.'],
    triggers: [{ id: 'ticket-tagged', name: 'Ticket tagged', description: 'A tag is added to a ticket, such as bug.', outputs: PORTS.issueOut, fields: [FIELDS.text('tag', 'Tag', 'bug')], sample: customerBug('FD-5521', 'https://acme.freshdesk.com/a/tickets/5521') }],
    actions: [
      { id: 'add-note', name: 'Add private note', description: 'A note the support agent sees and the customer does not.', inputs: PORTS.anyIn, fields: [FIELDS.template('body', 'Note', 'Fix in review: {{run.prUrl}}. Not shipped yet.')] },
      { id: 'reply', name: 'Reply to customer', description: 'A public reply. Use it once the fix has shipped.', inputs: PORTS.anyIn, fields: [FIELDS.template('body', 'Reply', 'This is fixed and live now. Thanks for your patience.')] },
    ],
  }),

  /* ---------------------------------------------------------------- */
  /* Email                                                             */
  /* ---------------------------------------------------------------- */
  defineConnector({
    id: 'gmail',
    name: 'Gmail',
    category: 'email',
    description: 'A bugs@ inbox as a source of work, and email for people who are not in chat.',
    auth: 'oauth',
    icon: { si: 'SiGmail', color: '#EA4335' },
    docsUrl: 'https://developers.google.com/gmail/api',
    tags: ['email', 'inbox', 'google'],
    uses: ['Email the on-call lead a daily summary of what the agents shipped and what they cost.'],
    triggers: [{ id: 'email-received', name: 'Email received', description: 'A message matching a search arrives, such as mail to bugs@.', outputs: PORTS.issueOut, fields: [FIELDS.text('query', 'Search', 'to:bugs@acme.com is:unread')], sample: customerBug('18f2c9a1b2', 'https://mail.google.com/mail/u/0/#inbox/18f2c9a1b2') }],
    actions: [
      { id: 'send-email', name: 'Send email', description: 'Send an email.', inputs: PORTS.anyIn, fields: [FIELDS.text('to', 'To', 'eng-leads@acme.com', true), FIELDS.template('subject', 'Subject', '{{issue.title}}'), FIELDS.template('body', 'Body', '{{run.summary}}\n\n{{run.prUrl}}')] },
      { id: 'send-run-report', name: 'Send run report', description: 'Email how a finished run went.', inputs: PORTS.runIn, fields: [FIELDS.text('to', 'To', 'eng-leads@acme.com', true), FIELDS.template('subject', 'Subject', '{{run.status}}: {{issue.title}}'), FIELDS.template('body', 'Body', '{{run.summary}}')] },
    ],
  }),
  defineConnector({
    id: 'outlook',
    name: 'Outlook',
    category: 'email',
    description: 'A shared Microsoft 365 inbox as a source of work, and email for people who are not in chat.',
    auth: 'oauth',
    icon: { lucide: 'Mail', color: '#0078D4' },
    docsUrl: 'https://learn.microsoft.com/graph/outlook-mail-concept-overview',
    tags: ['email', 'inbox', 'microsoft'],
    uses: ['Turn mail to a shared bugs inbox into tracked tickets.'],
    triggers: [{ id: 'email-received', name: 'Email received', description: 'A message arrives in a folder or shared mailbox.', outputs: PORTS.issueOut, fields: [FIELDS.text('mailbox', 'Mailbox', 'bugs@acme.com')], sample: customerBug('AAMkAGI2', 'https://outlook.office.com/mail/inbox/id/AAMkAGI2') }],
    actions: [
      { id: 'send-email', name: 'Send email', description: 'Send an email.', inputs: PORTS.anyIn, fields: [FIELDS.text('to', 'To', 'eng-leads@acme.com', true), FIELDS.template('subject', 'Subject', '{{issue.title}}'), FIELDS.template('body', 'Body', '{{run.summary}}\n\n{{run.prUrl}}')] },
      { id: 'send-run-report', name: 'Send run report', description: 'Email how a finished run went.', inputs: PORTS.runIn, fields: [FIELDS.text('to', 'To', 'eng-leads@acme.com', true), FIELDS.template('subject', 'Subject', '{{run.status}}: {{issue.title}}'), FIELDS.template('body', 'Body', '{{run.summary}}')] },
    ],
  }),
];
