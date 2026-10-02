<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/public/brand/relay-logo-dark.svg">
    <img alt="Relay" src="web/public/brand/relay-logo-light.svg" height="64">
  </picture>
</p>

# Relay

[![CI](https://github.com/aydinmrnv/relay/actions/workflows/ci.yml/badge.svg)](https://github.com/aydinmrnv/relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 22.6 or later](https://img.shields.io/badge/node-%E2%89%A5%2022.6-brightgreen.svg)

**Ticket in. Reviewed PR out.** A workflow studio where Claude Code
and Codex plan, cross-review, implement and test your tickets, behind guardrails
you draw on a canvas.

**[Try it free →](https://relay-olive-omega.vercel.app)** — make a free account
and your workflows, share links and version history follow you to any browser.
Relay is in beta, and free while it is.

![The Relay studio: a Linear-to-pull-request workflow on the canvas](docs/images/studio.png)

Relay is a workflow builder for coding agents, in the spirit of n8n: you draw a
flow on a canvas once — what starts a run, the guardrails in front of it, the
agents, where the result goes and who hears about it — and Relay runs the same
steps every time a ticket arrives, stopping wherever a guardrail says no.

What makes it more than an automation canvas is the node in the middle. The
**Agent pipeline** is not one model call. Claude Code and Codex plan the work,
attack each other's plan against the real code, implement it in an isolated git
worktree, review each other's diff and run your test suite, and every claim they
make is checked against git rather than taken at face value. The result arrives
as a commit, a branch or a draft pull request, as far as you allow.

```
 Linear issue ──▶ Budget gate ──▶ Author allowlist ──▶ Agent pipeline ──▶ Deliver ──▶ Slack message
 assigned                                                                 draft PR    "PR #412 is ready"
 ────────────     ────────────────────────────────     ──────────────     ──────────────────────────────
 trigger          guardrails                           the engine         delivery and notification
```

## Quick start

**Try it free:** <https://relay-olive-omega.vercel.app>. Sign in, or create a
free account in the same form, answer four onboarding questions and get a
first workflow built from your answers. Test runs are simulated, so it costs
nothing to try. (Only a development copy, `npm run dev` without Clerk keys,
opens the studio without an account, keeping your work in your browser.)

**Connect your computer** to make it real. The `relay` CLI is the studio's
companion: run it in the repository your workflows work on, and the studio can
sign in your own Claude Code and Codex, run a workflow for real there, and
install its export.

```bash
npm install -g https://github.com/aydinmrnv/relay/releases/download/cli-latest/relay.tgz
cd ~/code/your-repo
relay connect          # opens the studio and pairs it
```

Your browser asks once whether the studio may reach apps on your device —
choose **Allow**; that is `relay connect`, on 127.0.0.1 only. Each start of
`relay connect` pairs afresh, through the link it opens, and the first run or
install a studio asks for is confirmed in its terminal. (Node 22.6 or later. The tarball is the
CLI prebuilt by CI; `npm install -g github:aydinmrnv/relay` installs an empty
package on current npm.)

1. **Open the studio** and start from a template, or from a blank canvas.
2. **Test-run it** with a sample ticket or your own JSON payload. Nodes and edges
   light up as the run travels, with the same phases, review rounds, budgets and
   refusals as a real run — and it costs nothing, because it is simulated.
3. **Run it on your computer.** With `relay connect` running, pick *Run on your
   computer* next to Test run, name an issue or describe the change, and watch
   the same canvas light up from a real run: the plan, the reviews, the diff,
   the tests and the pull request, with what the CLIs actually charged.
4. **Export it** to run unattended. *Install into your repository* writes the
   engine's config and a GitHub Actions workflow straight into it (or download
   them as a `.zip`), and the export lists each secret to add. Commit them, and
   a label on a GitHub issue starts the workflow on your own Actions minutes.

The **Guide** (`/guide`) walks through the same path and explains every concept
the studio uses.

## What only Relay does

- **Two vendors check each other.** The model that reviews a plan or a diff is
  never the one that wrote it (below).
- **Describe it, get a workflow.** Type one sentence — *"when a Sentry error is
  new, fix it under $3 and ping Discord"* — and the graph builds itself as you
  type. It is a parser over the live connector catalog, in your browser: no model
  call, no credits, nothing sent anywhere.
- **A spend forecast before the first run.** Hundreds of simulated runs of your
  exact graph give a typical and a bad-day cost per run, a monthly bill at your
  ticket volume, and how often your budget gate will refuse.
- **Share, remix and badge.** Publish a workflow at a public link with secrets,
  links, email addresses, logins and your repository name removed; anyone can
  remix it into their own studio, and a README badge points to it.
- **Version history.** A snapshot before every editing session, named versions
  on demand, and a restore you can undo.
- **Your subscriptions, your runners.** No API keys to paste. Agents run on your
  computer or your own Actions minutes, where Relay never sees your code.

| Describe it | Spend forecast |
|---|---|
| ![A sentence becoming a Sentry-to-pull-request workflow as it is typed](docs/images/describe.png) | ![The spend forecast: typical and 90th-percentile cost per run, a monthly projection and where the money goes](docs/images/forecast.png) |

## How a workflow is built

A workflow is a graph of nodes. Every node's ports are typed — an issue, a run,
a change, a message, an event — so the canvas refuses a connection that makes no
sense, like wiring a ticket into something that expects a pull request.

| Building block | Nodes |
|---|---|
| **Triggers** | What hands the agents a task. A label on a GitHub issue starts an exported workflow by itself today, and a manual start works anywhere. The rest can be designed and test-run in the studio, and are not wired to real events yet: a ticket assigned (Linear, Jira, Shortcut), main going red (GitHub Actions, GitLab CI, CircleCI, Buildkite), a new error or crash (Sentry, Datadog, Crashlytics), a security alert (Dependabot, code scanning, Snyk), a flag that finished rolling out, a bug report in Slack or Zendesk, a schedule, a webhook |
| **Guardrails** | Budget gate, author allowlist, human approval, concurrency limit, kill switch. Each refuses by default and says why |
| **Agent pipeline** | Run the pipeline (choose the planner, plan reviewer, implementer and code reviewer, the review depth and the round limits), a fast run with no reviews, or a cost estimate |
| **Delivery** | Deliver the change — commit, branch or draft pull request — and comment the summary on the issue. A run started from the studio or by an event stops at a pull request; only `relay run` at a terminal, with a person there, can be allowed to merge |
| **Logic** | Condition, filter, transform, an AI step for triage or classification, merge paths, wait, wait for business hours, notes. Played in test runs; the export cannot evaluate them, and says which it left out |
| **Actions** | What closes the loop where the work was asked for: move the ticket and attach the PR, ask Slack for review, reply in the thread, link the fix on the Sentry issue, leave support an internal note, call any HTTP endpoint |

Select a node and the side panel shows its settings, what it will do with them,
and what it did in the last test run. Select nothing and the panel reads the
whole workflow back in plain English, with the apps and sign-ins it needs and
every check it has not passed.

### Templates

Each template is a situation teams hand to coding agents, with its guardrails
already in place. Each one says how it runs today: "GitHub label to pull
request" runs unattended through the exported Action, and the others are
started by hand until their triggers are wired to real events. A workflow made
from a template starts paused. The catalog is kept to the ~45 apps these
situations involve; anything else is one Incoming webhook or HTTP request away.

| Template | For when |
|---|---|
| Linear ticket to pull request | Small, well-written tickets sit in the backlog. Assign one to the bot: it comes back In Review with a draft PR attached, and #eng is asked for review |
| GitHub label to pull request | A maintainer hands over an issue with one label, behind a kill switch, an allowlist and a budget. Runs unattended today through the exported Action |
| Price new tickets before anyone picks them up | Every new Linear issue gets an estimate of what an agent run would cost, with no agent called; cheap ones are labelled agent-ready |
| Fix main when CI goes red | The failing job and its log become the task. One fix at a time, under a budget; #builds gets the PR, or the reason there is none |
| Sentry error to fix | A model reads the trace first. Fixable errors get a PR linked on the Sentry issue; ones needing a product decision become a Linear ticket |
| Fix high-severity code scanning alerts | A new CodeQL alert is fixed with a thorough cross-review and opened as a draft PR for the security team |
| Weekly dependency upgrades that pass CI | Every Monday the agents upgrade what they can, fix what breaks, and open one PR that already builds |
| Remove feature flags that finished rolling out | A LaunchDarkly flag that has served one variation for 30 days gets a PR deleting it and the dead path |
| Customer bug report to fix, with approval | A Zendesk ticket tagged `bug` is checked for repro steps, filed in Linear, approved by an engineer, fixed, and support gets an internal note with the PR |
| Fix it from Slack | React with :robot_face: to a bug report; it becomes a Linear ticket and the draft PR is posted back in the thread |

## Running a workflow for real

There are two ways, and they use the same engine.

**On your computer, from the studio.** With `relay connect` running in your
repository, *Run on your computer* sends the compiled workflow to the companion,
which runs the pipeline there with your own sign-ins and streams every phase
back to the canvas. The trigger and the guardrails in front of the pipeline
decide whether an *event* may start a run, so a person pressing the button
passes over them; the per-run cost cap still applies, and delivery stops at a
pull request. Reload the tab mid-run and the studio picks the run back up.

**Unattended, from your repository.** Export compiles the graph into files your
repository already knows how to run — installed straight into it through
`relay connect`, or downloaded as a `.zip`:

| File | What it is |
|---|---|
| `.relay/config.json` | The engine's configuration: which agent plays which role, review depth, round limits, guardrails, how far delivery may go |
| `.github/workflows/<name>.yml` | A GitHub Actions workflow that runs the engine on your own runner minutes |
| `SETUP.md` | The secrets to add, and where each one comes from |
| `<name>-workflow.json` | The graph itself, to import back into the studio |

The exported Action works on one GitHub issue per run. A GitHub issue trigger
(a label added, an issue opened or assigned, a comment) becomes an Actions
event, and the run still requires the trigger label and a labeller on the
allowlist. Any other trigger exports as a workflow you start yourself with an
issue number (`workflow_dispatch`), or from anything that can send an HTTP
request (`repository_dispatch`), and the export says so. Slack, Discord and
HTTP actions are wired straight into the YAML; any other app is posted as JSON
to a bridge URL you choose, such as an n8n or Zapier webhook or your own server.

Whatever the canvas cannot express in those files is listed as a warning in the
export and in `SETUP.md`. A workflow with errors, placeholder names on its
allowlist or no repository does not export. Secrets you typed into a node are
never written to the files; they become named repository secrets. A paused
workflow exports with its trigger switched off.

## Bring your own subscription

There are no API keys to paste. Claude Code signs in with your Claude plan and
Codex with your ChatGPT plan: through `relay connect`, the studio starts each
CLI's own login on your computer and then asks that CLI whether it worked. The
sign-in stays in that CLI's own files; Relay does not read or store it.

Codex has a second way in: **Continue with ChatGPT**. OpenAI's Sign in with
ChatGPT lets you authorize Relay itself to use your ChatGPT plan, so Codex needs
no login of its own, and what Relay may spend is a limit you set for it under
[Usage in ChatGPT's settings](https://chatgpt.com/settings/usage). Start it from
the studio's Agent accounts card or with `relay chatgpt login`. This is the one
credential Relay holds: an OAuth token in an owner-only file under `~/.relay`
on your machine, handed to the Codex process that spends it and to nothing else.
It never reaches the studio or `.relay/`. It is for Relay on your own computer;
Relay Cloud machines keep using Codex's own sign-in.

In GitHub Actions the export uses each vendor's supported way of carrying a
personal plan into CI — `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and
`CODEX_AUTH_JSON` holding `~/.codex/auth.json` — or API keys, if you prefer them.
Those are secrets of your repository, passed to each vendor's own process.

Relay Cloud, the hosted runner, is an invite-only beta. Each person gets a
cloud machine of their own and signs Claude Code, Codex and GitHub in there
through the vendors' own pages. Those sign-ins, and the checkout, are on that
machine's disk, which Relay operates; they are not copied anywhere else, and
they go when you remove the machine.
[The design](docs/design/relay-cloud-runners.md) covers how that machine is
run, reached, kept cheap and kept working.

What Relay itself holds: the notification connections you add in the studio (a
Slack or Discord webhook, which can post to one channel and nothing else),
encrypted with a key only the server has. The one credential the CLI reads is
a Linear API key, from `LINEAR_API_KEY`, when an issue lives in Linear.

## Why a run nobody watched is worth reading

Running agents is the easy part. These are the rules that make the result
trustworthy. The engine enforces them on every run, and the studio checks the
ones a graph can break before it lets you test-run or export:

- **Nothing grades its own homework.** By default the model that reviews a plan
  or a diff is the other CLI, not the one that wrote it, and the studio warns if
  you give both roles to one. Reviewers run read-only, and an agent with no
  read-only mode cannot be made a reviewer at all.
- **Every claim is checked against git.** Relay computes the diff itself, judges
  tests by exit code and takes cost from what the CLIs report. An agent saying
  "done" proves nothing.
- **Unattended runs never merge.** A ticket assignment, a label, a schedule or a
  webhook is an unattended start; those runs stop at a draft pull request, and
  the studio refuses to export anything else.
- **Guardrails refuse by default.** An empty allowlist means nobody may start a
  run, and an unattended workflow will not start without a per-run and a daily
  budget. On GitHub Actions every job starts on a clean machine, so there is no
  record of the day's spend to add to: the per-run cap is what holds there, and
  the daily budget and the audit trail work where `relay serve` keeps its state.
- **Nothing leaves unscanned.** Delivery runs a secret scan between commit and
  push, and a hit stops the change at a local branch.
- **Your checkout is only read.** Agents work in a separate git worktree.

What these rules do not do is contain the agents. Nobody is at the terminal to
answer a prompt, so Relay starts Claude Code with `--permission-mode
bypassPermissions` and Codex with `approval_policy="never"`. Codex runs in its
own sandbox in every role. Claude Code's read-only turns (planning, reviewing)
are wrapped in an OS sandbox on macOS, and on Linux when bubblewrap is
installed; a Claude Code implementer is not sandboxed anywhere, and can do what
your account can do. Publishing commands are denied to every agent by name.
Seat Codex as the implementer if that is more than you want to hand over.

The full list, how each rule is enforced, and which role is confined by what
on which operating system, is under [Safety](docs/cli.md#safety) in the engine
reference.

## Status

Relay is in beta at <https://relay-olive-omega.vercel.app>, and free while it
is. The hosted studio needs a free account, which keeps your workflows, runs
and settings in any browser, up to 300 workflows; a development copy without
accounts keeps them in your browser's storage. Everything that needs your
computer — agent sign-in, real runs, installing an export — goes through
`relay connect`, which pairs with the hosted studio as readily as with a local
one. Relay Cloud, a cloud machine per person signed in with that person's own
plans ([how it works](docs/design/relay-cloud-runners.md)), is an invite-only
beta: write to support@nullstack.one to ask for access.

| Works today | Simulated in the studio | Not built yet |
|---|---|---|
| Accounts (Clerk: email, Google, GitHub), onboarding, cloud sync, share links and remixes, version history | | |
| The builder, describe-to-workflow, validation, the plain-English description, the spend forecast and the export | Test runs: phases, costs, refusals and PR numbers are played back, deterministically | |
| Through `relay connect`: signing in to Claude Code and Codex, running a workflow on your computer, installing an export | Every trigger except a label on a GitHub issue and a manual start | Triggers from Linear, Jira, Sentry, CI and the other apps |
| Connecting Slack and Discord: the webhook is checked with the app, kept encrypted, and rechecked from the dashboard | Other apps' connections: "Mark ready" records a label and signs in to nothing | Sign-in for every connector |
| Relay Cloud (invite-only beta): a machine of your own on Azure, woken for a run and put to sleep when idle | Logic nodes and most app actions, which are marked "test runs only" | |
| Exported workflows running on GitHub Actions, started by a label on a GitHub issue | Approvals: decided by the simulator; a real run does not wait for one | Approvals from Slack and email |
| The engine, from a terminal or from CI, with GitHub and Linear issues | | Org-wide guardrails, an audit log, and a self-hosted runner in your VPC |

The engine reads issues from GitHub and Linear today. The studio lets you design
against every app in the catalog, each template says how it runs today, and the
export says which parts need the bridge and which it left out.

## The CLI: the studio's companion, and the engine

The `relay` CLI in `src/` is the studio's side of your computer.

`relay connect` is how the two meet: a small server on 127.0.0.1 that only a
paired studio can use — loopback only, the studio's origin only, a token made
for that start of `relay connect` which travels once, in the fragment of the
link it opens, and a question in the terminal before the first run or install. Through it the
studio starts the vendor CLIs' own sign-ins, runs a workflow's pipeline in your
repository and streams it back, and installs an export. A run started this way
takes the pipeline's shape from the workflow and everything else from the
repository's own config, and stops at a pull request.

Behind the Agent pipeline node is the engine — the same CLI. It is what a run
from the studio performs on your computer, what the exported GitHub Action
runs, and it works on its own from a terminal:

```bash
relay connect                                 # pair with the studio
relay start                                   # dependencies, sign-in, config, and a first run
relay run 142                                 # a GitHub issue, a Linear ID, or a spec file
relay run --prompt "Fix the flaky timeout in the retry test"
```

A run looks like this, and every step leaves a real artifact on disk rather than
a chat transcript:

```
issue
  → plan                    (planner reads the codebase, writes plan.md)
  → plan review             (a different model attacks the plan against the real code)
  → revised plan            (planner answers ACCEPT / REJECT / NEEDS_CLARIFICATION to every finding)
  → implementation diff     (implementer works in an isolated worktree)
  → code review findings    (reviewer reads the diff Relay computed from git)
  → revised implementation  (only BLOCKING findings are routed back)
  → test evidence           (the project's own test command, judged by exit code)
  → delivery                (commit → push → pull request → merge, as far as the policy allows)
```

**[The CLI reference](docs/cli.md)** covers the rest: the companion and its
security, the design, the safety rules, every command, review depth, cost and
budgets, delivery, unattended runs and the GitHub Action, configuration, exit
codes, and Windows.

## Measuring the claim

Relay rests on one claim: that agents reviewing each other's work produce
better changes than one agent working alone. That claim has not been measured
yet. `relay eval` is the harness for measuring it: it runs a fixed set of tasks
through real pipeline runs under different configurations and reports solve
rate, regression rate, cost and review yield, with confidence intervals. No
session has been recorded, so
[`eval/results/RESULTS.md`](eval/results/RESULTS.md) holds no numbers; see
[`eval/README.md`](eval/README.md) for how to produce them. If the numbers do
not support the design, the defaults change.

## Repository layout

| Path | What |
|---|---|
| [`web/`](web/README.md) | The workflow studio: a Next.js app with the builder, templates, runs, integrations and the export |
| `src/` | The `relay` CLI (TypeScript, Node ≥ 22.6): the studio companion in `src/studio/`, the Relay Cloud hub and runner in `src/cloud/`, and the engine |
| `action.yml` | The GitHub Action that exported workflows run |
| [`docs/cli.md`](docs/cli.md) | The CLI reference: the companion and the engine |
| [`docs/design/`](docs/design/relay-cloud-runners.md) | Relay Cloud runners: how they work, and what is next. [How workflows run for real](docs/design/workflow-execution.md), locally and in the cloud |
| [`eval/`](eval/README.md) | The eval harness and its fixtures |
| `test/`, `scripts/`, `bin/` | The engine's tests, CI fixtures and entry point |
| `scripts/azure/` | Deploys the Relay Cloud hub on Azure, and creates a development runner VM |

## Development

```bash
# the studio: embedded Postgres, and accounts once `npx clerk env pull` has written the keys
cd web
npm install
npm run dev            # http://localhost:3000
npm run lint && npm run typecheck && npm test && npm run build

# the engine, from the repository root
npm install
npm run typecheck
npm test               # no network, no real agents
```

CI runs the engine's suite on macOS, Linux and Windows, runs the Action against
a fixture repository, and lints, typechecks, tests and builds the studio.
[CONTRIBUTING.md](CONTRIBUTING.md) says what a change needs.

### Deploying the studio

On Vercel, import the repository with `web` as the root directory, then:

1. **Storage → Create → Neon** (free tier). It sets `DATABASE_URL`; tables are
   created on the first request.
2. Add the Clerk keys, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and
   `CLERK_SECRET_KEY` (for launch, a production instance: `npx clerk deploy`).
   Sign-in methods — email, Google, GitHub — are switched on in the Clerk
   dashboard; Clerk sends the verification and password-reset emails.
3. Add `RELAY_CREDENTIALS_KEY` (`openssl rand -base64 32`), which encrypts
   the Slack and Discord webhooks people connect.
4. Add a Clerk webhook for `user.deleted` pointing at `/api/webhooks/clerk`,
   with its signing secret in `CLERK_WEBHOOK_SIGNING_SECRET`, so an account
   deleted in Clerk takes its studio data with it.

Every variable is described in [`web/.env.example`](web/.env.example). Without
a database or the Clerk keys the deployment keeps the site up, but the studio
stays closed and `/sign-in` says sign-in is not available. `GET /api/health`
answers 503 and names what is missing until all four are set, so use it as the
deployment's health check.

### Relay Cloud on Azure

`scripts/azure/deploy-hub.sh` deploys the hub and everything the runner
machines need: a resource group, one network per runner region, the hub as a
system service with a managed identity scoped to that resource group, and a
public HTTPS address (a static IP with Caddy, or Tailscale Funnel for trying it
out). It is safe to run again and keeps every setting it was not given;
`--upgrade` ships new code and `--rotate-secret` replaces the secret runner
tokens are signed with.

```bash
az login
scripts/azure/deploy-hub.sh --expose public-ip \
  --clerk-publishable-key pk_live_… --allow user_2abc…   # a new hub VM with its own address
scripts/azure/deploy-hub.sh --upgrade
```

Then set `RELAY_CLOUD_HUB_URL` to the address it prints on the studio's
deployment. Who may have a machine is `--allow` (Clerk user ids, or `'*'`);
nobody may until you say, and `--allow none` empties the list again.

The hub's VM must be the hub's alone. Its identity has Contributor on the
runners' resource group, which includes running commands as root on every
runner, and its disk holds the secret runner tokens are signed with. The
script refuses a VM that has the coding CLIs installed. Pin what runners
install with `--claude-code-version` and `--codex-version`. The
[design](docs/design/relay-cloud-runners.md#hosting-on-azure) lists what it
costs and what the hub cannot do for you: network isolation between runners,
capacity, and stopping machines while the hub itself is down.

### A development runner VM on Azure

`scripts/azure/create-runner.sh` builds a VM for working on Relay: Ubuntu 24.04
on `Standard_B2ats_v2` with Claude Code, Codex, gh, bubblewrap and Relay
installed. It has no public IP; you reach it over Tailscale. Agents on it run
as a user who can sudo, so it is not a Relay Cloud machine and never a place
for the hub.

```bash
az login
scripts/azure/create-runner.sh --group <group> --name <vm>                             # lists the regions you may deploy to
scripts/azure/create-runner.sh --group <group> --name <vm> --location northcentralus   # prints a Tailscale link to approve the VM
```

It uses `~/.ssh/id_ed25519.pub` unless `--ssh-key` names another. With
Tailscale on, connect with `ssh relay@<the VM's Tailscale name>`. On the VM,
sign in to `gh`, then run `relay connect --no-open --port 4478` in a clone. A
tunnel (`ssh -N -L 4478:127.0.0.1:4478 …`) lets a studio in your browser pair
with the VM as if `relay connect` were running on your own computer.

To stop paying for compute, run `az vm deallocate -g <group> -n <vm>`. To
remove everything, run `az group delete -n <group>`.

## License and security

Relay is open source under the [MIT License](LICENSE), copyright NullStack.one.
Report a vulnerability to support@nullstack.one as described in
[SECURITY.md](SECURITY.md); changes are listed in [CHANGELOG.md](CHANGELOG.md).
