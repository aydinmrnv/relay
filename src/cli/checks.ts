import { AGENT_REGISTRY, type HarnessRegistration } from '../agents/index.ts';
import { configHarnessRegistrations } from '../agents/configHarness.ts';
import { detectOsSandbox } from '../agents/sandbox.ts';
import { describeCommand, probeAuth, type AuthState, type AuthSupport } from '../auth/delegated.ts';
import { discoverRepository } from '../git/repository.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { LINEAR_KEY_VARIABLE } from '../issues/linear.ts';
import { ISSUE_TRACKER_REGISTRY, issueTrackerRegistration } from '../issues/registry.ts';
import { detectWebhookFormat, resolveWebhookFormat } from '../notify/format.ts';
import { resolveExecutable, runProcess } from '../process/runner.ts';
import { configHarnesses, loadConfig, type RelayConfig } from '../storage/config.ts';

export interface Check {
  label: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
  hint?: string;
}

export interface AgentCheck {
  entry: HarnessRegistration;
  check: Check;
}

/**
 * The environment checks `relay doctor` reports.
 *
 * They live here rather than inside the doctor command because `relay init`
 * needs the same answers during onboarding: a second implementation would
 * eventually disagree with this one about whether a CLI is usable.
 */
export async function checkBinary(name: string, versionArgs: readonly string[]): Promise<Check> {
  const path = await resolveExecutable(name);
  if (path === null) {
    return {
      label: name,
      status: 'fail',
      detail: 'not found',
      hint: `Install ${name} and make sure it is on your PATH.`,
    };
  }

  const result = await runProcess(name, [...versionArgs], { timeoutMs: 20_000 });
  const version = result.stdout.trim().split('\n')[0] ?? '';
  return result.ok
    ? { label: name, status: 'ok', detail: version }
    : { label: name, status: 'fail', detail: 'installed but not runnable' };
}

/**
 * Every registered CLI, in registry order, so a newly added harness is checked
 * without doctor or init knowing its name. Config-defined harnesses ride along
 * as `extra` rows, after the shipped ones.
 */
export async function agentChecks(extra: readonly HarnessRegistration[] = []): Promise<AgentCheck[]> {
  return Promise.all(
    [...AGENT_REGISTRY, ...extra].map(async (entry) => {
      const result = await entry.create({}).checkAvailability();
      return {
        entry,
        check: {
          label: entry.label,
          status: result.available ? ('ok' as const) : ('fail' as const),
          detail: result.detail,
          ...(result.hint === undefined ? {} : { hint: result.hint }),
        },
      };
    }),
  );
}

/**
 * How `read_only` is actually enforced for every registered harness, one row
 * each: a user assigning a review role deserves to know whether the operating
 * system holds that promise or a deny list inside the CLI does.
 *
 * A harness whose CLI carries its own OS sandbox reports it directly. One that
 * only has a deny list reports the OS sandbox Relay wraps around it — or, when
 * the platform offers none, an honest warning that the deny list is the only
 * layer. A warning, not a failure: Relay still runs, weaker than it would like.
 */
export async function enforcementChecks(
  extra: readonly HarnessRegistration[] = [],
  platform: NodeJS.Platform = process.platform,
): Promise<Check[]> {
  const sandbox = await detectOsSandbox(platform);

  return [...AGENT_REGISTRY, ...extra].map((entry) => {
    const label = `${entry.label} read-only`;
    if (entry.enforcement.readOnly === 'os-sandbox' || entry.enforcement.readOnly === 'cli-flag') {
      return { label, status: 'ok' as const, detail: entry.enforcement.detail };
    }
    if (entry.enforcement.readOnly === 'none') {
      return {
        label,
        status: 'warn' as const,
        detail: entry.enforcement.detail,
        hint: 'Declare readOnly flags for this harness in config to let it hold review roles.',
      };
    }
    if (sandbox.available) {
      return {
        label,
        status: 'ok' as const,
        detail: `OS sandbox (${sandbox.mechanism}) + ${entry.enforcement.detail}`,
      };
    }
    return {
      label,
      status: 'warn' as const,
      detail: `${entry.enforcement.detail} only — ${sandbox.reason}`,
      hint:
        'Read-only turns for this harness rely on the CLI honouring its own deny list.\n' +
        (platform === 'linux'
          ? 'Install bubblewrap (`bwrap`) to add an OS-level sandbox around them.'
          : 'No OS-level sandbox is available here to wrap around them.'),
    };
  });
}

/**
 * Sign-in state for one delegated tool.
 *
 * Being installed is not being usable: a CLI that is present but signed out
 * fails at the first agent turn, ten minutes into a run, which is exactly the
 * failure onboarding exists to move forward to here.
 */
