# Relay

**Tickets in. Reviewed pull requests out.**

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

```bash
git clone https://github.com/aydinmrnv/relay
cd relay/web
npm install
npm run dev            # http://localhost:3000
```

1. **Open the studio** and start from a template, or from a blank canvas.
2. **Test-run it** with a sample ticket or your own JSON payload. Nodes and edges
   light up as the run travels, with the same phases, review rounds, budgets and
   refusals as a real run — and it costs nothing, because it is simulated.
3. **Export it.** You get one `.zip` that unzips into your repository: the
   engine's config, a GitHub Actions workflow, and a `SETUP.md` listing each
   secret to add and where it comes from. Commit it, and the workflow runs for
   real on your own Actions minutes.

The **Guide** (`/guide`) walks through the same path and explains every concept
the studio uses.

## How a workflow is built

A workflow is a graph of nodes. Every node's ports are typed — an issue, a run,
a change, a message, an event — so the canvas refuses a connection that makes no
sense, like wiring a ticket into something that expects a pull request.

| Building block | Nodes |
|---|---|
| **Triggers** | 740 triggers across 240 apps: an issue labelled on GitHub or assigned in Linear, a new Sentry error, a Zendesk ticket, a schedule, an incoming webhook, a manual start |
| **Guardrails** | Budget gate, author allowlist, human approval, concurrency limit, kill switch. Each refuses by default and says why |
| **Agent pipeline** | Run the pipeline (choose the planner, plan reviewer, implementer and code reviewer, the review depth and the round limits), a fast run with no reviews, or a cost estimate |
| **Delivery** | Deliver the change — commit, branch, draft pull request, or merge when a person started the run — and comment the summary on the issue |
| **Logic** | Condition, filter, transform, an AI step for triage or classification, merge paths, wait, wait for business hours, notes |
| **Actions** | 1,119 actions: message Slack, Discord or Teams, open a Linear ticket, call any HTTP endpoint, post the run as JSON |

Select a node and the side panel shows its settings, what it will do with them,
and what it did in the last test run. Select nothing and the panel reads the
whole workflow back in plain English, with the apps and sign-ins it needs and
every check it has not passed.

### Templates

| Template | What it does |
|---|---|
| Ticket to pull request | A Linear issue assigned to the bot is planned, reviewed, implemented, reviewed again and tested, and opens a draft PR. Slack hears about it |
| Label-triggered GitHub run | A label on a GitHub issue starts an unattended run behind an allowlist and a budget; the summary lands back on the issue |
| Sentry error to fix | A model triages each new Sentry issue. Regressions get a fast fix and a draft PR; the rest become a Linear ticket |
| Xcode nightly build | Every weeknight, build and test the iOS app. A failing build becomes a ticket, the pipeline fixes it, and the team wakes up to a PR |
| YouTube comment to issue | Comments on your videos are classified by a model; bug reports become GitHub issues and a Discord ping |
| Support ticket to fix, with approval | A Zendesk ticket tagged `bug` waits for a person to approve, then runs the pipeline and replies to the customer with the PR |

## Running a workflow for real

Export compiles the graph into files your repository already knows how to run:

| File | What it is |
|---|---|
| `.relay/config.json` | The engine's configuration: which agent plays which role, review depth, round limits, guardrails, how far delivery may go |
| `.github/workflows/<name>.yml` | A GitHub Actions workflow that runs the engine on your own runner minutes |
| `SETUP.md` | The secrets to add, and where each one comes from |
| `<name>-workflow.json` | The graph itself, to import back into the studio |

GitHub issue triggers and schedules become Actions events directly. Every
exported workflow can also be started by hand with an issue number
(`workflow_dispatch`) or by anything that can send an HTTP request
(`repository_dispatch`). Slack, Discord and HTTP actions are wired straight into
the YAML; any other app is posted as JSON to a bridge URL you choose — an n8n or
Zapier webhook, or your own server — which is the job the hosted product will
take over.

