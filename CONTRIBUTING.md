# Contributing

Relay is two things in one repository: the workflow studio in `web/` (Next.js)
and the `relay` CLI and engine in `src/` (TypeScript on Node 22.6 or later).
Bug reports, fixes and new connectors are welcome.

## Before you start

- For anything larger than a fix, open an issue first and say what you want to
  change. It saves you writing something that will not be merged.
- Security problems go to support@nullstack.one, not to an issue. See
  [SECURITY.md](SECURITY.md).

## Setting up

```bash
# the CLI and engine, from the repository root
npm install
npm run check          # typecheck and tests: no network, no real agents

# the studio
cd web
npm install
npm run dev            # http://localhost:3000, on an embedded Postgres
npm run lint && npm run typecheck && npm test && npm run build
```

The studio runs with nothing configured: without Clerk keys it is the
browser-only studio with accounts off. `npx clerk env pull` adds accounts.
To pair a studio you run yourself with the CLI, start it with
`RELAY_STUDIO_DEV=1 relay connect --studio http://localhost:3000`: outside
development the companion answers only the hosted studio.
[`web/README.md`](web/README.md) says where things live; [`docs/cli.md`](docs/cli.md)
is the CLI reference.

`web/` is on a Next.js version with breaking changes. Read the guide under
`web/node_modules/next/dist/docs/` before changing routing, metadata, the
proxy or an error file.

## What a change needs

- **Tests.** The engine has a test for every rule it enforces; a change to a
  rule changes its test. Tests must not call a real agent or the network.
- **Honest wording.** The studio says what is real and what is simulated. If
  you add something that is played back, or not built yet, the screen says so.
- **Docs in the same change.** A new flag, config key or environment variable
  is documented where the others are (`docs/cli.md`, `web/.env.example`).
- **No secrets, no personal infrastructure.** No keys, hostnames, IP addresses
  or account ids in code, docs or fixtures.

## Adding a connector

Add a `defineConnector({...})` entry to a file under
`web/src/lib/connectors/catalog/`. Triggers and actions become palette nodes,
`fields` become the inspector form, and typed ports stop nonsense connections.
Only a label on a GitHub issue starts an exported workflow by itself today, so
a new app's trigger is one the studio can design and test-run; say so in its
description rather than implying more.

## Pull requests

Keep one change per pull request, explain what it does and why in the
description, and make sure `npm run check` at the root and lint, typecheck,
test and build in `web/` pass. CI runs the same on macOS, Linux and Windows.

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
