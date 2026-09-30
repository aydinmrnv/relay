/**
 * The apps that connect for real: the studio checks the credential with the
 * app and keeps it encrypted on its server. Everything else in the catalog
 * can only be marked ready for now.
 *
 * The first ones are webhook URLs, as docs/design/workflow-execution.md
 * decided: a Slack incoming webhook or a Discord webhook can post to one
 * channel and do nothing else, so holding one puts little at risk. Shared by
 * the browser (the connect form) and the server (checking and storing).
 */
import type { CredentialKind } from '@/lib/workflow/schema';

export interface CredentialSpec {
  kind: CredentialKind;
  connectorId: string;
  /** What the person pastes, e.g. "Incoming webhook". */
  name: string;
  /** The same in a sentence: "an incoming webhook". */
  noun: string;
  input: {
    label: string;
    placeholder: string;
    pattern: RegExp;
    /** Said under the field when what was pasted is not the right shape. */
    mismatch: string;
  };
  /** An optional name for the connection, shown on cards and in the builder. */
  label: { label: string; placeholder: string; help: string };
  /** Where to get it, one short step each. */
  steps: string[];
  setup: { label: string; href: string };
  /** What the credential can do, and what it cannot, in a sentence or two. */
  scope: string;
  /** The app's actions this credential can carry out. The rest need a full sign-in. */
  actions: string[];
  /** Said about the actions it covers, when there is a catch. */
  caveat?: string;
}

export const CREDENTIAL_SPECS: CredentialSpec[] = [
  {
    kind: 'slack-webhook',
    connectorId: 'slack',
    name: 'Incoming webhook',
    noun: 'an incoming webhook',
    input: {
      label: 'Webhook URL',
      placeholder: 'https://hooks.slack.com/services/T…/B…/…',
      pattern: /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/,
      mismatch: 'A Slack incoming webhook starts with https://hooks.slack.com/services/ and has three parts after it.',
    },
    label: { label: 'Channel', placeholder: '#eng-updates', help: 'Which channel it posts to, so you can tell it apart. Slack does not say.' },
    steps: [
      'Open your Slack apps and create one “From scratch” in your workspace, or pick one you already have.',
      'Under Incoming Webhooks, switch them on, press “Add New Webhook” and choose the channel.',
      'Copy the webhook URL and paste it below.',
    ],
    setup: { label: 'Open Slack apps', href: 'https://api.slack.com/apps?new_app=1' },
    scope: 'It posts to the one channel you chose and does nothing else: it cannot read messages or see who is in the workspace. Remove it in Slack at any time.',
    actions: ['post-message', 'share-pr', 'post-run-summary'],
    caveat: 'A webhook always posts to the channel it was made for, so the Channel setting on these steps is not used.',
  },
  {
    kind: 'discord-webhook',
    connectorId: 'discord',
    name: 'Channel webhook',
    noun: 'a channel webhook',
    input: {
      label: 'Webhook URL',
      placeholder: 'https://discord.com/api/webhooks/…/…',
      pattern: /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{15,25}\/[\w-]{20,100}$/,
      mismatch: 'A Discord webhook looks like https://discord.com/api/webhooks/ followed by a number and a token.',
    },
    label: { label: 'Channel', placeholder: '#dev-updates', help: 'Optional. Left empty, the connection takes the webhook’s own name.' },
    steps: [
      'In Discord, open the channel’s settings (the gear by its name), then Integrations → Webhooks.',
      'Press “New Webhook”. Its name is who the messages come from.',
      'Press “Copy Webhook URL” and paste it below.',
    ],
    setup: { label: 'Discord’s guide', href: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks' },
    scope: 'It posts to that one channel under the webhook’s name, and cannot read messages or act as a member. Delete it in the channel’s settings at any time.',
    actions: ['send-message', 'send-embed', 'share-pr'],
    caveat: 'A webhook always posts to the channel it was made for, so the Channel setting on these steps is not used.',
  },
];

const BY_CONNECTOR = new Map(CREDENTIAL_SPECS.map((spec) => [spec.connectorId, spec]));
const BY_KIND = new Map(CREDENTIAL_SPECS.map((spec) => [spec.kind, spec]));

/** How this app connects for real, or undefined when it can only be marked ready. */
export function credentialSpec(connectorId: string): CredentialSpec | undefined {
  return BY_CONNECTOR.get(connectorId);
}

export function credentialSpecByKind(kind: CredentialKind): CredentialSpec | undefined {
  return BY_KIND.get(kind);
}

/** The last four characters, to recognise a credential by without showing it. */
export function credentialHint(secret: string): string {
  return secret.slice(-4);
}
