import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { resolveExecutable, resolveInvocation, runProcess } from '../process/runner.ts';
import { ACCOUNT_NAMES, configureGitForGithub, GITHUB_LOGIN_ARGS } from './accounts.ts';
import type { AccountId, AgentAccount, AgentId, AgentsStatus, AuthMethod, LoginMode, LoginSessionView, LoginStatus } from './protocol.ts';

/**
 * The coding CLIs on this machine, as the studio sees them.
 *
 * The same rules as `relay start`, with a browser where the terminal was:
 *
 *   - Ask the vendor's CLI whether it is signed in. Keep the enum and the few
 *     display fields; drop the rest of its output on the floor.
 *   - Start the vendor's own login command. Show the user the URL or device
 *     code it prints. When the CLI asks for an authorization code to be pasted
 *     back, pass the paste straight to its stdin and never log it.
 *   - Never read, print, store or forward a token. There is no route for that.
 */

const STATUS_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 8_000;
const LOGIN_TTL_MS = 15 * 60_000;
const CHILD_ENV = { NO_COLOR: '1', FORCE_COLOR: '0' };

export const AGENT_META: Record<AgentId, { name: string; vendor: string; installCommand: string; loginCommand: string }> = {
  claude: { name: 'Claude Code', vendor: 'Anthropic', installCommand: 'npm install -g @anthropic-ai/claude-code', loginCommand: 'claude auth login' },
  codex: { name: 'Codex', vendor: 'OpenAI', installCommand: 'npm install -g @openai/codex', loginCommand: 'codex login' },
};

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

function clean(text: string): string {
  return text.replace(ANSI, '');
}

export function isAgentId(value: unknown): value is AgentId {
  return value === 'claude' || value === 'codex';
}

export function isLoginMode(value: unknown): value is LoginMode {
  return value === 'browser' || value === 'device' || value === 'console';
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

type SignIn = Pick<AgentAccount, 'loggedIn' | 'method' | 'plan' | 'email'>;

const SIGNED_OUT: SignIn = { loggedIn: false, method: 'none', plan: null, email: null };

async function ask(binary: string, args: readonly string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string } | null> {
  try {
    const result = await runProcess(binary, args, { timeoutMs, env: CHILD_ENV, maxCaptureChars: 256_000 });
    return { ok: result.ok, stdout: clean(result.stdout), stderr: clean(result.stderr) };
  } catch {
    return null;
  }
}

async function version(binary: string): Promise<{ installed: boolean; version: string | null }> {
  if ((await resolveExecutable(binary)) === null) return { installed: false, version: null };
  const result = await ask(binary, ['--version'], VERSION_TIMEOUT_MS);
  const match = result === null ? null : `${result.stdout}\n${result.stderr}`.match(/\d+\.\d+\.\d+/);
  return { installed: true, version: match?.[0] ?? null };
}

/** Reads `claude auth status --json`. Exported for the tests; the output is the CLI's. */
export function parseClaudeStatus(stdout: string, ok: boolean): SignIn {
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown; email?: unknown };
    const loggedIn = parsed.loggedIn === true;
    const authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : 'none';
    const method: AuthMethod = !loggedIn ? 'none' : authMethod === 'claude.ai' ? 'subscription' : authMethod === 'none' ? 'none' : 'api-key';
    return {
      loggedIn,
      method,
      plan: loggedIn && typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : null,
      email: loggedIn && typeof parsed.email === 'string' ? parsed.email : null,
    };
  } catch {
    // Older builds print prose; the exit code decides.
    return { loggedIn: ok, method: ok ? 'unknown' : 'none', plan: null, email: null };
  }
}

/** Reads `codex login status`, which answers in prose on either stream. */
export function parseCodexStatus(text: string, ok: boolean): SignIn {
  const lower = text.toLowerCase();
  if (lower.includes('not logged in')) return SIGNED_OUT;
  if (lower.includes('chatgpt')) return { loggedIn: true, method: 'subscription', plan: null, email: null };
  if (lower.includes('api key')) return { loggedIn: true, method: 'api-key', plan: null, email: null };
  return { loggedIn: ok, method: ok ? 'unknown' : 'none', plan: null, email: null };
}

async function claudeStatus(): Promise<SignIn> {
  const result = await ask('claude', ['auth', 'status', '--json'], STATUS_TIMEOUT_MS);
  return result === null ? SIGNED_OUT : parseClaudeStatus(result.stdout, result.ok);
}

