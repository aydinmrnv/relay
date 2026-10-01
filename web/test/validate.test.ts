import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRAND } from '@/lib/brand';
import { isRepository, type Workflow } from '@/lib/workflow/schema';
import { instantiateTemplate } from '@/lib/workflow/templates';
import { validateWorkflow } from '@/lib/workflow/validate';

function template(id: string): Workflow {
  const workflow = instantiateTemplate(id, BRAND, 'acme/api');
  assert.ok(workflow, `template ${id} exists`);
  return workflow;
}

test('a repository is owner/name, and nothing else', () => {
  for (const good of ['acme/api', 'a-b/c.d_e', ' acme/api ']) assert.ok(isRepository(good), good);
  for (const bad of ['', 'acme', 'acme/api/x', 'https://github.com/acme/api', 'acme_org/api', 'acme/ api', undefined, null]) assert.ok(!isRepository(bad), String(bad));
});

test('an agent the CLI does not ship is a warning, not a silent promise', () => {
  const workflow = template('label-run');
  const pipeline = workflow.nodes.find((node) => node.data.typeId === 'pipeline.action.run');
  assert.ok(pipeline, 'the template has a pipeline');
  assert.ok(!validateWorkflow(workflow).issues.some((issue) => issue.message.includes('not built into')));
  pipeline.data.config['implementer'] = 'gemini';
  const issue = validateWorkflow(workflow).issues.find((entry) => entry.message.includes('not built into'));
  assert.ok(issue, 'choosing Gemini is flagged');
  assert.equal(issue.level, 'warning');
  assert.match(issue.hint ?? '', /harness named gemini/);
});
