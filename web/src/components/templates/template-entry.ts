import { getConnector, type Connector } from '@/lib/connectors';
import type { Brand } from '@/lib/brand';
import { describeWorkflow, type WorkflowDescription } from '@/lib/workflow/describe';
import type { Workflow } from '@/lib/workflow/schema';
import { readiness, type Readiness } from '@/lib/workflow/readiness';
import { instantiateTemplate, TEMPLATE_JOBS, TEMPLATES, type TemplateJob, type TemplateMeta } from '@/lib/workflow/templates';

/** A template with a sample copy of its graph, for previews. "Use" instantiates a fresh copy. */
export interface TemplateEntry {
  meta: TemplateMeta;
  workflow: Workflow;
  description: WorkflowDescription;
  /** The template's connectors, apps first and built-in nodes after. */
  connectors: Connector[];
  /** What running it for real looks like today. */
  readiness: Readiness;
}

export function buildTemplateEntries(brand: Brand): TemplateEntry[] {
  const entries: TemplateEntry[] = [];
  for (const meta of TEMPLATES) {
    const workflow = instantiateTemplate(meta.id, brand);
    if (workflow === undefined) continue;
    const connectors = meta.connectors
      .map((id) => getConnector(id))
      .filter((connector): connector is Connector => connector !== undefined)
      .sort((a, b) => Number(a.category === 'core') - Number(b.category === 'core'));
    entries.push({ meta, workflow, description: describeWorkflow(workflow), connectors, readiness: readiness(workflow) });
  }
  return entries;
}

/** The jobs templates are grouped by, with how many templates each has, in the order the page shows them. */
export function templateJobs(entries: TemplateEntry[]): Array<{ job: TemplateJob; label: string; count: number }> {
  return TEMPLATE_JOBS.map((entry) => ({ ...entry, count: entries.filter((template) => template.meta.job === entry.job).length })).filter((entry) => entry.count > 0);
}
