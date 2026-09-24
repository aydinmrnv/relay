import * as z from 'zod';
import { ApiError, json, readJson, withUser } from '@/server/api';
import { saveRun, saveWorkflow } from '@/server/studio';
import { describeZodError, IMPORT_MAX_BYTES, importSchema, parseRun, parseWorkflow } from '@/server/validate';

/**
 * Brings work made before signing in — or a downloaded export — into the
 * account. Each item is checked on its own, so one bad workflow does not
 * sink the rest; the answer says what was skipped.
 */
export async function POST(request: Request) {
  return withUser(request, async (user) => {
    const parsed = importSchema.safeParse(await readJson(request, IMPORT_MAX_BYTES));
    if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
    let workflows = 0;
    let runs = 0;
    const revisions: Record<string, string> = {};
    const skipped: string[] = [];
    for (const raw of parsed.data.workflows) {
      try {
        const parsedWorkflow = parseWorkflow(raw);
        revisions[parsedWorkflow.id] = (await saveWorkflow(user.id, parsedWorkflow, { baseRevision: null, force: true })).revision;
        workflows += 1;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'TOO_MANY_WORKFLOWS') throw error;
        skipped.push(describe(raw, error));
      }
    }
    for (const raw of parsed.data.runs ?? []) {
      try {
        await saveRun(user.id, parseRun(raw));
        runs += 1;
      } catch (error) {
        skipped.push(describe(raw, error));
      }
    }
    return json({ ok: true, workflows, runs, skipped, revisions });
  });
}

function describe(raw: unknown, error: unknown): string {
  const name = typeof raw === 'object' && raw !== null && typeof (raw as { name?: unknown }).name === 'string' ? (raw as { name: string }).name : 'An item';
  return `${name}: ${error instanceof z.ZodError ? describeZodError(error) : error instanceof Error ? error.message : 'could not be saved'}`;
}
