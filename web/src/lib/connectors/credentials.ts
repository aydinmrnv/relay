/**
 * The apps that connect for real: the studio checks the credential with the
 * app and keeps it encrypted on its server. Everything else in the catalog
 * can only be marked ready for now.
 *
 * Two kinds. A webhook URL (Slack, Discord), as docs/design/workflow-execution.md
 * decided first: it can post to one channel and do nothing else, so holding
 * one puts little at risk. And a key or token the app issues for its API,
 * for every app where one pasted value is the whole sign-in and the app has
 * an endpoint that says whose it is. Apps that need an OAuth app registered
 * with them, an app installed, several values or an address of their own are
 * not here yet. Shared by the browser (the connect form) and the server
 * (checking and storing); how each token is checked is the server's, in
 * `server/credentials/tokens.ts`.
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
  /**
   * A webhook only: the app's actions it can carry out, the rest needing a
   * full sign-in. Absent for a token, which is the app's sign-in: what it may
   * do is decided where it was made, and `scope` says so.
   */
  actions?: string[];
  /** Said about the actions it covers, when there is a catch. */
  caveat?: string;
}

/** A webhook posts to one place and can be sent a test message. A token signs in to the app's API and posts nowhere by itself. */
export function isWebhook(spec: Pick<CredentialSpec, 'kind'>): boolean {
  return spec.kind !== 'api-token';
}

/** No spaces, and long enough to be a secret. */
const TOKEN_SHAPE = /^[\w.~+/=:-]{16,400}$/;

/** The same, behind a prefix. Only for apps whose prefix has held for years, and never stricter than that about the rest. */
function prefixed(...prefixes: string[]): RegExp {
  return new RegExp(`^(?:${prefixes.join('|')})[\\w.~+/=:-]{16,400}$`);
}

interface TokenSpec {
  connectorId: string;
  /** What the app calls it, e.g. "Personal API key". */
  name: string;
  noun: string;
  placeholder?: string;
  pattern?: RegExp;
  mismatch?: string;
  steps: string[];
  setup: { label: string; href: string };
  scope: string;
}