async function codexStatus(): Promise<SignIn> {
  const result = await ask('codex', ['login', 'status'], STATUS_TIMEOUT_MS);
  return result === null ? SIGNED_OUT : parseCodexStatus(`${result.stdout}\n${result.stderr}`, result.ok);
}

function account(id: AgentId, installed: { installed: boolean; version: string | null }, signIn: SignIn): AgentAccount {
  const meta = AGENT_META[id];
  return { id, name: meta.name, ...installed, ...signIn, installCommand: meta.installCommand, loginCommand: meta.loginCommand };
}

export async function agentsStatus(): Promise<AgentsStatus> {
  const [claudeVersion, codexVersion] = await Promise.all([version('claude'), version('codex')]);
  const [claude, codex] = await Promise.all([
    claudeVersion.installed ? claudeStatus() : Promise.resolve(SIGNED_OUT),
    codexVersion.installed ? codexStatus() : Promise.resolve(SIGNED_OUT),
  ]);
  return {
    bridge: true,
    checkedAt: new Date().toISOString(),
    agents: { claude: account('claude', claudeVersion, claude), codex: account('codex', codexVersion, codex) },
  };
}

const LOGOUT_ARGS: Record<AccountId, string[]> = {
  claude: ['auth', 'logout'],
  codex: ['logout'],
  github: ['auth', 'logout', '--hostname', 'github.com'],
};

export async function logout(account: AccountId): Promise<{ ok: boolean; detail: string }> {
  const name = ACCOUNT_NAMES[account];
  const binary = LOGIN_PROGRAMS[account].binary;
  if ((await resolveExecutable(binary)) === null) return { ok: false, detail: `${name} is not installed.` };
  const result = await ask(binary, LOGOUT_ARGS[account], STATUS_TIMEOUT_MS);
  return result?.ok === true ? { ok: true, detail: 'Signed out.' } : { ok: false, detail: `${name} did not sign out.` };
}

/* ------------------------------------------------------------------ */
/* Login sessions                                                      */
/* ------------------------------------------------------------------ */

interface LoginSession {
  id: string;
  agent: AccountId;
  mode: LoginMode;
  child: ChildProcess;
  status: LoginStatus;
  url: string | null;
  code: string | null;
  needsCode: boolean;
  error: string | null;
  startedAt: number;
  /** Cleaned stdout+stderr, kept only long enough to find the URL / code / prompt. Never returned. */
  output: string;
  timer: ReturnType<typeof setTimeout>;
}

interface LoginProgram {
  binary: string;
  installCommand: string;
  args: Partial<Record<LoginMode, string[]>>;
  /** Extra environment for the login child. */
  env?: Record<string, string>;
  /** Runs after a sign-in succeeds. */
  after?: () => Promise<unknown>;
}

const LOGIN_PROGRAMS: Record<AccountId, LoginProgram> = {
  claude: { binary: 'claude', installCommand: AGENT_META.claude.installCommand, args: { browser: ['auth', 'login', '--claudeai'], console: ['auth', 'login', '--console'] } },
  codex: { binary: 'codex', installCommand: AGENT_META.codex.installCommand, args: { browser: ['login'], device: ['login', '--device-auth'] } },
  // gh prints a device code and polls; without a terminal it never asks a question.
  github: {
    binary: 'gh',
    installCommand: 'https://cli.github.com',
    args: { device: GITHUB_LOGIN_ARGS },
    env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    after: configureGitForGithub,
  },
};

export class LoginSessions {
  private readonly sessions = new Map<string, LoginSession>();

