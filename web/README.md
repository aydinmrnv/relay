# Workflow studio

The Relay product: an n8n-style, node-based workflow builder for coding agents. A workflow is a trigger, the guardrails in front of the agents, the agent pipeline, and delivery and notifications after it; the studio is where you draw one, test-run it, and export it to run for real. The [root README](../README.md) describes the product; this file is how the studio is built.

The studio is live at <https://relay-olive-omega.vercel.app> and runs locally with the commands below. Guests keep everything in their browser's storage; an account keeps workflows, runs and settings in Postgres and adds share links and version history (see [Accounts](#accounts)). What needs the user's machine — agent sign-in, real runs, installing an export — goes through `relay connect`, the CLI in `src/` acting as the studio's companion (see [Your machine](#your-machine-relay-connect)); exported workflows run on your own GitHub Actions minutes through the same CLI ([reference](../docs/cli.md)).

```bash
cd web
npm install
npm run dev        # http://localhost:3000 — accounts included, on an embedded Postgres in .data/pglite
```

## What it does

Every screen says what it is for, and every concept has a "?" that explains it; the **Guide** (`/guide`) collects all of them, with a walkthrough from zero to an exported workflow.

- **Builder** (`/workflows/<id>`): a React Flow canvas with typed, colour-coded ports. Add nodes from the palette (building blocks first, then every app), by pressing <kbd>A</kbd>, with the **+** on a node, or by dropping a dragged connection on empty canvas — the picker then lists only nodes that fit and connects the new one for you. Branch edges are labelled ("Refused", "True"), and hovering an edge offers to delete it. Undo/redo, copy/paste, duplicate, tidy layout, a right-click menu and keyboard shortcuts (<kbd>?</kbd> lists them). With nothing selected, the right-hand panel reads the workflow back in plain English, lists what it needs (apps to connect, agents to sign in) and every check; with a node selected it shows its settings, **How it works** (what the node will do with those settings, and what it takes in and hands on), and what it did in the last run. A first-visit tour (Watermelon UI's feature tour) explains the layout, and can be replayed from the help menu.
- **Test runs**: play the workflow with a sample ticket, or your own JSON payload, with the same phases, review rounds, budgets and refusals as the real pipeline. Nodes and edges light up as the run travels; the bottom panel shows the phase, progress, cost and timeline. Runs can also be started from the Workflows and Runs pages.
- **Runs on your machine**: with `relay connect` running, *Run on this machine* (the menu next to Test run) runs the pipeline for real in the paired repository, on an issue or a description, and lights up the same canvas from the engine's own stream. The dialog says where, with which agents, how far delivery goes (never past a pull request) and what stops it.
- **Validation** mirrors the CLI's rules (unattended never merges, reviewers must be read-only, missing guardrails) and blocks test runs and export only for real errors.
- **Export** compiles the graph to `.relay/config.json` (what the CLI reads today), a GitHub Actions workflow that runs it on your own minutes, a SETUP.md and the graph JSON, installed straight into the repository through `relay connect` (an existing config is merged) or as one `.zip` that unzips into it at the right paths, with the secrets to add and where each comes from. What the canvas cannot express in those files is listed as a warning, never dropped. A paused workflow exports with its trigger switched off.
- **Workflows**, **Runs** (filters, live progress, run again, cancel, delete, per-run timeline and phase breakdown), **Integrations** (every app with what each trigger and action does, and "start a workflow from this trigger"), **Templates** (graph previews and a step-by-step walkthrough), **Dashboard** (getting-started checklist, activity, spend, what needs attention), **Settings** and the **Guide**.
- **Landing page** at `/`: what the product does and how, with an animated diagram of the pipeline (21st.dev animated beams), what sets it apart, the real compiler output for a template, honest pricing and a FAQ. `/privacy` and `/terms` say what an account stores.
- **Accounts** (`/sign-up`, `/sign-in`): [Clerk](https://clerk.com), styled with the shadcn theme inside the studio's own sign-in layout — email and password, Google, GitHub, verification, password reset, two-factor and bot protection are Clerk's. Settings → Account embeds Clerk's profile (email, password, connected accounts, devices) next to importing guest work and deleting the account with everything in it.
- **Onboarding** (`/onboarding`, straight after sign-up): who you are, where tickets come from and where results go, which agents and how hard they review, and a repository; then a first workflow drafted from those answers (or a template, a sentence, or a blank canvas), and the `relay connect` command.
- **Describe it**: a sentence becomes a graph as you type (`src/lib/workflow/from-description.ts`), deterministically, from the live catalog — no model call. In onboarding, on the Workflows page and in the New workflow menu.
- **Spend forecast**: the builder's $ button and the side panel run a few hundred seeded simulations of the graph and show cost per run (typical and 90th percentile), a monthly projection at a chosen ticket volume, outcomes, where the money goes and how the budget gate will behave (`src/lib/workflow/forecast.ts`).
- **Share and remix**: Share in the builder publishes a redacted snapshot at `/s/<slug>` (secrets, logins and the repository blanked) with a README badge from `/api/badge/<slug>`; anyone can remix it into their own studio.
- **Version history**: the builder's clock button lists automatic snapshots (one before each editing session) and named versions; restoring is an undoable canvas edit.

## Accounts

People are [Clerk](https://clerk.com) users; the studio's own database (Postgres through Drizzle) holds only their workspace, workflows, runs, versions and share links, keyed by Clerk user id. `src/proxy.ts` runs Clerk's middleware, `src/server/auth.ts` reads the session (`auth()`, verified locally), `src/server/db/` holds the schema and the migrations (applied once per server process, in one transaction under an advisory lock), and `src/app/api/` has the routes. Without `DATABASE_URL`, development uses PGlite in `.data/pglite`, and without Clerk keys the Clerk SDK runs in keyless mode, so `npm run dev` has working accounts with nothing to set up. In production both the Clerk keys and `DATABASE_URL` are required; a build without them is the browser-only studio with sign-up switched off. Every variable is in [`.env.example`](.env.example).

The browser keeps using the same zustand store. Clerk says who is signed in (`ClerkBridge` in `src/components/providers.tsx`), including sign-ins and sign-outs in other tabs; signing in swaps the store's contents for the account's (`src/lib/cloud/sync.ts`). After that every change to a workflow, a finished run or a setting is diffed out of the store, queued in localStorage until the server confirms it, and sent a moment later, coalesced and retried, with a fresh Clerk token. A guest's work is set aside on sign-in, offered for import during onboarding, and put back on sign-out. A guest never touches the studio's server.

| Route | What |
|---|---|
| `DELETE /api/account` | Deletes everything the studio holds for the person, then their Clerk user |
| `POST /api/webhooks/clerk` | Clerk's `user.deleted` event, so an account deleted in Clerk takes its studio data with it (needs `CLERK_WEBHOOK_SIGNING_SECRET`) |
| `GET/PATCH /api/workspace` | Everything a signed-in studio needs; settings, name, connections and tours |
| `POST /api/workspace/onboarding`, `/import` | Onboarding answers; bringing guest work or an export into the account |
| `PUT/DELETE /api/workflows/:id`, `/api/runs/:id`, `DELETE /api/runs` | Sync. A save names the revision it is based on; a stale one gets a 409 with the server's copy, and the studio keeps both (the other as a "conflicted copy") |
| `/api/workflows/:id/versions[/:versionId]` | Version history |
| `/api/workflows/:id/share`, `POST /api/share/:slug/remix` | Publishing, refreshing and withdrawing a share link; counting remixes |
| `/api/badge/:slug` | The README badge (SVG) |
| `GET /api/capabilities` | Which sign-in methods this deployment has, read at run time |
| `GET /api/health` | Up, database reachable, which sign-in methods are on |

Every mutating route checks the session, rejects cross-site origins, bounds its body size and validates it with zod. Sync requests also name the account they belong to (`x-relay-user`), so a tab left open after someone else signs in elsewhere cannot write into their account. Share links publish an allowlisted copy (`src/lib/workflow/redact.ts`): choices, numbers and plain text pass; secrets, links, email addresses and people's logins do not.

## The hosted demo

A build deployed anywhere public is also a demo for visitors who do not sign in. `NEXT_PUBLIC_HOSTED_DEMO=1` (on by default for any build Vercel runs) puts a one-line banner on every screen saying test runs are simulated, pointing at `/connect`. Nothing else changes — the builder, validation, export and test runs run entirely in the browser, a first visit is seeded with the starter workflows and a few runs, and a visitor who runs `relay connect` pairs the hosted studio with their own machine exactly as they would a local one. The server is never involved: the browser talks to the companion on 127.0.0.1 directly.

```bash
cd web
npx vercel@latest --prod                       # Vercel: nothing to configure
NEXT_PUBLIC_HOSTED_DEMO=1 npm run build        # anywhere else that runs `next start`
```

## Your machine (`relay connect`)

The studio has no server-side access to anyone's machine. `relay connect`, run in the repository a workflow works on, starts the Relay CLI's companion on `127.0.0.1:4477` and opens `/connect#port=…&token=…` to pair this browser with it ([the CLI side](../docs/cli.md#the-studio-companion)). The studio then calls it straight from the browser:

| Route | What the studio uses it for |
|---|---|
| `GET /v1/hello` | Whether the companion is there, and — with the token — the machine, the repository and what it can do |
| `GET /v1/agents`, `POST /v1/agents/{claude\|codex}/login`, `/logout`, `/v1/logins/:id[/code]` | Sign-in state, and the vendor CLIs' own login flows (Settings → Coding agents) |
| `POST /v1/runs`, `GET /v1/runs/:id/events`, `DELETE /v1/runs/:id` | *Run on this machine* in the builder: start, follow (NDJSON, replayed from the first line after a reload), stop |
| `POST /v1/install` | *Install into the repository* in the export dialog |

- Nothing is probed before pairing, so a browser never asks a visitor who has not run `relay connect` about reaching their machine.
- The pairing (`port`, `token`) is kept under its own localStorage key, `relay-companion`, outside the studio's data: *Download all my data* never carries it.
- A machine run is the engine's own `relay run --json` stream folded into the same `Run` record a test run produces (`src/lib/companion/machine-run.ts`), marked `source: 'machine'`, so the canvas, run panel and Runs pages show it the same way — with measured numbers.

## Bring your own subscription

There are no API keys to paste. Claude Code signs in with your Claude plan and Codex with your ChatGPT plan. Through the companion, the studio asks `claude auth status --json` and `codex login status` for the sign-in state, plan and account label only, and starts `claude auth login` / `codex login` (or `codex login --device-auth`), showing you the URL or device code the CLI prints and relaying the authorization code Claude asks for straight to the CLI's stdin. Nothing is logged or kept.

For GitHub Actions, the export uses the vendors' supported ways of carrying a personal plan into CI: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and `CODEX_AUTH_JSON` holding `~/.codex/auth.json` (OpenAI's documented method; not for public repositories). Settings can switch either agent to an API key instead.

On Relay Cloud the same sign-ins happen on a cloud machine of each user's own, reached through the hub with the person's Clerk session. That machine offers only the flows a machine without a browser can finish: Claude's paste-code page, and Codex's and GitHub's device codes. With `RELAY_CLOUD_HUB_URL` set, Settings → Where agents run offers **Relay Cloud** to signed-in people, next to **This machine**; `src/lib/companion/client.ts` sends the same requests to either, and every machine run remembers which one it started on. See [how it works](../docs/design/relay-cloud-runners.md).

## The name is not decided

Nothing hard-codes "Relay". The default comes from `NEXT_PUBLIC_PRODUCT_NAME` (and `NEXT_PUBLIC_PRODUCT_TAGLINE`) at build time; the settings page overrides it at runtime and stores the override locally. Slugs, trigger labels, branch prefixes, exports and page titles all follow.

```bash
NEXT_PUBLIC_PRODUCT_NAME="Conductor" npm run dev
```

## Where things live

| Path | What |
|---|---|
| `src/server/` | Everything that runs only on the server: environment (`env.ts`), database and migrations (`db/`), the Clerk session (`auth.ts`), request helpers (`api.ts`), validation (`validate.ts`) and the queries behind the routes (`studio.ts`) |
| `src/lib/cloud/` | The browser's side of accounts: who is signed in (`account.ts`), the sync engine and guest hand-over (`sync.ts`) |
| `src/components/{auth,account,onboarding,share}/` | Sign-in pages, account menu and settings, the onboarding wizard, the public share page |
| `src/lib/workflow/from-description.ts`, `forecast.ts` | Describe-to-workflow and the spend forecast |
| `src/lib/brand.ts` | The product name and everything derived from it |
| `scripts/gen-brand.mjs` | Draws the logo from the CLI's pixel font (`../src/ui/logo.ts`): `src/app/icon.svg`, `src/lib/pixel-font.generated.ts` and `public/brand/`. Run `npm run gen:brand` by hand after changing the font or the mark; `-- --png` also renders the PNGs, favicon.ico and the social card (`scripts/brand-banner.html`) with a local Chrome, Brave or Edge |
| `src/lib/hosted.ts` | Whether this build is the public demo |
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
| `src/lib/companion/` | The studio's side of `relay connect`: pairing and calls (`client.ts`), the protocol (`types.ts`), and a machine run folded into a `Run` (`machine-run.ts`) |
| `src/lib/agents/types.ts`, `src/hooks/use-agent-accounts.ts` | Sign-in state of the coding CLIs, asked through the companion |
| `src/components/companion/` | The `/connect` pairing page and Settings → This machine |
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
| Accounts, sync, share links, remixes, version history | |
| The catalog, the graph, validation, the compiler and its output files, describe-to-workflow | Test runs (phases, costs, refusals, PR numbers), and the spend forecast built from them |
| Through `relay connect`: signing in to Claude Code and Codex, runs on your machine, installing an export | |
| Export to a repository, which then runs on GitHub Actions | Connections ("Connect" stores a local flag) |
| Brand rename, import/export of your data | Approvals (auto-approved after a delay) |
| Validation, the plain-English description, the zip export | |

The simulated column is what the hosted product replaces: real webhooks for every connector, and approvals from Slack and email. A workflow runs for real on your machine through `relay connect`, on your own Relay Cloud machine ([how](../docs/design/relay-cloud-runners.md)), or unattended through its export.
