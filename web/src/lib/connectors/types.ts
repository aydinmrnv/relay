/**
 * Connector catalog types.
 *
 * A connector is one external app (GitHub, Slack, Sentry…). It exposes
 * triggers (things that can start a workflow) and actions (things a workflow can
 * do). Every trigger and action becomes a draggable node in the builder, so the
 * shape here is deliberately UI-friendly: human names, one-line descriptions,
 * typed ports, and a small field schema the inspector renders as a form.
 */

export type ConnectorCategory =
  | 'issues'
  | 'source-control'
  | 'design'
  | 'ci-cd'
  | 'hosting'
  | 'observability'
  | 'testing'
  | 'security'
  | 'feature-flags'
  | 'support'
  | 'chat'
  | 'email'
  | 'core';

export const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  issues: 'Issue tracking',
  'source-control': 'Source control',
  design: 'Design handoff',
  'ci-cd': 'CI',
  hosting: 'Deploys',
  observability: 'Errors & crashes',
  testing: 'Tests',
  security: 'Security',
  'feature-flags': 'Feature flags',
  support: 'Support',
  chat: 'Chat',
  email: 'Email',
  core: 'Core',
};

/**
 * What an app is for in a coding-agent workflow, which is how the Integrations
 * page groups them. An app is in the catalog because it is one of these, not
 * because it has an API.
 */
export type ConnectorJob = 'work' | 'breaks' | 'upkeep' | 'people' | 'core';

export const JOBS: Array<{ job: ConnectorJob; label: string; description: string; categories: ConnectorCategory[] }> = [
  { job: 'work', label: 'Where work is asked for', description: 'Tickets and design handoffs that start a run, and where its pull request gets recorded.', categories: ['issues', 'source-control', 'design'] },
  { job: 'breaks', label: 'When something breaks', description: 'A red build, a failed deploy, a new crash: failures an agent can often fix before anyone looks.', categories: ['ci-cd', 'hosting', 'observability', 'testing'] },
  { job: 'upkeep', label: 'Security and upkeep', description: 'Chores nobody schedules: vulnerable code, flags that finished rolling out.', categories: ['security', 'feature-flags'] },
  { job: 'people', label: 'Requests from people', description: 'Customers and teammates asking for a fix, and the places they hear back.', categories: ['support', 'chat', 'email'] },
  { job: 'core', label: 'Built in', description: 'The pipeline, guardrails, delivery and the glue between them.', categories: ['core'] },
];

export function jobOf(category: ConnectorCategory): ConnectorJob {
  return JOBS.find((entry) => entry.categories.includes(category))?.job ?? 'core';
}

/** How a connection is established. `local` means "runs on the user's machine", `none` means no auth at all. */
export type AuthKind = 'oauth' | 'api-key' | 'token' | 'app' | 'local' | 'none';

export type FieldType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'multiselect' | 'secret' | 'json' | 'template';

export interface FieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  default?: unknown;
  options?: FieldOption[];
  placeholder?: string;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
}

/**
 * Port types. A connection is allowed when the source and target types match
 * or either side is `any`. `issue` is a ticket-shaped payload, `run` is a
 * finished pipeline run, `change` is a branch / PR, `message` is text meant
 * for a person, `event` is a generic "this happened".
 */
export type PortType = 'event' | 'issue' | 'run' | 'change' | 'message' | 'any';

export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
}

export interface TriggerSpec {
  id: string;
  name: string;
  description: string;
  /** Defaults to a single `event` output. */
  outputs?: PortSpec[];
  fields?: FieldSpec[];
  /** Example payload the simulator emits and the inspector shows. */
  sample?: Record<string, unknown>;
}

export interface ActionSpec {
  id: string;
  name: string;
  description: string;
  /** Defaults to a single `any` input. */
  inputs?: PortSpec[];
  /** Defaults to a single `event` output. */
  outputs?: PortSpec[];
  fields?: FieldSpec[];
}

export interface ConnectorIcon {
  /** A `react-icons/si` export name, e.g. `SiGithub`. Omit when Simple Icons has no mark for the brand. */
  si?: string;
  /** A `lucide-react` export name used when `si` is absent, e.g. `Youtube`. */
  lucide?: string;
  /** Brand colour as a hex string. Used for node accents and the fallback monogram. */
  color: string;
}

