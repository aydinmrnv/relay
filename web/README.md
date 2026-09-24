# Workflow studio

The Relay product: an n8n-style, node-based workflow builder for coding agents. A workflow is a trigger, the guardrails in front of the agents, the agent pipeline, and delivery and notifications after it; the studio is where you draw one, test-run it, and export it to run for real. The [root README](../README.md) describes the product; this file is how the studio is built.

Relay is headed for a hosted, online product. Today the studio is a web app you run yourself: it keeps everything in your browser's storage, costs nothing, and hosts nothing, and exported workflows run on your own GitHub Actions minutes through the engine in `src/` ([reference](../docs/cli.md)).

```bash
cd web
npm install
npm run dev        # http://localhost:3000
```

## What it does

Every screen says what it is for, and every concept has a "?" that explains it; the **Guide** (`/guide`) collects all of them, with a walkthrough from zero to an exported workflow.

- **Builder** (`/workflows/<id>`): a React Flow canvas with typed, colour-coded ports. Add nodes from the palette (building blocks first, then every app), by pressing <kbd>A</kbd>, with the **+** on a node, or by dropping a dragged connection on empty canvas — the picker then lists only nodes that fit and connects the new one for you. Branch edges are labelled ("Refused", "True"), and hovering an edge offers to delete it. Undo/redo, copy/paste, duplicate, tidy layout, a right-click menu and keyboard shortcuts (<kbd>?</kbd> lists them). With nothing selected, the right-hand panel reads the workflow back in plain English, lists what it needs (apps to connect, agents to sign in) and every check; with a node selected it shows its settings, **How it works** (what the node will do with those settings, and what it takes in and hands on), and what it did in the last run. A first-visit tour (Watermelon UI's feature tour) explains the layout, and can be replayed from the help menu.
- **Test runs**: play the workflow with a sample ticket, or your own JSON payload, with the same phases, review rounds, budgets and refusals as the real pipeline. Nodes and edges light up as the run travels; the bottom panel shows the phase, progress, cost and timeline. Runs can also be started from the Workflows and Runs pages.
- **Validation** mirrors the CLI's rules (unattended never merges, reviewers must be read-only, missing guardrails) and blocks test runs and export only for real errors.
- **Export** compiles the graph to `.relay/config.json` (what the CLI reads today), a GitHub Actions workflow that runs it on your own minutes, a SETUP.md and the graph JSON, as one `.zip` that unzips into the repository at the right paths, with the secrets to add and where each comes from. What the canvas cannot express in those files is listed as a warning, never dropped. A paused workflow exports with its trigger switched off.
- **Workflows**, **Runs** (filters, live progress, run again, cancel, delete, per-run timeline and phase breakdown), **Integrations** (every app with what each trigger and action does, and "start a workflow from this trigger"), **Templates** (graph previews and a step-by-step walkthrough), **Dashboard** (getting-started checklist, activity, spend, what needs attention), **Settings** and the **Guide**.
- **Landing page** at `/`: what the product does and how, with an animated diagram of the pipeline (21st.dev animated beams), the real compiler output for a template, honest pricing and a FAQ.

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
| `src/lib/glossary.ts` | Every concept the studio explains, once; help popovers and the guide read from here |
| `src/lib/connectors/` | Connector catalog (`catalog/core.ts`, `catalog/dev.ts`, `catalog/business.ts`), node-type registry, search |
| `src/lib/workflow/schema.ts` | Saved shape of a workflow and a run, free of React Flow types |
| `src/lib/workflow/validate.ts` | Graph rules: typed ports, unattended-never-merges, read-only reviewers, missing guardrails |
| `src/lib/workflow/describe.ts` | A graph read aloud: the plain-English steps shown in the builder and the template preview |
| `src/lib/workflow/compile.ts` | Graph → `.relay/config.json` + `.github/workflows/*.yml` + SETUP.md |
| `src/lib/workflow/simulate.ts` | Deterministic, seeded run simulator |
| `src/lib/workflow/templates.ts` | Starter workflows, built against the live catalog so they never reference a missing node or port |
| `src/lib/run-launcher.ts` | Starts a test run from any screen and records it live |
| `src/lib/store.ts` | zustand + localStorage: workflows, runs, connections, settings, brand, tours |
| `src/lib/zip.ts` | The dependency-free zip writer behind "Download .zip" |
| `src/lib/agents/bridge.ts`, `src/app/api/agents/` | The local bridge: asks the vendor CLIs whether they are signed in and starts their own login flows |
| `src/components/builder/` | Canvas, node, edge, node picker, palette, inspector, run panel, export and payload dialogs, tour |
| `src/components/app/` | Shell (sidebar, header, ⌘K, shortcuts), `PageHeader`, `HelpTip`, `StatusBadge` |
| `src/components/{dashboard,runs,integrations,templates,settings,guide,marketing}/` | The pieces of each screen |
| `src/components/motion/` | The shared motion.dev entrances; all animation honours Settings → Animations and reduced motion |
| `src/components/ui/` | shadcn/ui (base-nova style, Base UI primitives) |
| `src/components/watermelon/` | Watermelon UI components installed from its registry |
| `src/components/21st/` | 21st.dev community components (Magic UI, Motion Primitives). 21st.dev's own registry requires a signed-in API key, so these were taken from the authors' public registries and adapted where they created components during render |

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
| Validation, the plain-English description, the zip export | |

The simulated column is what the hosted product replaces: runs on a fresh runner, real webhooks for every connector, and approvals from Slack and email. Until then, the export is how a workflow runs for real.
