import * as z from 'zod';
import { ApiError, describeForLog, json, readJson, withUser } from '@/server/api';
import { LIMITS } from '@/server/rate-limit';
import { countWorkflows, existingWorkflowIds, MAX_WORKFLOWS, saveRuns, saveWorkflow } from '@/server/studio';
import { describeZodError, IMPORT_MAX_BYTES, importSchema, parseRun, parseWorkflow, RUN_MAX_BYTES, WORKFLOW_MAX_BYTES } from '@/server/validate';
import type { Run } from '@/lib/workflow/schema';

/**
 * Brings work made before signing in — or a downloaded export — into the
 * account. Each item is checked on its own, against the same shape and the
 * same size limit as a single save, so one bad workflow does not sink the
 * rest and an import is not a way around the limits; the answer says what
 * was skipped, in words that are safe to show.
 */
export async function POST(request: Request) {
  return withUser(
    request,
    async (user) => {
      const parsed = importSchema.safeParse(await readJson(request, IMPORT_MAX_BYTES));
      if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
      let workflows = 0;
      const revisions: Record<string, string> = {};
      const skipped: string[] = [];
      let room = MAX_WORKFLOWS - (await countWorkflows(user.id));
      const candidates = parsed.data.workflows.flatMap((raw) => {
        try {
          if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > WORKFLOW_MAX_BYTES) throw new ApiError(413, 'TOO_LARGE', `larger than ${Math.round(WORKFLOW_MAX_BYTES / 1024)} KB`);
          return [parseWorkflow(raw)];
        } catch (error) {
          skipped.push(describe(raw, error));
          return [];
        }
      });
      const already = await existingWorkflowIds(user.id, candidates.map((workflow) => workflow.id));
      for (const workflow of candidates) {
        if (!already.has(workflow.id) && room <= 0) {
          skipped.push(`${workflow.name}: an account can hold ${MAX_WORKFLOWS} workflows`);
          continue;
        }
        try {
          revisions[workflow.id] = (await saveWorkflow(user.id, workflow, { baseRevision: null, force: true })).revision;
          workflows += 1;
          if (!already.has(workflow.id)) room -= 1;
        } catch (error) {
          // A full account stops the import; nothing after this would fit either.
          if (error instanceof ApiError && error.code === 'ACCOUNT_FULL') throw error;
          skipped.push(describe(workflow, error));
        }
      }
      const runs: Run[] = [];
      const seen = new Set<string>();
      for (const raw of parsed.data.runs ?? []) {
        try {
          if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > RUN_MAX_BYTES) throw new ApiError(413, 'TOO_LARGE', `larger than ${Math.round(RUN_MAX_BYTES / 1024)} KB`);
          const run = parseRun(raw);
          if (seen.has(run.id)) continue;
          seen.add(run.id);
          runs.push(run);
        } catch (error) {
          skipped.push(describe(raw, error));
        }
      }
      try {
        await saveRuns(user.id, runs);
      } catch (error) {
        console.error('[import] runs could not be saved:', describeForLog(error));
        skipped.push(`${runs.length} ${runs.length === 1 ? 'run' : 'runs'}: could not be saved`);
        runs.length = 0;
      }
      return json({ ok: true, workflows, runs: runs.length, skipped, revisions });
    },
    { limit: LIMITS.import },
  );
}

/** Why an item was skipped, for the person. Never the database's own words: those carry the statement and the row. */
function describe(raw: unknown, error: unknown): string {
  const name = typeof raw === 'object' && raw !== null && typeof (raw as { name?: unknown }).name === 'string' ? (raw as { name: string }).name.slice(0, 80) : 'An item';
  if (error instanceof z.ZodError) return `${name}: ${describeZodError(error)}`;
  if (error instanceof ApiError) return `${name}: ${error.message}`;
  console.error('[import] an item could not be saved:', describeForLog(error));
  return `${name}: could not be saved`;
}
