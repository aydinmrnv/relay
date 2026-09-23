import { getConnector, type Connector } from '@/lib/connectors';
import type { Brand } from '@/lib/brand';
import { describeWorkflow, type WorkflowDescription } from '@/lib/workflow/describe';
import type { Workflow } from '@/lib/workflow/schema';
import { instantiateTemplate, TEMPLATES, type TemplateMeta } from '@/lib/workflow/templates';

/** A template with a sample copy of its graph, for previews. "Use" instantiates a fresh copy. */
export interface TemplateEntry {
  meta: TemplateMeta;
  workflow: Workflow;
  description: WorkflowDescription;
  /** The template's connectors, apps first and built-in nodes after. */
  connectors: Connector[];
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
    entries.push({ meta, workflow, description: describeWorkflow(workflow), connectors });
  }
  return entries;
}

/** Tags by how many templates use them, most common first. */
export function templateTags(entries: TemplateEntry[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) for (const tag of entry.meta.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
