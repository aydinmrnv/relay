/**
 * Connector catalog types.
 *
 * A connector is one external app (GitHub, Slack, Xcode, YouTube…). It exposes
 * triggers (things that can start a workflow) and actions (things a workflow can
 * do). Every trigger and action becomes a draggable node in the builder, so the
 * shape here is deliberately UI-friendly: human names, one-line descriptions,
 * typed ports, and a small field schema the inspector renders as a form.
 */

export type ConnectorCategory =
  | 'source-control'
  | 'issues'
  | 'chat'
  | 'email'
  | 'calendar'
  | 'docs'
  | 'design'
  | 'ci-cd'
  | 'apple'
  | 'android'
  | 'hosting'
  | 'databases'
  | 'observability'
  | 'analytics'
  | 'feature-flags'
  | 'ai'
  | 'registries'
  | 'security'
  | 'support'
  | 'crm'
  | 'payments'
  | 'social'
  | 'video'
  | 'productivity'
  | 'meetings'
  | 'forms'
  | 'testing'
  | 'storage'
  | 'auth'
  | 'feedback'
  | 'cms'
  | 'devtools'
  | 'local'
  | 'core';

export const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  'source-control': 'Source control',
  issues: 'Issue tracking',
  chat: 'Chat',
  email: 'Email',
  calendar: 'Calendar',
  docs: 'Docs & wikis',
  design: 'Design',
  'ci-cd': 'CI / CD',
  apple: 'Apple',
  android: 'Android',
  hosting: 'Hosting & cloud',
  databases: 'Databases',
  observability: 'Observability',
  analytics: 'Analytics',
  'feature-flags': 'Feature flags',
  ai: 'AI & agents',
  registries: 'Package registries',
  security: 'Security',
  support: 'Support',
  crm: 'CRM & sales',
  payments: 'Payments & commerce',
  social: 'Social',
  video: 'Video & media',
  productivity: 'Productivity',
  meetings: 'Meetings',
  forms: 'Forms',
  testing: 'Testing',
  storage: 'Storage',
  auth: 'Auth & identity',
  feedback: 'Feedback',
  cms: 'CMS',
  devtools: 'Developer tools',
  local: 'Local machine',
  core: 'Core',
};

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