export async function authCheck(label: string, support: AuthSupport, cwd: string): Promise<Check> {
  return authStateCheck(label, support, await probeAuth(support, { cwd }));
}

/** The reporting half of `authCheck`, kept pure so a flow can probe once and print twice. */
export function authStateCheck(label: string, support: AuthSupport, state: AuthState): Check {
  const login = describeCommand(support.login);

  if (state === 'authenticated') return { label, status: 'ok', detail: 'signed in' };
  if (state === 'unknown') {
    return {
      label,
      status: 'warn',
      detail: 'sign-in state unknown',
      hint: `Relay could not ask. If a run fails to start, run \`${login}\`.`,
    };
  }
  return { label, status: 'fail', detail: 'not signed in', hint: `Run \`${login}\`.` };
}

/**
 * Sign-in state for every registered coding CLI that is actually installed.
 * A missing CLI has already reported the more useful problem, and a CLI with
 * no status probe (every config-defined harness) has no state Relay can ask
 * for, so probing it would only report "unknown" about every one.
 */
export async function agentAuthChecks(cwd: string, agents?: readonly AgentCheck[]): Promise<Check[]> {
  const installed = (agents ?? (await agentChecks())).filter(
    ({ entry, check }) => check.status === 'ok' && entry.auth.status !== undefined,
  );
  return Promise.all(installed.map(({ entry }) => authCheck(`${entry.label} sign-in`, entry.auth, cwd)));
}

export async function githubCheck(cwd: string): Promise<Check> {
  return trackerCheck('github', cwd);
}

async function trackerCheck(name: 'github' | 'linear', cwd: string, config?: RelayConfig): Promise<Check> {
  const registration = issueTrackerRegistration(name) ?? ISSUE_TRACKER_REGISTRY[0]!;
  const result = await registration.create({ cwd, issues: config?.issues }).checkAvailability();
  return {
    label: `${registration.label} authentication`,
    status: result.available ? 'ok' : 'fail',
    detail: result.detail,
    ...(result.hint === undefined ? {} : { hint: result.hint }),
  };
}

/**
 * Downgrades a failure to a warning, with the alternative attached.
 *
 * A tracker is how most runs find their issue and no longer how every run finds
 * one: `relay run ./spec.md` and `--prompt` need nothing installed. Reporting a
 * missing `gh` as fatal would have doctor say Relay cannot run when it can.
 */
function softenToWarning(check: Check, alternative: string): Check {
  if (check.status !== 'fail') return check;
  return {
    ...check,
    status: 'warn',
    hint: check.hint === undefined ? alternative : `${check.hint}\n${alternative}`,
  };
}

const WITHOUT_A_TRACKER =
  'Work that has no ticket needs none of this: `relay run ./spec.md`, `relay run --prompt "…"`.';

/** Repository checks, plus the root they were resolved against when there is one. */
export async function repositoryChecks(cwd: string): Promise<{ root?: string; checks: Check[] }> {
  try {
    const repo = await discoverRepository(cwd);
    const slug = repo.owner !== null && repo.name !== null ? ` (${repo.owner}/${repo.name})` : ' (no GitHub remote)';
    const checks: Check[] = [
      { label: 'Git repository', status: 'ok', detail: `${repo.root}${slug}, base ${repo.defaultBranch}` },
    ];

    // Not a problem, and worth saying anyway: what a run does here is different
    // enough — no base commit, nothing to diff against — to be a surprise. The
    // whole answer goes in the detail, because doctor prints a hint only for a
    // check that failed, and this one has not.
    if (repo.isEmpty) {
      checks.push({
        label: 'Commits',
        status: 'ok',
        detail: `none yet — a run branches from an empty tree, and its commit is ${repo.defaultBranch}'s first`,
      });
    }

    if (repo.isDirty) {
      checks.push({
        label: 'Working tree',
        status: 'warn',
        detail: `${repo.dirtyFiles.length} uncommitted change(s)`,
        hint: 'Relay works in a separate worktree, so these are safe — they just will not be part of a run.',
      });
    }
    return { root: repo.root, checks };
  } catch (error) {
    return {
      checks: [
        {
          label: 'Git repository',
          status: 'fail',
          detail: error instanceof Error ? error.message : 'not a git repository',
          hint: 'Run relay from inside a git repository.',
        },
      ],
    };
  }
}

/**
 * The repository's own harnesses, plus the check to report when the config
 * that would define them cannot be read. Doctor's job is to say what is wrong,
 * so a broken config is a failed check here rather than a crash.
 */
async function configuredHarnesses(
  root: string | undefined,
): Promise<{ registrations: HarnessRegistration[]; check?: Check; config?: RelayConfig }> {
  if (root === undefined) return { registrations: [] };
  try {
    const config = await loadConfig(root);
    return { registrations: configHarnessRegistrations(configHarnesses(config)), config };
  } catch (error) {
    return {
      registrations: [],
      check: {
        label: 'Relay config',
        status: 'fail',
        detail: error instanceof Error ? error.message : 'unreadable',
        hint: 'Fix .relay/config.json, then run `relay doctor` again.',
      },
    };
  }
}

