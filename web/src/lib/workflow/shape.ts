/**
 * The shape of a workflow and of a run, as data that came from somewhere
 * else: a request to the server, or a file somebody chose to import. The
 * studio's types are the real contract; these schemas check just enough of
 * each shape — ids, sizes, the fields the code reads without asking — to
 * keep a malformed or hostile document out, and let everything else through
 * unchanged.
 */
import * as z from 'zod';
import type { Run, Workflow } from './schema';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, 'An id may only contain letters, digits, _ and -.');
const isoDate = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), 'Not a date.');

export const workflowSchema = z.looseObject({
  id,
  name: z.string().max(200),
  description: z.string().max(10_000).default(''),
  nodes: z
    .array(
      z.looseObject({
        id: z.string().min(1).max(80),
        type: z.literal('wf'),
        position: z.object({ x: z.number().finite(), y: z.number().finite() }),
        data: z.looseObject({ typeId: z.string().min(1).max(200), config: z.record(z.string(), z.unknown()) }),
      }),
    )
    .max(400),
  edges: z
    .array(
      z.looseObject({
        id: z.string().min(1).max(80),
        source: z.string().min(1).max(80),
        target: z.string().min(1).max(80),
      }),
    )
    .max(1500),
  enabled: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const runSchema = z.looseObject({
  id,
  shortId: z.string().max(40),
  workflowId: id,
  workflowName: z.string().max(200),
  status: z.enum(['running', 'succeeded', 'failed', 'refused', 'cancelled', 'waiting']),
  startedAt: isoDate,
  events: z.array(z.unknown()).max(5000),
  costUsd: z.number().finite(),
});

/**
 * What the screens read from a run without checking. The server stores a run
 * as it is given; a browser that imports one has to be able to draw it.
 */
export const drawableRunSchema = runSchema.extend({
  trigger: z.looseObject({ typeId: z.string(), connectorId: z.string(), label: z.string(), payload: z.record(z.string(), z.unknown()) }),
  events: z.array(z.looseObject({ at: isoDate, kind: z.string(), message: z.string() })).max(5000),
  nodeStatus: z.record(z.string(), z.string()),
  phases: z.array(z.looseObject({ phase: z.string(), label: z.string(), ms: z.number().finite() })),
});

export function parseWorkflow(value: unknown): Workflow {
  return workflowSchema.parse(value) as unknown as Workflow;
}

export function parseRun(value: unknown): Run {
  return runSchema.parse(value) as unknown as Run;
}

/** A readable one-liner from a zod failure, for the toast the studio shows. */
export function describeZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return 'The data is not in the expected shape.';
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${path}${first.message}`;
}
