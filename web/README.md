# Workflow studio

The Relay product: a node-based workflow builder for coding agents. A workflow is a trigger, the guardrails in front of the agents, the agent pipeline, and delivery and notifications after it; the studio is where you draw one, test-run it, and export it to run for real. The [root README](../README.md) describes the product; this file is how the studio is built.

The studio is live at <https://relay-olive-omega.vercel.app> and runs locally with the commands below. The studio needs an account (only a development copy without Clerk keys lets guests in, keeping everything in their browser's storage), and the playground at `/play` is the builder without one; an account keeps workflows, runs and settings in Postgres and adds share links and version history (see [Accounts](#accounts)). What needs the user's machine — agent sign-in, real runs, installing an export — goes through `relay connect`, the CLI in `src/` acting as the studio's companion (see [Your machine](#your-machine-relay-connect)); exported workflows run on your own GitHub Actions minutes through the same CLI ([reference](../docs/cli.md)).

```bash
cd web
npm install
npm run dev        # http://localhost:3000, on an embedded Postgres in .data/pglite
npm test           # the pure modules: redirects, the compiler, redaction
```

Without Clerk keys that is the browser-only studio, with accounts switched off; `npx clerk env pull` adds accounts. [Deploying](#deploying) lists what a production deployment needs.

```bash
npm run lint && npm run typecheck && npm run build
```

## What it does

Every screen says what it is for, and every concept has a "?" that explains it; the **Guide** (`/guide`) collects all of them, with a walkthrough from zero to an exported workflow.

- **Builder** (`/workflows/<id>`): a React Flow canvas with typed, colour-coded ports. Add nodes from the palette (building blocks first, then every app), by pressing <kbd>A</kbd>, with the **+** on a node, or by dropping a dragged connection on empty canvas — the picker then lists only nodes that fit and connects the new one for you. Branch edges are labelled ("Refused", "True"), and hovering an edge offers to delete it. Undo/redo, copy/paste, duplicate, tidy layout, a right-click menu and keyboard shortcuts (<kbd>?</kbd> lists them). With nothing selected, the right-hand panel reads the workflow back in plain English, lists what it needs (apps to connect, agents to sign in) and every check; with a node selected it shows its settings, **How it works** (what the node will do with those settings, and what it takes in and hands on), and what it did in the last run. A first-visit tour (Watermelon UI's feature tour) explains the layout, and can be replayed from the help menu.
- **Test runs**: play the workflow with a sample ticket, or your own JSON payload, with the same phases, review rounds, budgets and refusals as the real pipeline. Nodes and edges light up as the run travels; the bottom panel shows the phase, progress, cost and timeline. Runs can also be started from the Workflows and Runs pages.
- **Runs for real**: with `relay connect` running, *Run on this computer* (the menu next to Test run) runs the pipeline for real in the paired repository, on an issue or a description, and lights up the same canvas from the engine's own stream. The dialog says where, with which agents, how far delivery goes (never past a pull request) and what stops it. With Relay Cloud on the same deployment the menu reads *Run in Relay Cloud* instead, and asks which repository the run works in.
- **Validation** mirrors the CLI's rules (unattended never merges, reviewers must be read-only, missing guardrails) and blocks test runs and export only for real errors.
- **Export** compiles the graph to `.relay/config.json` (what the CLI reads today), a GitHub Actions workflow that runs it on your own minutes, a SETUP.md and the graph JSON, installed straight into the repository through `relay connect` (an existing config is merged) or as one `.zip` that unzips into it at the right paths, with the secrets to add and where each comes from. What the canvas cannot express in those files is listed as a warning, never dropped. Only a label on a GitHub issue starts an exported workflow by itself; any other trigger exports as a workflow you start by hand, and the export says so. A workflow with errors, a placeholder allowlist or no repository does not export. A paused workflow exports with its trigger switched off, and templates start paused.
- **Workflows**, **Runs** (filters, live progress, run again, cancel, delete, per-run timeline and phase breakdown), **Integrations** (apps grouped by the job they do, what teams use each for, the templates that use it, and what each trigger and action does), **Templates** (grouped by job, with who each is for, how it runs today, graph previews and a step-by-step walkthrough), **Dashboard** (getting-started checklist, activity, spend, what needs attention), **Settings** and the **Guide**.
- **Playground** at `/play`, called the demo wherever a visitor meets it: the builder for someone without an account, on every deployment, whether or not it has sign-in or a database. One canvas, kept in the browser's storage, opened on a template; "Start from" swaps in another template, a sentence or a blank canvas, and a test run's page is `/play/runs/<id>`. It is outside `STUDIO_ROUTES` and the proxy's matcher on purpose, asks the server nothing, and sends someone signed in to the studio instead. What it leaves out is what an account adds: share links, version history, sync, and the screens around the builder.
- **Injection screen**: a guardrail node that refuses a ticket whose text matches a known prompt-injection phrasing. In a test run it screens the ticket and whatever is typed in its "Try it" field with the engine's own patterns (`src/lib/workflow/injection.ts` is a copy of the CLI's `src/unattended/injection.ts`, and `test/injection.test.ts` fails when they differ); the export writes its setting to `unattended.injectionScreen`, where the engine enforces it. The playground's *Start from → A hostile issue* opens a workflow with one already in front of a hostile description.
- **Recordings** at `/r`: a finished run, played back. `/r/<slug>` plays one of the recordings in `public/recordings` (listed in `src/lib/replay/builtin.ts`), and `/r` also opens a file from `relay recording`, read in the browser and never uploaded. The file's `relay run --json` stream goes through the same fold a run on a paired machine does (`MachineRunFold`), so the canvas, the timeline and the phase list are the ones the studio already has; folding the first *n* lines is the run at that moment, which is the scrubber. Beside it are the receipts, both debates, the patches, the plan and the test log, each shown only once the replay has reached the time it was produced. A recording is untrusted input: `parseRecording` checks and bounds it, everything is rendered as text, and the only links made from it are a pull request and an issue on github.com. Nothing here needs an account or a database.
- **Landing page** at `/`: what the product does and how, with an interactive walk through a sample pipeline, what sets it apart, the real compiler output for a template, honest pricing and a FAQ. `/privacy` and `/terms` say what an account stores.
- **Accounts** (`/sign-up`, `/sign-in`): [Clerk](https://clerk.com), styled with the shadcn theme inside the studio's own sign-in layout — email and password, Google, GitHub, verification, password reset, two-factor and bot protection are Clerk's. Settings → Account embeds Clerk's profile (email, password, connected accounts, devices) next to importing guest work and deleting the account with everything in it.
- **Projects** (`/projects`, and the switcher at the top of the sidebar): a project is one repository and where its workflows run — its own GitHub Actions, the person's computer, or Relay Cloud. A workflow belongs to the project whose repository it is attached to, so a project holds no list of its own (`src/lib/projects.ts`); the dashboard, the workflow list and the run history show the project in view, and a new workflow attaches to it. Projects are kept in the workspace's settings, so they sync with the account and need no table.
- **Setup** (`/onboarding` straight after sign-up, `/projects/new` for another repository; `src/components/onboarding/setup-wizard.tsx`): the repository, looked up on GitHub's public API from the browser with no token (a private one cannot be seen, and need not be); where it runs; a first workflow from the starters in `src/lib/workflow/starters.ts` (two shown, the rest under "More options"); who may start it, with the label, budget, agents and review depth shown as defaults behind one "Change"; then the install steps, a list that opens one step at a time for that runner (`src/components/projects/install-guide.tsx`): the files to commit, the agents' secrets, letting Actions open pull requests, and the label that starts a run. How a workflow starts on a runner is read from the compiler and the readiness table, not written on the card. A new account that has nothing yet is sent here from the dashboard.
- **Describe it**: a sentence becomes a graph as you type (`src/lib/workflow/from-description.ts`), deterministically, from the live catalog — no model call. In onboarding, on the Workflows page and in the New workflow menu.
- **Spend forecast**: the builder's $ button and the side panel run a few hundred seeded simulations of the graph and show cost per run (typical and 90th percentile), a monthly projection at a chosen ticket volume, outcomes, where the money goes and how the budget gate will behave (`src/lib/workflow/forecast.ts`).
- **Share and remix**: Share in the builder publishes a redacted snapshot at `/s/<slug>` (secrets, links, email addresses, logins and the repository removed; the page is not indexed) with a README badge from `/api/badge/<slug>`; anyone can remix it into their own studio.
- **Version history**: the builder's clock button lists automatic snapshots (one before each editing session) and named versions; restoring is an undoable canvas edit.

## Accounts

People are [Clerk](https://clerk.com) users; the studio's own database (Postgres through Drizzle) holds only their workspace, workflows, runs, versions and share links, keyed by Clerk user id. `src/proxy.ts` runs Clerk's middleware, `src/server/auth.ts` reads the session (`auth()`, verified locally), `src/server/db/` holds the schema and the migrations (applied once per server process, in one transaction under an advisory lock), and `src/app/api/` has the routes. Without `DATABASE_URL`, development uses PGlite in `.data/pglite`, so `npm run dev` starts with nothing set up. Clerk is the exception: its middleware throws without keys, so accounts need `npx clerk env pull` (or the two keys by hand) in any environment. Without them, development serves the browser-only studio to guests and `/sign-in` says why; a production build keeps the site up but closes the studio (`GUEST_STUDIO` in `src/server/env.ts`), and `/sign-in` says sign-in is not available. With accounts, `src/proxy.ts` sends signed-out visits to the studio's screens (`src/lib/studio-routes.ts`) to `/sign-in?next=…`, which signs people in or makes them an account in one form (Clerk's `withSignUp`). The site's "Get started" goes to `/sign-up`, and from there into setup; "Sign in" goes to `/sign-in`, and from there to the dashboard. A deployment without accounts has neither: its one button says "Try the demo" and opens the playground. Sign out is in the sidebar's account menu and the site header's. Every variable is in [`.env.example`](.env.example).

The browser keeps using the same zustand store. Clerk says who is signed in (`ClerkBridge` in `src/components/providers.tsx`), including sign-ins and sign-outs in other tabs; signing in swaps the store's contents for the account's (`src/lib/cloud/sync.ts`). After that every change to a workflow, a finished run or a setting is diffed out of the store, queued in localStorage until the server confirms it, and sent a moment later, coalesced and retried, with a fresh Clerk token. A guest's work is set aside on sign-in, offered for import during onboarding, and put back on sign-out. A guest never touches the studio's server.

| Route | What |
|---|---|
| `DELETE /api/account` | Deletes everything the studio holds for the person, then their Clerk user |
| `POST /api/webhooks/clerk` | Clerk's `user.deleted` event, so an account deleted in Clerk takes its studio data with it (needs `CLERK_WEBHOOK_SIGNING_SECRET`) |
| `GET/PATCH /api/workspace` | Everything a signed-in studio needs, within a size budget (the rest is fetched by id); settings, name and tours |
| `POST /api/workspace/onboarding`, `/import` | Onboarding answers; bringing guest work or an export into the account |
| `GET/PUT/DELETE /api/workflows/:id`, `/api/runs/:id`, `DELETE /api/runs` | Sync. A save names the revision it is based on; a stale one gets a 409 with the server's copy, and the studio keeps both (the other as a "conflicted copy") |
| `/api/workflows/:id/versions[/:versionId]` | Version history |
| `/api/workflows/:id/share`, `POST /api/share/:slug/remix`, `/view` | Publishing, refreshing and withdrawing a share link; counting remixes and views |
| `PUT/DELETE /api/connections/:connectorId`, `POST …/check`, `…/test`, `DELETE /api/connections` | App connections: a Slack or Discord webhook, or another app's API token, checked with the app and sealed with `RELAY_CREDENTIALS_KEY` before it is stored; checking one again; sending a test message through a webhook; removing all of them |
| `/api/badge/:slug`, `/s/:slug/opengraph-image` | The README badge (SVG) and the share page's social card |
| `GET /api/capabilities` | What this deployment has (accounts, guests, Relay Cloud, real connections), read at run time |
| `GET /api/health` | 200 when the deployment can do its job. In production that needs the database, both Clerk keys, the credentials key and the deletion webhook secret; otherwise 503 with what is missing |

Every mutating route checks the session, rejects cross-site origins, bounds its body size, validates it with zod and is rate limited per person (a fixed window counted in Postgres, since memory is per instance on serverless). An account holds at most 300 workflows and 60 MB. Sync requests also name the account they belong to (`x-relay-user`), so a tab left open after someone else signs in elsewhere cannot write into their account. Share links publish an allowlisted copy (`src/lib/workflow/redact.ts`): choices, numbers and plain text pass; secrets, links, email addresses and people's logins do not.

## Deploying

A production deployment is a Next.js server with a Postgres database and Clerk. It needs, from [`.env.example`](.env.example):

| Variable | Why |
|---|---|
| `DATABASE_URL` | A Postgres database of the studio's own. Tables are created and migrated on first request |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Accounts. Without them a production build keeps the site up and closes the studio |
| `RELAY_CREDENTIALS_KEY` | Seals the webhooks and API tokens people connect apps with. Without it apps can only be marked ready |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Removes the data of an account deleted in Clerk's dashboard |

`/api/health` answers 503 and names what is missing until all four are set, so point the host's health check at it. `RELAY_CLOUD_HUB_URL` is optional: with it the studio offers Relay Cloud to signed-in people, and without it Relay Cloud is described as an invite-only beta nobody can switch on here.

```bash
cd web
npx vercel@latest --prod        # after the variables above are set on the project
npm run build && npm start      # anywhere else that runs a Node server
```

A hosted build says what is simulated: a one-line banner on the studio's screens says test runs are played back in the browser and points at `/runners`. It is on for any build Vercel runs; elsewhere, build with `NEXT_PUBLIC_HOSTED_DEMO=1`. The studio's server stores accounts, workflows, runs, share links and app connections; it never reaches anyone's computer. Pairing with `relay connect` is between the browser and 127.0.0.1.

## Your machine (`relay connect`)

The studio has no server-side access to anyone's machine. `relay connect`, run in the repository a workflow works on, starts the Relay CLI's companion on `127.0.0.1:4477` and opens `/connect#port=…&token=…` to pair this browser with it ([the CLI side](../docs/cli.md#the-studio-companion)). The studio then calls it straight from the browser:

| Route | What the studio uses it for |
|---|---|
| `GET /v1/hello` | Whether the companion is there, and — with the token — the machine, the repository and what it can do |
| `GET /v1/agents`, `POST /v1/agents/{claude\|codex}/login`, `/logout`, `/v1/logins/:id[/code]` | Sign-in state, and the vendor CLIs' own login flows (Settings → Coding agents) |
| `POST /v1/runs`, `GET /v1/runs/:id/events`, `DELETE /v1/runs/:id` | *Run on your computer* in the builder: start, follow (NDJSON, replayed from the first line after a reload), stop |
| `POST /v1/install` | *Install into the repository* in the export dialog |

- Each start of `relay connect` makes its own token, so a studio pairs again after a restart, and the first run or install it asks for is confirmed in the terminal. A studio on `localhost` is answered only with `RELAY_STUDIO_DEV=1 relay connect --studio http://localhost:3000`.
- Nothing is probed before pairing, so a browser never asks a visitor who has not run `relay connect` about reaching their machine.
- The pairing (`port`, `token`) is kept under its own localStorage key, `relay-companion`, outside the studio's data: *Download all my data* never carries it.
- A machine run is the engine's own `relay run --json` stream folded into the same `Run` record a test run produces (`src/lib/companion/machine-run.ts`), marked `source: 'machine'`, so the canvas, run panel and Runs pages show it the same way — with measured numbers.

## Bring your own subscription

There are no API keys to paste. Claude Code signs in with your Claude plan and Codex with your ChatGPT plan. Through the companion, the studio asks `claude auth status --json` and `codex login status` for the sign-in state, plan and account label only, and starts `claude auth login` / `codex login` (or `codex login --device-auth`), showing you the URL or device code the CLI prints and relaying the authorization code Claude asks for straight to the CLI's stdin. Nothing is logged or kept.

For GitHub Actions, the export uses the vendors' supported ways of carrying a personal plan into CI: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and `CODEX_AUTH_JSON` holding `~/.codex/auth.json` (OpenAI's documented method; not for public repositories). Settings can switch either agent to an API key instead.

On Relay Cloud the same sign-ins happen on a cloud machine of each user's own, reached through the hub with the person's Clerk session. That machine offers only the flows a machine without a browser can finish: Claude's paste-code page, and Codex's and GitHub's device codes. With `RELAY_CLOUD_HUB_URL` set, Settings → Where agents run offers **Relay Cloud** to signed-in people, next to **Your computer**; `src/lib/companion/client.ts` sends the same requests to either, and every machine run remembers which one it started on. See [how it works](../docs/design/relay-cloud-runners.md).

## Where things live

| Path | What |
|---|---|
| `src/server/` | Everything that runs only on the server: environment (`env.ts`), database and migrations (`db/`), the Clerk session (`auth.ts`), request helpers (`api.ts`), validation (`validate.ts`) and the queries behind the routes (`studio.ts`) |
| `src/lib/playground.ts`, `src/components/playground/`, `src/lib/studio-links.ts` | The playground: what it opens and when it may (`playground.ts`), its frame and "Start from" menu, and the links that keep the builder and a run's page inside it |
| `src/lib/replay/`, `src/components/replay/`, `public/recordings/` | Recordings: the file's shape and its validator (`types.ts`, `parse.ts`), the fold and the scrubber's stops (`fold.ts`), the ones that ship (`builtin.ts`), and the page: receipts, reviews, diff |
| `src/lib/cloud/` | The browser's side of accounts: who is signed in (`account.ts`), the sync engine and guest hand-over (`sync.ts`) |
| `src/components/companion/` | Runners: the machine cards, `relay connect`'s pairing page, and the local-or-cloud comparison (`runner-compare.tsx`), whose wording every screen that names the choice reads |
| `src/components/{auth,account,onboarding,share}/` | Sign-in pages, account menu and settings, the onboarding wizard, the public share page |
| `src/lib/workflow/from-description.ts`, `forecast.ts` | Describe-to-workflow and the spend forecast |
| `src/lib/brand.ts`, `src/lib/links.ts` | The product's name and tagline; the repository, install command, Action reference, operator and support address every screen quotes |
| `scripts/gen-brand.mjs` | Draws the logo from the CLI's pixel font (`../src/ui/logo.ts`): `src/app/icon.svg`, `src/lib/pixel-font.generated.ts` and `public/brand/`. Run `npm run gen:brand` by hand after changing the font or the mark; `-- --png` also renders the PNGs, favicon.ico and the social card (`scripts/brand-banner.html`) with a local Chrome, Brave or Edge |
| `src/lib/hosted.ts` | Whether this build is served from somewhere other than the visitor's computer |
| `src/lib/glossary.ts` | Every concept the studio explains, once; help popovers and the guide read from here |
| `src/lib/connectors/` | Connector catalog (`catalog/core.ts`, `catalog/dev.ts`, `catalog/business.ts`), node-type registry, search |
| `src/lib/workflow/schema.ts` | Saved shape of a workflow and a run, free of React Flow types |
| `src/lib/workflow/validate.ts` | Graph rules: typed ports, unattended-never-merges, read-only reviewers, missing guardrails |
| `src/lib/workflow/describe.ts` | A graph read aloud: the plain-English steps shown in the builder and the template preview |
| `src/lib/workflow/compile.ts` | Graph → `.relay/config.json` + `.github/workflows/*.yml` + SETUP.md |
| `src/lib/workflow/simulate.ts` | Deterministic, seeded run simulator |
| `src/lib/workflow/templates.ts` | Starter workflows, built against the live catalog so they never reference a missing node or port |
| `src/lib/run-launcher.ts` | Starts a test run from any screen and records it live |
| `src/lib/store.ts` | zustand + localStorage: workflows, runs, connections, settings, tours; import and export of your data |
| `src/server/rate-limit.ts`, `src/server/connections.ts`, `src/server/credentials/` | The Postgres-backed rate limiter; app connections and the encryption around them |
| `test/` | `npm test`: Node's test runner over the pure modules, with a resolver for the `@/` alias |
| `src/lib/zip.ts` | The dependency-free zip writer behind "Download .zip" |
| `src/lib/companion/` | The studio's side of `relay connect`: pairing and calls (`client.ts`), the protocol (`types.ts`), and a machine run folded into a `Run` (`machine-run.ts`) |
| `src/lib/agents/types.ts`, `src/hooks/use-agent-accounts.ts` | Sign-in state of the coding CLIs, asked through the companion |
| `src/components/builder/` | Canvas, node, edge, node picker, palette, inspector, run panel, export and payload dialogs, tour |
| `src/components/app/` | Shell (sidebar, header, ⌘K, shortcuts), `PageHeader`, `HelpTip`, `StatusBadge` |
| `src/components/{dashboard,runs,integrations,templates,settings,guide,marketing}/` | The pieces of each screen |
| `src/components/motion/` | The shared motion.dev entrances; all animation honours Settings → Animations and reduced motion |
| `src/components/ui/` | shadcn/ui (base-nova style, Base UI primitives) |
| `src/components/watermelon/` | Watermelon UI components installed from its registry (`hero-1.tsx` keeps the art, call to action and entrance the landing hero uses) |
| `src/components/glass/` | `LiquidGlass`: Apple-style liquid glass. [`@samasante/liquid-glass`](https://github.com/samasante/liquid-glass) frosts and bends the page behind (the bend in Chrome and Edge only), with Apple's milky veil, rim light and shadow on top; frostier and nearly opaque under Reduce Transparency, as on Apple's platforms |
| `src/components/21st/` | 21st.dev community components (Motion Primitives, Magic UI): the border trail and text shimmer that mark a live run, and the dashboard's number ticker. Taken from the authors' public registries, since 21st.dev's own needs a signed-in API key |

### Colour

Ink on paper, and one accent (`src/app/globals.css`). Neutrals carry almost no hue; `primary` is ink, for buttons and emphasis; `signal` is the single accent, the cyan the CLI prints its wordmark in, and it means live, selected, or a link — nothing else. Success, warning and destructive are for statuses only, and a normal outcome (a run that succeeded) reads in ink so the ones that need a look stand out. App marks keep their brand colours; Relay's own building blocks are ink. Depth comes from surface steps and rules, not glows or gradients (the one exception is the landing hero's pixel-grid glow, taken from Watermelon UI's Hero 1 and recoloured in the signal cyan, which the floating liquid-glass header refracts as the page scrolls); content is grouped with whitespace and rules, and boxes are kept for things you act on.

`npm run gen:icons` (run automatically before `dev` and `build`) scans the catalog for `si:` / `lucide:` icon names and generates `src/lib/connectors/icons.generated.ts`, so the bundle carries only the brand marks it uses. Names that do not resolve fall back to a monogram.

## Adding a connector

Add a `defineConnector({...})` entry to one of the catalog files. Triggers and actions become palette nodes automatically; `fields` become the inspector form; `PORTS.issueOut` / `PORTS.runIn` / `PORTS.changeIn` give the node typed handles so the canvas refuses nonsense connections.

## What is real and what is simulated

| Real | Simulated |
|---|---|
| Accounts, sync, share links, remixes, version history | |
| The catalog, the graph, validation, the compiler and its output files, describe-to-workflow | Test runs (phases, costs, refusals, PR numbers), and the spend forecast built from them |
| Through `relay connect`: signing in to Claude Code and Codex, runs on your computer, installing an export | Every app's trigger: only a label on a GitHub issue starts an exported workflow |
| Export to a repository, which then runs on GitHub Actions | App nodes marked "test runs only" in the palette |
| Connections to 20 apps: a Slack or Discord webhook (stored encrypted, with a real test message), or an API token the app confirms (`src/lib/connectors/credentials.ts` lists them) | The other apps' connections ("Mark ready" records a label and signs in to nothing) |
| Import and export of your data | Approvals (decided by the simulator; a real run does not wait for one) |

The simulated column is what is not built yet: webhooks for every connector, and approvals from Slack and email. A workflow runs for real on your machine through `relay connect`, on your own Relay Cloud machine ([how](../docs/design/relay-cloud-runners.md)), or unattended through its export.