  async start(agent: AccountId, mode: LoginMode): Promise<{ ok: true; session: LoginSessionView } | { ok: false; error: string }> {
    const program = LOGIN_PROGRAMS[agent];
    const args = program.args[mode];
    const meta = { name: ACCOUNT_NAMES[agent], installCommand: program.installCommand };
    if (args === undefined) return { ok: false, error: `${meta.name} has no "${mode}" sign-in.` };
    if ((await resolveExecutable(program.binary)) === null) return { ok: false, error: `${meta.name} is not installed. Run: ${meta.installCommand}` };

    // One login per agent at a time: a second flow would race the first for the credential file.
    for (const existing of this.sessions.values()) {
      if (existing.agent === agent && existing.status === 'pending') this.cancel(existing.id);
    }

    let child: ChildProcess;
    try {
      const invocation = await resolveInvocation(program.binary, args);
      child = spawn(invocation.command, [...invocation.args], {
        env: { ...process.env, ...CHILD_ENV, ...program.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    const session: LoginSession = {
      id: randomBytes(9).toString('base64url'),
      agent,
      mode,
      child,
      status: 'pending',
      url: null,
      code: null,
      needsCode: false,
      error: null,
      startedAt: Date.now(),
      output: '',
      timer: setTimeout(() => {
        if (session.status === 'pending') {
          session.status = 'failed';
          session.error = 'Sign-in timed out after 15 minutes.';
          child.kill('SIGTERM');
        }
      }, LOGIN_TTL_MS),
    };
    session.timer.unref();
    this.sessions.set(session.id, session);

    const onData = (chunk: Buffer | string) => {
      session.output = (session.output + clean(String(chunk))).slice(-8000);
      parseLoginOutput(session);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => {
      session.status = 'failed';
      session.error = (error as NodeJS.ErrnoException).code === 'ENOENT' ? `${meta.name} is not installed. Run: ${meta.installCommand}` : error.message;
      clearTimeout(session.timer);
    });
    child.on('close', (code) => {
      clearTimeout(session.timer);
      if (session.status === 'pending') {
        session.status = code === 0 ? 'succeeded' : 'failed';
        if (code !== 0) session.error = `${meta.name} exited with code ${code ?? 'unknown'} before sign-in finished.`;
        if (code === 0) void program.after?.().catch(() => undefined);
      }
      // The transcript may hold a URL with a PKCE state; drop it now that it is not needed.
      session.output = '';
    });

    return { ok: true, session: view(session) };
  }

  /** Waits briefly for the CLI to print its URL / code, so the first answer is already useful. */
  async awaitDetails(id: string, maxMs = 6000): Promise<LoginSessionView | undefined> {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      const session = this.sessions.get(id);
      if (session === undefined) return undefined;
      if (session.status !== 'pending') return view(session);
      if (session.url !== null && (session.mode !== 'device' || session.code !== null)) return view(session);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return this.get(id);
  }

  get(id: string): LoginSessionView | undefined {
    const session = this.sessions.get(id);
    return session === undefined ? undefined : view(session);
  }

  /**
   * Passes a pasted authorization code to the CLI's stdin.
   *
   * The code is a one-time value the CLI exchanges for its credential, inside
   * the CLI. It is written and forgotten: not logged, not kept, not echoed.
   */
  submitCode(id: string, code: string): { ok: boolean; error?: string } {
    const session = this.sessions.get(id);
    if (session === undefined) return { ok: false, error: 'That sign-in is no longer running.' };
    if (session.status !== 'pending') return { ok: false, error: `That sign-in already ${session.status}.` };
    const trimmed = code.trim();
    if (trimmed.length === 0 || trimmed.length > 512 || /\s/.test(trimmed)) return { ok: false, error: 'That does not look like an authorization code.' };
    const stdin = session.child.stdin;
    if (stdin === null || stdin.destroyed) return { ok: false, error: 'The CLI is not accepting input.' };
    stdin.write(`${trimmed}\n`);
    return { ok: true };
  }

  cancel(id: string): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    if (session.status === 'pending') {
      session.status = 'cancelled';
      session.child.kill('SIGTERM');
    }
    clearTimeout(session.timer);
    session.output = '';
    return true;
  }

  /** How many sign-ins are still waiting for the person. */
  pending(): number {
    let count = 0;
    for (const session of this.sessions.values()) if (session.status === 'pending') count += 1;
    return count;
  }

  /** Stops every login still waiting, for when the companion shuts down. */
  cancelAll(): void {
    for (const id of this.sessions.keys()) this.cancel(id);
  }
}

function view(session: LoginSession): LoginSessionView {
  return {
    id: session.id,
    agent: session.agent,
    mode: session.mode,
    status: session.status,
    url: session.url,
    code: session.code,
    needsCode: session.needsCode,
    error: session.error,
    startedAt: new Date(session.startedAt).toISOString(),
  };
}

/** Finds the sign-in URL, the device code and the paste prompt in what the CLI printed. */
export function parseLoginOutput(session: Pick<LoginSession, 'output' | 'url' | 'code' | 'needsCode' | 'agent' | 'mode'>): void {
  const text = session.output;
  if (session.url === null) {
    const match = text.match(/https?:\/\/[^\s'"<>]+/);
    if (match !== null) session.url = match[0].replace(/[.,)]+$/, '');
  }
  if (session.mode === 'device' && session.code === null) {
    const match = text.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/);
    if (match !== null) session.code = match[0];
  }
  if (!session.needsCode && /paste (the )?code here/i.test(text)) session.needsCode = true;
}
