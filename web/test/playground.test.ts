import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRAND } from '@/lib/brand';
import { openPlayground, PLAYGROUND_TEMPLATE, playgroundGate, playgroundTemplate, untouchedExample } from '@/lib/playground';
import { isStudioPath } from '@/lib/studio-routes';
import type { Workflow } from '@/lib/workflow/schema';

test('a first visit opens a fresh copy of the starting template', () => {
  const opening = openPlayground({ owner: null, workflows: {} }, null, BRAND);
  assert.ok(opening !== null);
  assert.equal(opening.created, true);
  assert.equal(opening.workflow.templateId, PLAYGROUND_TEMPLATE);
  assert.ok(opening.workflow.nodes.length > 0);
  // An example nobody changed: not offered for import when the visitor makes an account.
  assert.equal(untouchedExample(opening.workflow), true);
});

test('a return visit opens what was there, and makes nothing new', () => {
  const first = openPlayground({ owner: null, workflows: {} }, null, BRAND);
  assert.ok(first !== null);
  const workflows = { [first.workflow.id]: first.workflow };
  const again = openPlayground({ owner: null, workflows }, first.workflow.id, BRAND);
  assert.deepEqual(again, { workflow: first.workflow, created: false });
});

test('a remembered workflow that is gone starts from the template again', () => {
  const opening = openPlayground({ owner: null, workflows: {} }, 'wf_deleted', BRAND);
  assert.equal(opening?.created, true);
});

test('nothing is ever added to a store that belongs to an account', () => {
  const template = playgroundTemplate(PLAYGROUND_TEMPLATE, BRAND) as Workflow;
  assert.equal(openPlayground({ owner: 'user_1', workflows: {} }, null, BRAND), null);
  assert.equal(openPlayground({ owner: 'user_1', workflows: { [template.id]: template } }, template.id, BRAND), null);
});

test('an edited example is the visitor’s own work', () => {
  const template = playgroundTemplate(PLAYGROUND_TEMPLATE, BRAND) as Workflow;
  assert.equal(untouchedExample({ ...template, updatedAt: new Date(Date.parse(template.createdAt) + 1000).toISOString() }), false);
  assert.equal(untouchedExample({ ...template, demo: undefined }), false);
  assert.equal(playgroundTemplate('no-such-template', BRAND), undefined);
});

test('the playground opens for a signed-out browser without waiting for sign-in to load', () => {
  assert.equal(playgroundGate({ hydrated: false, owner: null, status: 'unknown' }), 'wait');
  assert.equal(playgroundGate({ hydrated: true, owner: null, status: 'unknown' }), 'open');
  assert.equal(playgroundGate({ hydrated: true, owner: null, status: 'guest' }), 'open');
});

test('someone signed in, or signing in, is kept out of it', () => {
  for (const status of ['loading', 'signed-in', 'unreachable'] as const) {
    assert.equal(playgroundGate({ hydrated: true, owner: null, status }), 'account', status);
    assert.equal(playgroundGate({ hydrated: true, owner: 'user_1', status }), 'account', status);
  }
  // The saved store names an account, and Clerk has not answered yet.
  assert.equal(playgroundGate({ hydrated: true, owner: 'user_1', status: 'unknown' }), 'wait');
});

test('with accounts off, the saved store is this browser’s own whoever it names', () => {
  assert.equal(playgroundGate({ hydrated: true, owner: null, status: 'disabled' }), 'open');
  assert.equal(playgroundGate({ hydrated: true, owner: 'user_1', status: 'disabled' }), 'open');
});

test('the playground is not one of the studio’s screens, so the proxy never turns it away', () => {
  assert.equal(isStudioPath('/play'), false);
  assert.equal(isStudioPath('/play/runs/run_1'), false);
  assert.equal(isStudioPath('/runs/run_1'), true);
});
