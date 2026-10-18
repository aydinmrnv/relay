/**
 * A stand-in for the parts of GitHub the studio's GitHub routes use: the
 * OAuth token endpoint, who a token belongs to, the app's installations, and
 * enough of one repository's git data (refs, commits, trees, contents), pull
 * requests and labels to open a pull request for real against it.
 *
 * Trees are content-addressed like git's, so two identical trees have the
 * same sha, which is how "nothing changed" is told apart from "changed".
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRepo {
  fullName: string;
  private?: boolean;
  defaultBranch?: string;
  archived?: boolean;
  push?: boolean;
  ownerType?: 'User' | 'Organization';
  pushedAt?: string;
  /** The files on the default branch. */
  files?: Record<string, string>;
  /** False when the app is not installed on it: a user token then gets 404. */
  reachable?: boolean;
  /** What POST /labels answers: 201 makes it, 422 means it exists, 403 is an app without issue access. */
  labels?: 'make' | 'exists' | 'forbidden';
}

interface Commit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
}

interface Pull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
}

export interface Logged {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

export class FakeGitHub {
  readonly log: Logged[] = [];
  readonly trees = new Map<string, Record<string, string>>();
  readonly commits = new Map<string, Commit>();
  /** `owner/name` (lowercase) → branch → sha. */
  readonly refs = new Map<string, Map<string, string>>();
  readonly pulls = new Map<string, Pull[]>();
  readonly repos = new Map<string, FakeRepo>();
  /** Codes the token endpoint accepts, and the verifier each was issued for. */
  readonly codes = new Map<string, string>();
  /** Codes handed out by the authorize page, and the PKCE challenge each must answer. */
  readonly challenges = new Map<string, string>();
  /** For the browser pages: the repositories installing the app covers, and where GitHub sends the person afterwards. */
  installs: { id: number; account: string; type: 'User' | 'Organization'; repos: string[] } | null = null;
  setupUrl = '';
  readonly refreshTokens = new Set<string>();
  /** Installation id → the repositories it covers. */
  installations: Array<{ id: number; account: string; type: 'User' | 'Organization'; repos: string[] }> = [];
  user = { id: 42, login: 'ada' };
  token = 'ghu_faketoken';
  private server: Server | null = null;
  private counter = 0;
  url = '';

  addRepo(repo: FakeRepo): void {
    const key = repo.fullName.toLowerCase();
    this.repos.set(key, repo);
    const tree = this.storeTree(repo.files ?? { 'README.md': '# hello\n' });
    const commit = this.storeCommit(tree, [], 'Initial commit');
    this.refs.set(key, new Map([[repo.defaultBranch ?? 'main', commit]]));
    this.pulls.set(key, []);
  }

  /** Puts a commit on the default branch, as if somebody pushed. */
  push(fullName: string, files: Record<string, string>): string {
    const key = fullName.toLowerCase();
    const branch = this.repos.get(key)!.defaultBranch ?? 'main';
    const parent = this.refs.get(key)!.get(branch)!;
    const tree = this.storeTree({ ...this.trees.get(this.commits.get(parent)!.tree)!, ...files });
    const sha = this.storeCommit(tree, [parent], 'Somebody else’s commit');
    this.refs.get(key)!.set(branch, sha);
    return sha;
  }

  /** The files on a branch, or undefined when there is no such branch. */
  filesOn(fullName: string, branch: string): Record<string, string> | undefined {
    const sha = this.refs.get(fullName.toLowerCase())?.get(branch);
    return sha === undefined ? undefined : this.trees.get(this.commits.get(sha)!.tree);
  }

  pullsOf(fullName: string): Pull[] {
    return this.pulls.get(fullName.toLowerCase()) ?? [];
  }

  storeTree(files: Record<string, string>): string {
    const sorted = Object.keys(files)
      .sort()
      .map((path) => `${path}\u0000${files[path]}`)
      .join('\u0001');
    const sha = createHash('sha1').update(sorted).digest('hex');
    this.trees.set(sha, { ...files });
    return sha;
  }

  storeCommit(tree: string, parents: string[], message: string): string {
    this.counter += 1;
    const sha = createHash('sha1').update(`${tree}:${parents.join(',')}:${this.counter}`).digest('hex');
    this.commits.set(sha, { sha, tree, parents, message });
    return sha;
  }

  async start(port = 0): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url ?? '/', 'http://fake');
    let body: unknown = raw;
    if ((request.headers['content-type'] ?? '').includes('json') && raw.length > 0) body = JSON.parse(raw);
    else if ((request.headers['content-type'] ?? '').includes('x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
    this.log.push({ method: request.method ?? 'GET', path: `${url.pathname}${url.search}`, body, authorization: request.headers.authorization ?? null });
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(data === undefined ? '' : JSON.stringify(data));
    };
    try {
      this.route(request.method ?? 'GET', url, body, request.headers.authorization ?? '', send);
    } catch (error) {
      send(500, { message: String(error) });
    }
  }

