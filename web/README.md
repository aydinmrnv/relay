# Workflow studio (prototype)

A node-based, drag-and-drop workflow builder for the Relay pipeline, as the front end of a future cloud product. It runs entirely in your browser, costs nothing, and hosts nothing.

```bash
cd web
npm install
npm run dev        # http://localhost:3000
```

## What it does

- **Landing page** built from shadcnblocks (hero, features, pricing, FAQ, CTA, footer, changelog) and rendered from the connector catalog and the brand setting.
- **Builder** (`/workflows/<id>`): React Flow canvas with typed ports, a searchable palette of every connector trigger and action, an inspector whose forms are generated from each node's field schema, live validation that mirrors the CLI's own rules, and a simulated **Test run** that plays back phases, review rounds, budgets and refusals.
- **Export**: compiles the graph to `.relay/config.json` (what the CLI reads today) plus a GitHub Actions workflow that runs it on your own minutes, a SETUP.md, and the graph JSON. What the canvas cannot express in those files is listed as a warning, never dropped.
- **Integrations** (`/integrations`): the catalog, with mocked "Connect" so you can design against everything.
- **Runs**, **Templates**, **Dashboard**, **Settings**.

## Bring your own subscription

There are no API keys to paste. Claude Code signs in with your Claude plan and Codex with your ChatGPT plan, and the studio can start either CLI's own login from the browser because it runs on your machine:

- `GET /api/agents` asks `claude auth status --json` and `codex login status` and returns only the sign-in state, plan and account label.
- `POST /api/agents/{claude|codex}/login` spawns `claude auth login` / `codex login` (or `codex login --device-auth`), shows you the URL or device code the CLI prints, and relays the authorization code Claude asks for straight to the CLI's stdin. Nothing is logged or kept.
- The routes only answer requests from this machine or its private network, and only same-origin calls may start a process.

For GitHub Actions, the export uses the vendors' supported ways of carrying a personal plan into CI: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and `CODEX_AUTH_JSON` holding `~/.codex/auth.json` (OpenAI's documented method; not for public repositories). Settings can switch either agent to an API key instead.

## The name is not decided

Nothing hard-codes "Relay". The default comes from `NEXT_PUBLIC_PRODUCT_NAME` (and `NEXT_PUBLIC_PRODUCT_TAGLINE`) at build time; the settings page overrides it at runtime and stores the override locally. Slugs, trigger labels, branch prefixes, exports and page titles all follow.

```bash
NEXT_PUBLIC_PRODUCT_NAME="Conductor" npm run dev
```

## Where things live

| Path | What |
|---|---|
| `src/lib/brand.ts` | The product name and everything derived from it |
| `src/lib/connectors/` | Connector catalog (`catalog/core.ts`, `catalog/dev.ts`, `catalog/business.ts`), node-type registry, search |
| `src/lib/workflow/schema.ts` | Saved shape of a workflow and a run, free of React Flow types |
| `src/lib/workflow/validate.ts` | Graph rules: typed ports, unattended-never-merges, read-only reviewers, missing guardrails |
| `src/lib/workflow/compile.ts` | Graph → `.relay/config.json` + `.github/workflows/*.yml` + SETUP.md |
| `src/lib/workflow/simulate.ts` | Deterministic, seeded run simulator |
| `src/lib/workflow/templates.ts` | Starter workflows, built against the live catalog so they never reference a missing node |
| `src/lib/store.ts` | zustand + localStorage: workflows, runs, connections, settings, brand |
| `src/lib/agents/bridge.ts`, `src/app/api/agents/` | The local bridge: asks the vendor CLIs whether they are signed in and starts their own login flows |
| `src/components/builder/` | Canvas, node, palette, inspector, run panel, export dialog |
| `src/components/ui/` | shadcn/ui (base-nova style, Base UI primitives) |
| `src/components/watermelon/` | Watermelon UI components installed from its registry |
| `src/components/*.tsx` | shadcnblocks blocks (hero7, feature43, pricing2, faq3, cta4, footer7, logos3, changelog1, …) |

`npm run gen:icons` (run automatically before `dev` and `build`) scans the catalog for `si:` / `lucide:` icon names and generates `src/lib/connectors/icons.generated.ts`, so the bundle carries only the brand marks it uses. Names that do not resolve fall back to a monogram.

## Adding a connector

Add a `defineConnector({...})` entry to one of the catalog files. Triggers and actions become palette nodes automatically; `fields` become the inspector form; `PORTS.issueOut` / `PORTS.runIn` / `PORTS.changeIn` give the node typed handles so the canvas refuses nonsense connections.

## What is real and what is simulated

| Real | Simulated |
|---|---|
| The catalog, the graph, validation, the compiler and its output files | Runs (phases, costs, refusals, PR numbers) |
| Signing in to Claude Code and Codex, and reading their status | |
| Export to a repository, which then runs on GitHub Actions | Connections ("Connect" stores a local flag) |
| Brand rename, import/export of your data | Approvals (auto-approved after a delay) |