function token(spec: TokenSpec): CredentialSpec {
  return {
    kind: 'api-token',
    connectorId: spec.connectorId,
    name: spec.name,
    noun: spec.noun,
    input: {
      label: spec.name,
      placeholder: spec.placeholder ?? 'Paste it here',
      pattern: spec.pattern ?? TOKEN_SHAPE,
      mismatch: spec.mismatch ?? `That does not look like ${spec.noun}: it is one run of letters and numbers, with no spaces.`,
    },
    label: { label: 'Name', placeholder: 'Acme production', help: 'Optional. Left empty, the connection takes the name the app gives for whose it is.' },
    steps: spec.steps,
    setup: spec.setup,
    scope: spec.scope,
  };
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
    actions: ['send-message', 'share-pr'],
    caveat: 'A webhook always posts to the channel it was made for, so the Channel setting on these steps is not used.',
  },

  /* Where work is asked for */
  token({
    connectorId: 'linear',
    name: 'Personal API key',
    noun: 'a personal API key',
    placeholder: 'lin_api_…',
    pattern: prefixed('lin_api_'),
    mismatch: 'A Linear personal API key starts with lin_api_.',
    steps: [
      'In Linear, open Settings → Security & access and find Personal API keys.',
      'Press “New API key”, name it, and give it only the access and the teams your steps need.',
      'Copy the key and paste it below. Linear shows it once.',
    ],
    setup: { label: 'Open Linear settings', href: 'https://linear.app/settings/account/security' },
    scope: 'It acts as you in Linear: comments and changes appear under your name, within the access and teams you gave the key. Revoke it on the same settings page at any time.',
  }),
  token({
    connectorId: 'shortcut',
    name: 'API token',
    noun: 'an API token',
    steps: ['In Shortcut, open Settings → API Tokens.', 'Name a token and press “Generate Token”.', 'Copy it and paste it below. Shortcut shows it once.'],
    setup: { label: 'Open Shortcut settings', href: 'https://app.shortcut.com/settings/account/api-tokens' },
    scope: 'It acts as you across the workspace, and Shortcut has no narrower kind of token. Delete it under API Tokens at any time.',
  }),
  token({
    connectorId: 'notion',
    name: 'Integration secret',
    noun: 'an internal integration secret',
    placeholder: 'ntn_…',
    pattern: prefixed('ntn_', 'secret_'),
    mismatch: 'A Notion integration secret starts with ntn_, or secret_ for an older one.',
    steps: [
      'Open Notion’s integrations page and create a new internal integration in your workspace.',
      'Copy its “Internal Integration Secret” and paste it below.',
      'In Notion, open each page or database it should reach, then ••• → Connections, and add the integration.',
    ],
    setup: { label: 'Open Notion integrations', href: 'https://www.notion.so/profile/integrations' },
    scope: 'It reaches only the pages and databases you add it to, with the capabilities you ticked for it. Remove it from a page, or delete the integration, at any time.',
  }),
  token({
    connectorId: 'figma',
    name: 'Personal access token',
    noun: 'a personal access token',
    placeholder: 'figd_…',
    pattern: prefixed('figd_'),
    mismatch: 'A Figma personal access token starts with figd_.',
    steps: [
      'In Figma, open Settings → Security and find Personal access tokens.',
      'Generate a new token with an expiry. Give it read access to Current user, and to what your steps need: file content and comments.',
      'Copy it and paste it below. Figma shows it once.',
    ],
    setup: { label: 'Figma’s guide', href: 'https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens' },
    scope: 'It reads and comments as you, in the files you can open, within the scopes you ticked. It stops working at its expiry, or when you revoke it in Figma.',
  }),

  /* When something breaks */
  token({
    connectorId: 'circleci',
    name: 'Personal API token',
    noun: 'a personal API token',
    placeholder: 'CCIPAT_…',
    steps: ['In CircleCI, open User Settings → Personal API Tokens.', 'Press “Create New Token” and name it.', 'Copy it and paste it below. CircleCI shows it once.'],
    setup: { label: 'Open CircleCI settings', href: 'https://app.circleci.com/settings/user/tokens' },
    scope: 'It acts as you in every project you can reach; CircleCI has no narrower personal token. Revoke it under Personal API Tokens at any time.',
  }),
  token({
    connectorId: 'buildkite',
    name: 'API access token',
    noun: 'an API access token',
    placeholder: 'bkua_…',
    steps: [
      'In Buildkite, open Personal Settings → API Access Tokens and press “New API Access Token”.',
      'Choose the organisation, and tick the scopes your steps need: read_builds and read_pipelines to read a failure, write_builds to retry one.',
      'Copy it and paste it below. Buildkite shows it once.',
    ],
    setup: { label: 'Open Buildkite settings', href: 'https://buildkite.com/user/api-access-tokens/new' },
    scope: 'It does what the scopes you ticked allow, in the organisations you chose, and nothing else. Revoke it under API Access Tokens at any time.',
  }),
  token({
    connectorId: 'bitrise',
    name: 'Personal access token',
    noun: 'a personal access token',
    steps: ['In Bitrise, open your profile → Account settings → Security.', 'Under Personal access tokens, create one and pick an expiry.', 'Copy it and paste it below. Bitrise shows it once.'],
    setup: { label: 'Bitrise’s guide', href: 'https://docs.bitrise.io/en/accounts/personal-access-tokens.html' },
    scope: 'It acts as you in every workspace and app you can reach; Bitrise has no narrower personal token. Give it an expiry, and delete it under Security at any time.',
  }),
  token({
    connectorId: 'vercel',
    name: 'Access token',
    noun: 'an access token',
    steps: ['In Vercel, open Account Settings → Tokens.', 'Create a token, choose the one team it is for, and give it an expiry.', 'Copy it and paste it below. Vercel shows it once.'],
    setup: { label: 'Open Vercel tokens', href: 'https://vercel.com/account/settings/tokens' },
    scope: 'It can do what you can in the team you chose for it, which includes deploying: Vercel tokens cannot be made read-only. Pick the team and the expiry with that in mind, and delete it under Tokens at any time.',
  }),
  token({
    connectorId: 'netlify',
    name: 'Personal access token',
    noun: 'a personal access token',
    placeholder: 'nfp_…',
    steps: ['In Netlify, open User settings → Applications → Personal access tokens.', 'Press “New access token”, describe it, and pick an expiry.', 'Copy it and paste it below. Netlify shows it once.'],
    setup: { label: 'Open Netlify settings', href: 'https://app.netlify.com/user/applications#personal-access-tokens' },
    scope: 'It acts as you in every team and site you can reach; Netlify has no narrower personal token. Give it an expiry, and revoke it under Applications at any time.',
  }),
  token({
    connectorId: 'sentry',
    name: 'Personal token',
    noun: 'a personal token',
    placeholder: 'sntryu_…',
    pattern: /^(?!sntrys_)[\w.~+/=:-]{16,400}$/,
    mismatch: 'A Sentry personal token starts with sntryu_; older ones are 64 letters and numbers. One that starts with sntrys_ is an organization token, which cannot read issues.',
    steps: [
      'In Sentry, open User settings → Personal Tokens and press “Create New Token”.',
      'Set Issue & Event to Read & Write, and Project and Organization to Read. Leave the rest at No Access.',
      'Copy it and paste it below. Sentry shows it once.',
    ],
    setup: { label: 'Open Sentry tokens', href: 'https://sentry.io/settings/account/api/auth-tokens/' },
    scope: 'It reads issues, and comments on or resolves them, as you, within the permissions you set and the organisations you belong to. Revoke it under Personal Tokens at any time. Sentry on a server of your own is not reached yet.',
  }),
  token({
    connectorId: 'bugsnag',
    name: 'Personal auth token',
    noun: 'a personal auth token',
    steps: ['In Bugsnag, open the menu at the top right → My account.', 'Under Personal auth tokens, generate a new token and name it.', 'Copy it and paste it below.'],
    setup: { label: 'Bugsnag’s guide', href: 'https://developer.smartbear.com/bugsnag/docs/data-access' },
    scope: 'It acts as you in every organisation and project you can reach; Bugsnag has no narrower personal token. Revoke it under My account at any time.',
  }),
  token({
    connectorId: 'rollbar',
    name: 'Project access token',
    noun: 'a project access token',
    steps: ['In Rollbar, open the project → Settings → Project Access Tokens.', 'Create a token with the read scope, and write as well if a step resolves or assigns items.', 'Copy it and paste it below.'],
    setup: { label: 'Rollbar’s guide', href: 'https://docs.rollbar.com/docs/access-tokens' },
    scope: 'It covers that one project, with the scopes you gave it. Disable or delete it under Project Access Tokens at any time.',
  }),

  /* Security and upkeep */
  token({
    connectorId: 'snyk',
    name: 'API token',
    noun: 'an API token',
    steps: ['In Snyk, open Account settings → General.', 'Under Auth Token, click to show your key.', 'Copy it and paste it below.'],
    setup: { label: 'Open Snyk account', href: 'https://app.snyk.io/account' },
    scope: 'It acts as you in every Snyk organisation you belong to; a personal token cannot be narrowed. Revoking it under Account settings replaces it everywhere it is used. Accounts in Snyk’s EU and AU regions are not reached yet.',
  }),
  token({
    connectorId: 'semgrep',
    name: 'API token',
    noun: 'an API token',
    steps: ['In Semgrep, open Settings → Tokens → API tokens.', 'Press “Create new token” and tick the Web API scope.', 'Copy it and paste it below. Semgrep shows it once.'],
    setup: { label: 'Open Semgrep tokens', href: 'https://semgrep.dev/orgs/-/settings/tokens' },
    scope: 'With the Web API scope it reads your organisation’s projects and findings. Delete it under Tokens at any time.',
  }),
  token({
    connectorId: 'launchdarkly',
    name: 'Access token',
    noun: 'an access token',
    placeholder: 'api-…',
    pattern: prefixed('api-'),
    mismatch: 'A LaunchDarkly access token starts with api-. SDK keys (sdk-…) and mobile keys (mob-…) are for your app, not for this.',
    steps: [
      'In LaunchDarkly, open Organization settings → Authorization.',
      'Create an access token. Give it the Reader role to find flags, or Writer if a step archives them.',
      'Copy it and paste it below. LaunchDarkly shows it once.',
    ],
    setup: { label: 'Open LaunchDarkly settings', href: 'https://app.launchdarkly.com/settings/authorization' },
    scope: 'It does what the role you gave it allows: a Reader can only look. Delete it under Authorization at any time.',
  }),
  token({
    connectorId: 'statsig',
    name: 'Console API key',
    noun: 'a Console API key',
    placeholder: 'console-…',
    pattern: prefixed('console-'),
    mismatch: 'A Statsig Console API key starts with console-. Server secrets (secret-…) and client keys (client-…) are for your app, not for this.',
    steps: ['In Statsig, open Settings → Keys & Environments.', 'Under Console API Keys, generate a key. Read-only is enough to find gates that finished rolling out.', 'Copy it and paste it below.'],
    setup: { label: 'Statsig’s guide', href: 'https://docs.statsig.com/console-api/introduction' },
    scope: 'It covers that one Statsig project, read-only or read and write as you chose. Delete it under Keys & Environments at any time.',
  }),

  /* Requests from people */
  token({
    connectorId: 'intercom',
    name: 'Access token',
    noun: 'an access token',
    steps: [
      'In Intercom, open Settings → Integrations → Developer Hub and create an app for your own workspace, or open one you have.',
      'Under Configure → Authentication, give it what your steps need: reading conversations, and writing them to leave a note.',
      'Copy the access token and paste it below.',
    ],
    setup: { label: 'Intercom’s guide', href: 'https://developers.intercom.com/docs/build-an-integration/learn-more/authentication' },
    scope: 'It works in your own workspace only, within the permissions you gave the app. Delete the app in the Developer Hub to revoke it. Workspaces hosted in Intercom’s EU and Australian regions are not reached yet.',
  }),
  token({
    connectorId: 'plain',
    name: 'API key',
    noun: 'an API key',
    placeholder: 'plainApiKey_…',
    pattern: prefixed('plainApiKey_'),
    mismatch: 'A Plain API key starts with plainApiKey_.',
    steps: [
      'In Plain, open Settings → Machine users and add one: it is who the steps act as.',
      'Add an API key to it with the permissions your steps need, and workspace:read so the key can be checked.',
      'Copy the key and paste it below. Plain shows it once.',
    ],
    setup: { label: 'Plain’s guide', href: 'https://www.plain.com/docs/graphql/authentication' },
    scope: 'It acts as that machine user, with only the permissions you ticked. Delete the key or the machine user in Plain at any time.',
  }),
];

const BY_CONNECTOR = new Map(CREDENTIAL_SPECS.map((spec) => [spec.connectorId, spec]));

/** How this app connects for real, or undefined when it can only be marked ready. */
export function credentialSpec(connectorId: string): CredentialSpec | undefined {
  return BY_CONNECTOR.get(connectorId);
}

/** The last four characters, to recognise a credential by without showing it. */
export function credentialHint(secret: string): string {
  return secret.slice(-4);
}
