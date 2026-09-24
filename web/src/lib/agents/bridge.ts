/**
 * The local bridge. Server-side only.
 *
 * The studio runs on the user's own machine, which is what makes this honest:
 * a Next route handler can spawn `claude` and `codex` exactly the way `relay
 * start` does from a terminal. The rules are the CLI's rules, restated:
 *
 *   - Ask the vendor's CLI whether it is signed in. Keep the enum and the few
 *     display fields; drop the rest of its output on the floor.
 *   - Start the vendor's own login command. Show the user the URL or device
 *     code it prints. When the CLI asks for an authorization code to be pasted
 *     back, pass the user's paste straight to its stdin and never log it.
 *   - Never read, print, store or forward a token. There is no route for that.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HOSTED_DEMO } from '@/lib/hosted';
import { AGENT_META, type AgentAccount, type AgentId, type AgentsStatus, type AuthMethod, type LoginMode, type LoginSessionView, type LoginStatus } from './types';

const STATUS_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 8_000;
const LOGIN_TTL_MS = 15 * 60_000;

/** Where the vendor CLIs usually live when the studio was launched from a GUI rather than a shell. */
const EXTRA_PATH = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.npm-global', 'bin')];

function childEnv(): NodeJS.ProcessEnv {
  const path = [process.env['PATH'] ?? '', ...EXTRA_PATH].filter(Boolean).join(delimiter);
  return { ...process.env, PATH: path, NO_COLOR: '1', FORCE_COLOR: '0' };
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

function clean(text: string): string {
  return text.replace(ANSI, '');
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; enoent: boolean }> {
  return new Promise((resolve) => {
    execFile(command, args, { env: childEnv(), timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const enoent = error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : enoent ? null : 1;
      resolve({ code, stdout: clean(String(stdout)), stderr: clean(String(stderr)), enoent });
    });
  });
}

async function version(binary: string): Promise<{ installed: boolean; version: string | null }> {
  const result = await run(binary, ['--version'], VERSION_TIMEOUT_MS);
  if (result.enoent) return { installed: false, version: null };
  const match = `${result.stdout}\n${result.stderr}`.match(/\d+\.\d+\.\d+/);
  return { installed: true, version: match?.[0] ?? null };
}

async function claudeStatus(): Promise<Pick<AgentAccount, 'loggedIn' | 'method' | 'plan' | 'email'>> {
  const result = await run('claude', ['auth', 'status', '--json'], STATUS_TIMEOUT_MS);
  try {
    const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown; email?: unknown };
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
    return { loggedIn: result.code === 0, method: result.code === 0 ? 'unknown' : 'none', plan: null, email: null };
  }
}

async function codexStatus(): Promise<Pick<AgentAccount, 'loggedIn' | 'method' | 'plan' | 'email'>> {
  const result = await run('codex', ['login', 'status'], STATUS_TIMEOUT_MS);
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (text.includes('not logged in')) return { loggedIn: false, method: 'none', plan: null, email: null };
  if (text.includes('chatgpt')) return { loggedIn: true, method: 'subscription', plan: null, email: null };
  if (text.includes('api key')) return { loggedIn: true, method: 'api-key', plan: null, email: null };
  return { loggedIn: result.code === 0, method: result.code === 0 ? 'unknown' : 'none', plan: null, email: null };
}

export async function agentsStatus(): Promise<AgentsStatus> {
  const [claudeVersion, codexVersion] = await Promise.all([version('claude'), version('codex')]);
  const [claude, codex] = await Promise.all([
    claudeVersion.installed ? claudeStatus() : Promise.resolve({ loggedIn: false, method: 'none' as AuthMethod, plan: null, email: null }),
    codexVersion.installed ? codexStatus() : Promise.resolve({ loggedIn: false, method: 'none' as AuthMethod, plan: null, email: null }),
  ]);
  return {
    bridge: true,
    checkedAt: new Date().toISOString(),
    agents: {
      claude: { id: 'claude', name: AGENT_META.claude.name, ...claudeVersion, ...claude, installCommand: AGENT_META.claude.installCommand, loginCommand: AGENT_META.claude.loginCommand },
      codex: { id: 'codex', name: AGENT_META.codex.name, ...codexVersion, ...codex, installCommand: AGENT_META.codex.installCommand, loginCommand: AGENT_META.codex.loginCommand },
    },
  };
}

export async function logout(agent: AgentId): Promise<{ ok: boolean; detail: string }> {
  const result = agent === 'claude' ? await run('claude', ['auth', 'logout'], STATUS_TIMEOUT_MS) : await run('codex', ['logout'], STATUS_TIMEOUT_MS);
  if (result.enoent) return { ok: false, detail: `${AGENT_META[agent].name} is not installed.` };
  return { ok: result.code === 0, detail: result.code === 0 ? 'Signed out.' : `${AGENT_META[agent].name} exited ${result.code ?? 'unknown'}.` };
}

/* ------------------------------------------------------------------ */
/* Login sessions                                                      */
/* ------------------------------------------------------------------ */

