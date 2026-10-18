#!/usr/bin/env node
/**
 * Makes the GitHub App the studio connects GitHub accounts through, with
 * GitHub's manifest flow: this opens a page that hands GitHub the app's
 * settings, you name it and press "Create GitHub App" on github.com, and
 * GitHub sends back its credentials.
 *
 *   node scripts/create-github-app.mjs --studio https://relay.example.com
 *   node scripts/create-github-app.mjs --studio https://relay.example.com --org acme --write
 *
 * Prints GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET;
 * `--write` also puts them in web/.env.local. The app's private key is not
 * kept: the studio never acts as the app, only as the person who signed in.
 *
 * What the app may do, and why:
 *   contents: write       commit Relay's files to a branch of its own
 *   pull_requests: write  open the setup pull request
 *   workflows: write      that commit includes a file under .github/workflows/
 *   issues: write         make the label that starts a run
 *   metadata: read        list the repositories (GitHub requires it)
 * A person's token only ever has what both they and the app have, on the
 * repositories they installed it on.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const studio = (option('studio') ?? '').replace(/\/+$/, '');
const org = option('org');
const name = option('name') ?? 'Relay';
const port = Number(option('port') ?? '4488');
const write = args.includes('--write');

if (!/^https?:\/\/[^/]+$/.test(studio)) {
  console.error('Usage: node scripts/create-github-app.mjs --studio https://your-studio.example [--org <org>] [--name <app name>] [--write]');
  process.exit(2);
}

const state = randomBytes(16).toString('hex');
const local = `http://127.0.0.1:${port}`;
const callbacks = [...new Set([`${studio}/api/github/callback`, 'http://localhost:3000/api/github/callback'])];
const manifest = {
  name,
  url: studio,
  description: 'Sets a repository up for Relay with a pull request you review and merge.',
  public: true,
  redirect_url: `${local}/created`,
  callback_urls: callbacks,
  // The return from installing, or from changing which repositories it may use.
  setup_url: `${studio}/api/github/installed`,
  setup_on_update: true,
  // Signing in is a separate step with its own state; see web/src/server/github/oauth.ts.
  request_oauth_on_install: false,
  hook_attributes: { url: `${studio}/api/github/webhook`, active: false },
  default_permissions: { contents: 'write', pull_requests: 'write', workflows: 'write', issues: 'write', metadata: 'read' },
  default_events: [],
};

const target = org === undefined ? 'https://github.com/settings/apps/new' : `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`;
const escape = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const page = `<!doctype html><meta charset="utf-8"><title>Create the GitHub App</title>
<body style="font:16px system-ui;max-width:36rem;margin:4rem auto">
<p>Sending GitHub the app's settings…</p>
<form id="f" method="post" action="${target}?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form>
<script>document.getElementById('f').submit()</script>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', local);
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }
  if (url.pathname !== '/created') {
    response.writeHead(404).end();
    return;
  }
  if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
    response.writeHead(400, { 'content-type': 'text/plain' }).end('That is not the app this script asked for. Run it again.');
    return;
  }
  const answer = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(url.searchParams.get('code'))}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'relay-create-github-app' },
  });
  const app = await answer.json().catch(() => null);
  if (!answer.ok || app === null || typeof app.client_id !== 'string') {
    response.writeHead(502, { 'content-type': 'text/plain' }).end(`GitHub did not hand the app over (${answer.status}). Run the script again.`);
    console.error('GitHub did not hand the app over:', answer.status, app?.message ?? '');
    server.close();
    process.exitCode = 1;
    return;
  }
  const lines = [`GITHUB_APP_SLUG=${app.slug}`, `GITHUB_APP_CLIENT_ID=${app.client_id}`, `GITHUB_APP_CLIENT_SECRET=${app.client_secret}`];
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;max-width:36rem;margin:4rem auto"><p>Made <a href="${escape(app.html_url)}">${escape(app.name)}</a>. The credentials are in your terminal; you can close this tab.</p>`);
  console.log(`\nMade ${app.name}: ${app.html_url}\n`);
  console.log(lines.join('\n'));
  if (write) {
    const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
    const current = await readFile(envFile, 'utf8').catch(() => '');
    const kept = current.split('\n').filter((line) => !/^GITHUB_APP_(SLUG|CLIENT_ID|CLIENT_SECRET)=/.test(line));
    while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
    await writeFile(envFile, `${[...kept, ...lines].join('\n')}\n`, { mode: 0o600 });
    console.log(`\nWritten to ${envFile}.`);
  }
  console.log(`\nOn Vercel, add the three to the studio's environment (vercel env add <NAME> production), then redeploy.`);
  console.log(`Callback URLs: ${callbacks.join(', ')}. Setup URL: ${manifest.setup_url}.`);
  server.close();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Opening ${local} to send GitHub the app's settings. If no browser opens, visit it yourself.`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(opener, [local], () => undefined);
});