Whatever the canvas cannot express in those files is listed as a warning in the
export and in `SETUP.md`, never silently dropped. A paused workflow exports with
its trigger switched off.

## Bring your own subscription

There are no API keys to paste. Claude Code signs in with your Claude plan and
Codex with your ChatGPT plan: the studio starts each CLI's own login and then
asks that CLI whether it worked. Relay never sees a token.

In GitHub Actions the export uses each vendor's supported way of carrying a
personal plan into CI — `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and
`CODEX_AUTH_JSON` holding `~/.codex/auth.json` — or API keys, if you prefer them.

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
  budget.
- **Nothing leaves unscanned.** Delivery runs a secret scan between commit and
  push, and a hit stops the change at a local branch.
- **Your checkout is only read.** Agents work in a separate git worktree.

The full list, and how each rule is enforced, is under
[Safety](docs/cli.md#safety) in the engine reference.

## Status

Relay is being built as an online product. Today the studio is a web app you run
yourself: nothing is hosted, nothing is billed, and your workflows stay in your
browser's storage. The hosted version is the next step.

| Works today | Simulated in the studio | Planned for the hosted product |
|---|---|---|
| The builder, validation, the plain-English description and the export | Test runs: phases, costs, refusals and PR numbers are played back, deterministically | A fresh runner per run |
| Signing in to Claude Code and Codex, and reading their status | App connections: "Connect" stores a local flag | Real webhooks for every connector |
| Exported workflows running on GitHub Actions, through the engine | Approvals: auto-approved after a delay | Approvals from Slack and email |
| The engine, from a terminal or from CI, with GitHub and Linear issues | | Org-wide guardrails, an audit log, and a self-hosted runner in your VPC |

The engine reads issues from GitHub and Linear today. The studio lets you design
against all 240 apps, and the export says which parts need the bridge.

## The engine

Behind the Agent pipeline node is the `relay` CLI in `src/`. It is what the
exported GitHub Action runs, and it works on its own from a terminal:

```bash
npm install -g github:aydinmrnv/relay
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

**[The engine and CLI reference](docs/cli.md)** covers the rest: the design, the
safety rules, every command, review depth, cost and budgets, delivery,
unattended runs and the GitHub Action, configuration, exit codes, and Windows.

## Measuring the claim

Relay rests on one empirical claim: that agents reviewing each other's work
produce better changes than one agent working alone. `relay eval` runs a fixed
set of tasks through real pipeline runs under different configurations and
reports solve rate, regression rate, cost and review yield, with confidence
intervals. See [`eval/README.md`](eval/README.md); published numbers go in
[`eval/results/RESULTS.md`](eval/results/RESULTS.md). If the numbers do not
support the design, the defaults change.

## Repository layout

| Path | What |
|---|---|
| [`web/`](web/README.md) | The workflow studio: a Next.js app with the builder, templates, runs, integrations and the export |
| `src/` | The engine and the `relay` CLI (TypeScript, Node ≥ 22.6) |
| `action.yml` | The GitHub Action that exported workflows run |
| [`docs/cli.md`](docs/cli.md) | The engine and CLI reference |
| [`eval/`](eval/README.md) | The eval harness and its fixtures |
| `test/`, `scripts/`, `bin/` | The engine's tests, CI fixtures and entry point |

## Development

```bash
# the studio
cd web
npm install
npm run dev
npm run lint && npm run typecheck && npm run build

# the engine, from the repository root
npm install
npm run typecheck
npm test               # no network, no real agents
```

CI runs the engine's suite on macOS, Linux and Windows, runs the Action against
a fixture repository, and lints, typechecks and builds the studio.

## The name is not decided

Nothing hard-codes "Relay". The studio reads its name from
`NEXT_PUBLIC_PRODUCT_NAME` at build time, and Settings can override it at
runtime; slugs, trigger labels, branch prefixes, exports and page titles all
follow.