export interface Connector {
  id: string;
  name: string;
  category: ConnectorCategory;
  description: string;
  auth: AuthKind;
  icon: ConnectorIcon;
  docsUrl?: string;
  tags?: string[];
  /**
   * What teams use this app for with coding agents, one situation per line:
   * "A red build on main gets a fix PR before anyone looks." The reason the
   * app is in the catalog, in the words a person would search for.
   */
  uses: string[];
  triggers: TriggerSpec[];
  actions: ActionSpec[];
  /** Shown first in the palette and on the landing page. */
  popular?: boolean;
}

export const DEFAULT_TRIGGER_OUTPUTS: PortSpec[] = [{ id: 'out', label: 'Event', type: 'event' }];
export const DEFAULT_ACTION_INPUTS: PortSpec[] = [{ id: 'in', label: 'In', type: 'any' }];
export const DEFAULT_ACTION_OUTPUTS: PortSpec[] = [{ id: 'out', label: 'Done', type: 'event' }];

/** Fills port defaults so catalog files can stay terse. */
export function defineConnector(connector: Connector): Connector {
  return {
    ...connector,
    triggers: connector.triggers.map((trigger) => ({ ...trigger, outputs: trigger.outputs ?? DEFAULT_TRIGGER_OUTPUTS })),
    actions: connector.actions.map((action) => ({
      ...action,
      inputs: action.inputs ?? DEFAULT_ACTION_INPUTS,
      outputs: action.outputs ?? DEFAULT_ACTION_OUTPUTS,
    })),
  };
}

/** Common port shapes, exported so catalog files reuse the same ids. */
export const PORTS = {
  issueOut: [{ id: 'issue', label: 'Issue', type: 'issue' }] as PortSpec[],
  issueIn: [{ id: 'issue', label: 'Issue', type: 'issue' }] as PortSpec[],
  runIn: [{ id: 'run', label: 'Run', type: 'run' }] as PortSpec[],
  runOut: [{ id: 'run', label: 'Run', type: 'run' }] as PortSpec[],
  changeIn: [{ id: 'change', label: 'Change', type: 'change' }] as PortSpec[],
  changeOut: [{ id: 'change', label: 'Change', type: 'change' }] as PortSpec[],
  messageIn: [{ id: 'message', label: 'Message', type: 'message' }] as PortSpec[],
  anyIn: DEFAULT_ACTION_INPUTS,
  eventOut: DEFAULT_TRIGGER_OUTPUTS,
} as const;

/** Reusable fields so the same knob reads the same everywhere. */
export const FIELDS = {
  template: (key: string, label: string, def: string, help?: string): FieldSpec => ({
    key,
    label,
    type: 'template',
    default: def,
    ...(help === undefined ? {} : { help }),
    placeholder: 'Supports {{issue.title}}, {{run.prUrl}}, {{run.cost}}…',
  }),
  text: (key: string, label: string, placeholder?: string, required = false): FieldSpec => ({
    key,
    label,
    type: 'text',
    required,
    ...(placeholder === undefined ? {} : { placeholder }),
  }),
  bool: (key: string, label: string, def = false, help?: string): FieldSpec => ({
    key,
    label,
    type: 'boolean',
    default: def,
    ...(help === undefined ? {} : { help }),
  }),
  select: (key: string, label: string, options: FieldOption[], def?: string): FieldSpec => ({
    key,
    label,
    type: 'select',
    options,
    default: def ?? options[0]?.value,
  }),
  number: (key: string, label: string, def: number, min?: number, max?: number, step?: number): FieldSpec => ({
    key,
    label,
    type: 'number',
    default: def,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(step === undefined ? {} : { step }),
  }),
};

/**
 * A trigger's sample payload: the task the agents would be handed. The body
 * carries the evidence (the failing log, the stack trace, the advisory), so a
 * test run shows exactly what a real one would start from.
 */
export function taskSample(id: string, title: string, url: string, body: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title, url, body, ...extra };
}