  private route(method: string, url: URL, body: unknown, authorization: string, send: (status: number, data: unknown, headers?: Record<string, string>) => void): void {
    const path = url.pathname;
    // The pages a person sees on github.com, answered at once as if they had pressed the green button.
    if (method === 'GET' && path === '/login/oauth/authorize') {
      const code = `code${this.counter++}`;
      this.challenges.set(code, url.searchParams.get('code_challenge') ?? '');
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      return send(302, undefined, { location: back.toString() });
    }
    if (method === 'GET' && /^\/apps\/[^/]+\/installations\/new$/.test(path)) {
      if (this.installs !== null && !this.installations.some((entry) => entry.id === this.installs!.id)) this.installations.push(this.installs);
      return send(302, undefined, { location: `${this.setupUrl}?installation_id=${this.installs?.id ?? 0}&setup_action=install` });
    }
    if (method === 'POST' && path === '/login/oauth/access_token') {
      const form = body as Record<string, string>;
      if (form['grant_type'] === 'refresh_token') {
        if (!this.refreshTokens.has(form['refresh_token'] ?? '')) return send(200, { error: 'bad_refresh_token' });
        this.refreshTokens.delete(form['refresh_token']!);
        this.token = `ghu_refreshed${this.counter++}`;
        const next = `ghr_next${this.counter++}`;
        this.refreshTokens.add(next);
        return send(200, { access_token: this.token, expires_in: 28800, refresh_token: next, refresh_token_expires_in: 15897600, token_type: 'bearer', scope: '' });
      }
      const challenge = this.challenges.get(form['code'] ?? '');
      if (challenge !== undefined) {
        if (createHash('sha256').update(form['code_verifier'] ?? '').digest('base64url') !== challenge) return send(200, { error: 'bad_verification_code' });
        this.challenges.delete(form['code']!);
      } else {
        const verifier = this.codes.get(form['code'] ?? '');
        if (verifier === undefined || verifier !== form['code_verifier']) return send(200, { error: 'bad_verification_code' });
        this.codes.delete(form['code']!);
      }
      const refresh = `ghr_first${this.counter++}`;
      this.refreshTokens.add(refresh);
      return send(200, { access_token: this.token, expires_in: 28800, refresh_token: refresh, refresh_token_expires_in: 15897600, token_type: 'bearer', scope: '' });
    }
    if (authorization !== `Bearer ${this.token}`) return send(401, { message: 'Bad credentials' });

    if (method === 'GET' && path === '/user') return send(200, this.user);
    if (method === 'GET' && path === '/user/installations') return send(200, { total_count: this.installations.length, installations: this.installations.map((entry) => ({ id: entry.id, account: { login: entry.account, type: entry.type } })) });
    const listing = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
    if (method === 'GET' && listing !== null) {
      const installation = this.installations.find((entry) => entry.id === Number(listing[1]));
      if (installation === undefined) return send(404, { message: 'Not Found' });
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      const page = Number(url.searchParams.get('page') ?? '1');
      const all = installation.repos.map((name) => this.repoJson(this.repos.get(name.toLowerCase())!));
      return send(200, { total_count: all.length, repositories: all.slice((page - 1) * perPage, page * perPage) });
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoMatch === null) return send(404, { message: 'Not Found' });
    const key = `${decodeURIComponent(repoMatch[1]!)}/${decodeURIComponent(repoMatch[2]!)}`.toLowerCase();
    const repo = this.repos.get(key);
    if (repo === undefined || repo.reachable === false) return send(404, { message: 'Not Found' });
    const rest = repoMatch[3] ?? '';
    const refs = this.refs.get(key)!;
    const pulls = this.pulls.get(key)!;

    if (method === 'GET' && rest === '') return send(200, this.repoJson(repo));
    if (rest.startsWith('/git/ref/heads/') && method === 'GET') {
      const branch = rest.slice('/git/ref/heads/'.length).split('/').map(decodeURIComponent).join('/');
      const sha = refs.get(branch);
      return sha === undefined ? send(404, { message: 'Not Found' }) : send(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
    if (rest.startsWith('/git/refs/heads/') && method === 'PATCH') {
      const branch = rest.slice('/git/refs/heads/'.length).split('/').map(decodeURIComponent).join('/');
      const { sha, force } = body as { sha: string; force?: boolean };
      if (!refs.has(branch)) return send(422, { message: 'Reference does not exist' });
      if (force !== true) return send(422, { message: 'Update is not a fast forward' });
      refs.set(branch, sha);
      return send(200, { ref: `refs/heads/${branch}`, object: { sha } });
    }
    if (rest === '/git/refs' && method === 'POST') {
      const { ref, sha } = body as { ref: string; sha: string };
      const branch = ref.replace(/^refs\/heads\//, '');
      if (refs.has(branch)) return send(422, { message: 'Reference already exists' });
      refs.set(branch, sha);
      return send(201, { ref, object: { sha } });
    }
    const commitMatch = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest);
    if (commitMatch !== null && method === 'GET') {
      const commit = this.commits.get(commitMatch[1]!);
      return commit === undefined ? send(404, { message: 'Not Found' }) : send(200, { sha: commit.sha, tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })), message: commit.message });
    }
    if (rest === '/git/trees' && method === 'POST') {
      const { base_tree: baseTree, tree } = body as { base_tree?: string; tree: Array<{ path: string; content: string; mode: string; type: string }> };
      const files = { ...(baseTree === undefined ? {} : (this.trees.get(baseTree) ?? {})) };
      for (const entry of tree) files[entry.path] = entry.content;
      return send(201, { sha: this.storeTree(files) });
    }
    if (rest === '/git/commits' && method === 'POST') {
      const { tree, parents, message } = body as { tree: string; parents: string[]; message: string };
      return send(201, { sha: this.storeCommit(tree, parents, message) });
    }
    if (rest.startsWith('/contents/') && method === 'GET') {
      const filePath = rest.slice('/contents/'.length).split('/').map(decodeURIComponent).join('/');
      const branch = url.searchParams.get('ref') ?? repo.defaultBranch ?? 'main';
      const files = this.filesOn(repo.fullName, branch) ?? {};
      if (Object.keys(files).some((name) => name.startsWith(`${filePath}/`))) return send(200, [{ type: 'file', path: `${filePath}/x` }]);
      const content = files[filePath];
      return content === undefined ? send(404, { message: 'Not Found' }) : send(200, { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64') });
    }
    if (rest === '/pulls' && method === 'GET') {
      const head = url.searchParams.get('head') ?? '';
      const state = url.searchParams.get('state') ?? 'open';
      const branch = head.includes(':') ? head.split(':')[1] : head;
      return send(
        200,
        pulls.filter((pull) => (head === '' || pull.head === branch) && (state === 'all' || pull.state === state)).map((pull) => this.pullJson(repo, pull)),
      );
    }
    if (rest === '/pulls' && method === 'POST') {
      const { title, head, base, body: text } = body as { title: string; head: string; base: string; body: string };
      if (!refs.has(head)) return send(422, { message: 'Validation Failed' });
      const pull: Pull = { number: 100 + pulls.length + 1, head, base, title, body: text, state: 'open', merged: false };
      pulls.push(pull);
      return send(201, this.pullJson(repo, pull));
    }
    const pullMatch = /^\/pulls\/(\d+)$/.exec(rest);
    if (pullMatch !== null) {
      const pull = pulls.find((entry) => entry.number === Number(pullMatch[1]));
      if (pull === undefined) return send(404, { message: 'Not Found' });
      if (method === 'PATCH') {
        Object.assign(pull, body as Partial<Pull>);
        return send(200, this.pullJson(repo, pull));
      }
      return send(200, this.pullJson(repo, pull));
    }
    if (rest === '/labels' && method === 'POST') {
      if (repo.labels === 'forbidden') return send(403, { message: 'Resource not accessible by integration' });
      if (repo.labels === 'exists') return send(422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] });
      repo.labels = 'exists';
      return send(201, { name: (body as { name: string }).name });
    }
    return send(404, { message: 'Not Found' });
  }

  private repoJson(repo: FakeRepo): Record<string, unknown> {
    const [owner] = repo.fullName.split('/');
    return {
      full_name: repo.fullName,
      private: repo.private ?? true,
      default_branch: repo.defaultBranch ?? 'main',
      archived: repo.archived ?? false,
      pushed_at: repo.pushedAt ?? '2026-10-01T00:00:00Z',
      owner: { login: owner, type: repo.ownerType ?? 'User' },
      permissions: { admin: false, maintain: false, push: repo.push ?? true, pull: true },
    };
  }

  private pullJson(repo: FakeRepo, pull: Pull): Record<string, unknown> {
    return { number: pull.number, html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`, state: pull.state, merged: pull.merged, merged_at: pull.merged ? '2026-10-18T00:00:00Z' : null, title: pull.title, body: pull.body };
  }
}
