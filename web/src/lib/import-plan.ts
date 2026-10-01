import { useStudio, type ImportPlan } from './store';
import type { Connection, Run, Workflow } from './workflow/schema';

/**
 * Reads a file somebody chose to import and works out what bringing it in
 * would do — before anything changes. Every workflow and run is checked
 * against the same schema the server uses, because a file is data from
 * somewhere else: one malformed node in the store would break every screen
 * that draws it, on this load and every later one.
 *
 * The schemas are loaded here, on demand, so the validator is not part of
 * every page.
 */
export async function inspectImport(payload: unknown): Promise<{ ok: true; plan: ImportPlan } | { ok: false; message: string }> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, message: 'Not a JSON object.' };
  const data = payload as Record<string, unknown>;
  const { workflowSchema, drawableRunSchema, describeZodError } = await import('./workflow/shape');
  const state = useStudio.getState();

  // A single exported workflow bundle.
  if (data['workflow'] !== undefined && data['workflow'] !== null && typeof data['workflow'] === 'object') {
    const parsed = workflowSchema.safeParse(data['workflow']);
    if (!parsed.success) return { ok: false, message: `The workflow in this file cannot be used. ${describeZodError(parsed.error)}` };
    const workflow = parsed.data as unknown as Workflow;
    return { ok: true, plan: { kind: 'workflow', workflows: [workflow], runs: [], connections: {}, clashes: state.workflows[workflow.id] === undefined ? [] : [workflow.id], newRuns: 0, rejected: 0 } };
  }

  if (data['workflows'] !== undefined && data['workflows'] !== null && typeof data['workflows'] === 'object') {
    const candidates = Array.isArray(data['workflows']) ? data['workflows'] : Object.values(data['workflows']);
    let rejected = 0;
    const workflows: Workflow[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const parsed = workflowSchema.safeParse(candidate);
      if (!parsed.success || seen.has(parsed.data.id)) {
        rejected += 1;
        continue;
      }
      seen.add(parsed.data.id);
      workflows.push(parsed.data as unknown as Workflow);
    }
    if (workflows.length === 0) {
      return { ok: false, message: candidates.length === 0 ? 'This export has no workflows in it.' : 'None of the workflows in this file are in a shape the studio can use.' };
    }
    const runs: Run[] = [];
    for (const candidate of Array.isArray(data['runs']) ? data['runs'] : []) {
      const parsed = drawableRunSchema.safeParse(candidate);
      if (parsed.success) runs.push(parsed.data as unknown as Run);
      else rejected += 1;
    }
    const known = new Set(state.runs.map((run) => run.id));
    const connections: Record<string, Connection> = {};
    if (data['connections'] !== null && typeof data['connections'] === 'object' && !Array.isArray(data['connections'])) {
      for (const [id, value] of Object.entries(data['connections'] as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object') continue;
        const connection = value as Partial<Connection>;
        // Markers only: a credential never leaves the server that holds it, so a file cannot carry a real connection.
        if (connection.credential !== undefined || typeof connection.account !== 'string') continue;
        connections[id] = { connectorId: id, status: 'connected', account: connection.account.slice(0, 200), connectedAt: typeof connection.connectedAt === 'string' ? connection.connectedAt : new Date().toISOString(), mock: true };
      }
    }
    return {
      ok: true,
      plan: {
        kind: 'workspace',
        workflows,
        runs,
        connections,
        clashes: workflows.filter((workflow) => state.workflows[workflow.id] !== undefined).map((workflow) => workflow.id),
        newRuns: runs.filter((run) => !known.has(run.id)).length,
        rejected,
      },
    };
  }

  return { ok: false, message: 'Unrecognised file. Expected a workflow from Export in the builder, or a full studio export.' };
}
