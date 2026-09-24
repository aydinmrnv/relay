/**
 * What the server accepts. The studio's types are the real contract; these
 * schemas check just enough of each shape — ids, sizes, the fields the
 * server reads — to keep a malformed or hostile request out of the
 * database, and let everything else through unchanged.
 */
import * as z from 'zod';
import type { Run, Workflow } from '@/lib/workflow/schema';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, 'An id may only contain letters, digits, _ and -.');
const isoDate = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), 'Not a date.');

export const WORKFLOW_MAX_BYTES = 1_000_000;
export const RUN_MAX_BYTES = 600_000;
export const WORKSPACE_MAX_BYTES = 200_000;
export const IMPORT_MAX_BYTES = 8_000_000;

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

export const workspacePatchSchema = z.object({
  settings: z.record(z.string(), z.unknown()).optional(),
  brand: z.object({ name: z.string().max(60), tagline: z.string().max(300), slug: z.string().max(60), glyph: z.string().max(8) }).optional(),
  connections: z.record(z.string().max(80), z.record(z.string(), z.unknown())).optional(),
  toursSeen: z.record(z.string().max(80), z.boolean()).optional(),
  checklistDismissed: z.boolean().optional(),
});

export const onboardingSchema = z.object({
  role: z.string().max(40).optional(),
  sources: z.array(z.string().max(80)).max(30).optional(),
  destinations: z.array(z.string().max(80)).max(30).optional(),
  agents: z.string().max(40).optional(),
  review: z.string().max(40).optional(),
  repository: z.string().max(200).optional(),
  firstWorkflow: z.string().max(40).optional(),
});

export const importSchema = z.object({
  workflows: z.array(z.unknown()).max(200),
  runs: z.array(z.unknown()).max(500).optional(),
});

export type OnboardingAnswers = z.infer<typeof onboardingSchema>;

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