/**
 * The trackers this repository reads from: GitHub always, because a bare
 * reference and delivery both lean on it, and Linear when config points there
 * or a key is present — a key nobody meant to use is still worth confirming.
 */
async function trackerChecks(cwd: string, config: RelayConfig | undefined): Promise<Check[]> {
  const checks = [softenToWarning(await trackerCheck('github', cwd, config), WITHOUT_A_TRACKER)];
  const linearConfigured = config?.issues?.provider === 'linear';
  if (linearConfigured || (process.env[LINEAR_KEY_VARIABLE]?.trim() ?? '') !== '') {
    const linear = await trackerCheck('linear', cwd, config);
    checks.push(softenToWarning(linear, linearConfigured ? WITHOUT_A_TRACKER : 'Linear is optional; unset the key to silence this.'));
  }
  return checks;
}

/**
 * The outward-facing integrations, checked without sending anything: a doctor
 * that posted to a Slack channel every time it ran would be switched off.
 * `relay notify` is the command that actually sends.
 */
export async function integrationChecks(config: RelayConfig): Promise<Check[]> {
  const checks: Check[] = [];
  const webhook = config.notify?.webhook;
  if (webhook != null) {
    const detected = detectWebhookFormat(webhook);
    const format = resolveWebhookFormat(webhook, config.notify.webhookFormat);
    let host = webhook;
    try { host = new URL(webhook).host; } catch { /* validated when the config loaded */ }
    const mismatch = detected !== 'json' && format !== detected;
    checks.push({
      label: 'Webhook',
      status: mismatch ? 'warn' : 'ok',
      detail: `${format} to ${host}`,
      ...(mismatch
        ? { hint: `This looks like a ${detected} URL but is sent as ${format}; ${detected} will likely reject it. Set notify.webhookFormat to "auto".` }
        : { hint: 'Run `relay notify` to send a test.' }),
    });
  }
  if (config.notify?.system === true) {
    const notifier = process.platform === 'darwin' ? 'osascript' : process.platform === 'linux' ? 'notify-send' : 'powershell';
    const found = (await resolveExecutable(notifier)) !== null || (process.platform === 'win32' && (await resolveExecutable('pwsh')) !== null);
    checks.push(found
      ? { label: 'Desktop notifications', status: 'ok', detail: notifier }
      : { label: 'Desktop notifications', status: 'warn', detail: `${notifier} not found`, hint: process.platform === 'linux' ? 'Install libnotify (`notify-send`).' : 'Set notify.system to false.' });
  }
  if (Array.isArray(config.notify?.command)) {
    const executable = config.notify.command[0]!;
    const found = (await resolveExecutable(executable)) !== null;
    checks.push(found
      ? { label: 'Notify command', status: 'ok', detail: executable }
      : { label: 'Notify command', status: 'warn', detail: `${executable} not found`, hint: 'notify.command[0] must be an executable on PATH or an absolute path.' });
  }
  if (config.tracking?.enabled === true) {
    const cli = join(homedir(), '.wakatime', process.platform === 'win32' ? 'wakatime-cli.exe' : 'wakatime-cli');
    const found = (await resolveExecutable(cli)) !== null || (await resolveExecutable('wakatime-cli')) !== null;
    checks.push(found
      ? { label: 'WakaTime', status: 'ok', detail: 'wakatime-cli found' }
      : { label: 'WakaTime', status: 'warn', detail: 'wakatime-cli not found', hint: 'Install any WakaTime editor plugin once (it installs ~/.wakatime/wakatime-cli), or set tracking.enabled to false.' });
  }
  return checks;
}

/** Everything a run depends on, in the order `relay doctor` reports it. */
export async function collectChecks(cwd: string): Promise<Check[]> {
  const checks: Check[] = [
    await checkBinary('git', ['--version']),
    softenToWarning(await checkBinary('gh', ['--version']), WITHOUT_A_TRACKER),
  ];

  const repository = await repositoryChecks(cwd);
  const configured = await configuredHarnesses(repository.root);

  const agents = await agentChecks(configured.registrations);
  for (const { check } of agents) checks.push(check);
  checks.push(...(await enforcementChecks(configured.registrations)));

  checks.push(...(await agentAuthChecks(repository.root ?? cwd, agents)));
  checks.push(...repository.checks);
  if (configured.check !== undefined) checks.push(configured.check);
  checks.push(...(await trackerChecks(repository.root ?? cwd, configured.config)));
  if (configured.config !== undefined) checks.push(...(await integrationChecks(configured.config)));

  return checks;
}