interface LoginSession {
  id: string;
  agent: AgentId;
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

// Survives Turbopack module reloads in dev, so a login started before an edit
// can still be polled after it.
const sessions: Map<string, LoginSession> = ((globalThis as { __agentLoginSessions?: Map<string, LoginSession> }).__agentLoginSessions ??= new Map());

const LOGIN_ARGS: Record<AgentId, Partial<Record<LoginMode, string[]>>> = {
  claude: { browser: ['auth', 'login', '--claudeai'], console: ['auth', 'login', '--console'] },
  codex: { browser: ['login'], device: ['login', '--device-auth'] },
};

export function supportedModes(agent: AgentId): LoginMode[] {
  return Object.keys(LOGIN_ARGS[agent]) as LoginMode[];
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

function parseOutput(session: LoginSession): void {
  const text = session.output;
  if (session.url === null) {
    const match = text.match(/https?:\/\/[^\s'"<>]+/);
    if (match !== null) session.url = match[0].replace(/[.,)]+$/, '');
  }
  if (session.agent === 'codex' && session.mode === 'device' && session.code === null) {
    const match = text.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/);
    if (match !== null) session.code = match[0];
  }
  if (!session.needsCode && /paste (the )?code here/i.test(text)) session.needsCode = true;
}

export function startLogin(agent: AgentId, mode: LoginMode): { ok: true; session: LoginSessionView } | { ok: false; error: string } {
  const args = LOGIN_ARGS[agent][mode];
  if (args === undefined) return { ok: false, error: `${AGENT_META[agent].name} has no "${mode}" sign-in.` };

  // One login per agent at a time: a second flow would race the first for the credential file.
  for (const existing of sessions.values()) {
    if (existing.agent === agent && existing.status === 'pending') cancelLogin(existing.id);
  }

  const id = randomBytes(9).toString('base64url');
  const binary = agent === 'claude' ? 'claude' : 'codex';
  let child: ChildProcess;
  try {
    child = spawn(binary, args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: false });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const session: LoginSession = {
    id,
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
  sessions.set(id, session);

  const onData = (chunk: Buffer | string) => {
    session.output = (session.output + clean(String(chunk))).slice(-8000);
    parseOutput(session);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (error) => {
    session.status = 'failed';
    session.error = (error as NodeJS.ErrnoException).code === 'ENOENT' ? `${AGENT_META[agent].name} is not installed. Run: ${AGENT_META[agent].installCommand}` : error.message;
    clearTimeout(session.timer);
  });
  child.on('close', (code) => {
    clearTimeout(session.timer);
    if (session.status !== 'pending') return;
    if (code === 0) {
      session.status = 'succeeded';
    } else {
      session.status = 'failed';
      session.error = `${AGENT_META[agent].name} exited with code ${code ?? 'unknown'} before sign-in finished.`;
    }
    // The transcript may contain a URL with a PKCE state; drop it now that it is not needed.
    session.output = '';
  });

  return { ok: true, session: view(session) };
}

/** Waits briefly for the CLI to print its URL / code so the first response is already useful. */
export async function awaitLoginDetails(id: string, maxMs = 6000): Promise<LoginSessionView | undefined> {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const session = sessions.get(id);
    if (session === undefined) return undefined;
    if (session.status !== 'pending') return view(session);
    if (session.url !== null && (session.mode !== 'device' || session.code !== null)) return view(session);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const session = sessions.get(id);
  return session === undefined ? undefined : view(session);
}

export function getLogin(id: string): LoginSessionView | undefined {
  const session = sessions.get(id);
  return session === undefined ? undefined : view(session);
}

/**
 * Passes the user's pasted authorization code to the CLI's stdin.
 *
 * The code is a one-time value that the CLI exchanges for the credential; the
 * exchange happens inside the CLI. It is written and forgotten: not logged,
 * not kept on the session, not echoed back.
 */
export function submitLoginCode(id: string, code: string): { ok: boolean; error?: string } {
  const session = sessions.get(id);
  if (session === undefined) return { ok: false, error: 'That sign-in is no longer running.' };
  if (session.status !== 'pending') return { ok: false, error: `That sign-in already ${session.status}.` };
  const trimmed = code.trim();
  if (trimmed.length === 0 || trimmed.length > 512 || /\s/.test(trimmed)) return { ok: false, error: 'That does not look like an authorization code.' };
  const stdin = session.child.stdin;
  if (stdin === null || stdin === undefined || stdin.destroyed) return { ok: false, error: 'The CLI is not accepting input.' };
  stdin.write(`${trimmed}\n`);
  return { ok: true };
}

export function cancelLogin(id: string): boolean {
  const session = sessions.get(id);
  if (session === undefined) return false;
  if (session.status === 'pending') {
    session.status = 'cancelled';
    session.child.kill('SIGTERM');
  }
  clearTimeout(session.timer);
  session.output = '';
  return true;
}

/* ------------------------------------------------------------------ */
/* Request gating                                                      */
/* ------------------------------------------------------------------ */

/**
 * The bridge only answers a browser on the same machine or the same private
 * network the dev server is already bound to, and only for same-origin calls
 * on anything that starts a process. A random web page must not be able to
 * pop a sign-in window on somebody's laptop.
 */
export function isLocalRequest(request: Request): boolean {
  if (HOSTED_DEMO) return false;
  const raw = request.headers.get('host') ?? '';
  const host = raw.replace(/^\[/, '').replace(/\]?:\d+$/, '').replace(/\]$/, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return true;
  return false;
}

export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}

export function isAgentId(value: unknown): value is AgentId {
  return value === 'claude' || value === 'codex';
}

export function isLoginMode(value: unknown): value is LoginMode {
  return value === 'browser' || value === 'device' || value === 'console';
}
