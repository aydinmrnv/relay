/**
 * What the server accepts. The studio's types are the real contract; these
 * schemas check just enough of each shape — ids, sizes, the fields the
 * server reads — to keep a malformed or hostile request out of the
 * database, and let everything else through unchanged.
 */
import * as z from 'zod';
import { describeZodError, parseRun, parseWorkflow, runSchema, workflowSchema } from '@/lib/workflow/shape';

export { describeZodError, parseRun, parseWorkflow, runSchema, workflowSchema };

export const WORKFLOW_MAX_BYTES = 1_000_000;
export const RUN_MAX_BYTES = 600_000;
export const WORKSPACE_MAX_BYTES = 200_000;
/** Under what a serverless host accepts in one request (Vercel: 4.5 MB). A larger import is sent in several. */
export const IMPORT_MAX_BYTES = 4_000_000;

export const workspacePatchSchema = z.object({
  settings: z.record(z.string(), z.unknown()).optional(),
  // Accepted and ignored: a browser still running an older build sends the name it once let people change.
  brand: z.unknown().optional(),
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
  runner: z.string().max(40).optional(),
});

export const importSchema = z.object({
  workflows: z.array(z.unknown()).max(200),
  runs: z.array(z.unknown()).max(500).optional(),
});

export type OnboardingAnswers = z.infer<typeof onboardingSchema>;
