import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactForSharing, scrubText } from '@/lib/workflow/redact';
import type { Workflow } from '@/lib/workflow/schema';

const now = new Date(0).toISOString();

function workflow(extra: Record<string, unknown> = {}): Workflow {
  return {
    id: 'wf_1',
    name: 'Fix bugs for alice@example.com',
    description: 'Runs on https://internal.example.com/board for @alice, token ghp_abcdefghijklmnop',
    nodes: [
      {
        id: 'n1',
        type: 'wf',
        position: { x: 1, y: 2 },
        data: {
          typeId: 'slack.action.post-message',
          label: 'Ping @bob at bob@example.com',
          config: { channel: '#eng', text: 'done', webhookUrl: 'https://hooks.slack.com/services/T/B/X', madeUp: 'sk_live_secretsecret' },
          internalNote: 'call 555 0100',
        },
      },
    ],
    edges: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    repository: 'acme/secret-repo',
    ...extra,
  } as Workflow;
}

test('free text keeps what it says and loses links, addresses, credentials and people', () => {
  assert.equal(scrubText('See https://example.com/x?y=1 and www.example.org.'), 'See [link] and [link]');
  assert.equal(scrubText('Mail alice@example.com'), 'Mail [email]');
  assert.equal(scrubText('ask @alice, then @acme/platform'), 'ask @someone, then @someone');
  assert.equal(scrubText('key ghp_abcdefghijklmnop here'), 'key [secret] here');
  assert.equal(scrubText('Fix the flaky retry test'), 'Fix the flaky retry test');
});

test('the name, the description and node labels are scrubbed, not published as written', () => {
  const shared = redactForSharing(workflow());
  const everything = JSON.stringify(shared);
  for (const leaked of ['alice@example.com', 'bob@example.com', 'internal.example.com', 'ghp_abcdefghijklmnop', '@alice', '@bob', 'acme/secret-repo']) {
    assert.ok(!everything.includes(leaked), `${leaked} is not in the public copy`);
  }
  assert.equal(shared.name, 'Fix bugs for [email]');
});

test('keys nobody defined are left behind, on the workflow, the node and its settings', () => {
  const shared = redactForSharing(workflow({ ownerNote: 'private', exportedAt: now, demo: true }));
  const everything = JSON.stringify(shared);
  for (const leaked of ['ownerNote', 'internalNote', '555 0100', 'madeUp', 'sk_live_secretsecret', 'hooks.slack.com', 'exportedAt']) {
    assert.ok(!everything.includes(leaked), `${leaked} is not in the public copy`);
  }
  assert.deepEqual(shared.nodes[0]!.data.config, { channel: '#eng', text: 'done' });
});
