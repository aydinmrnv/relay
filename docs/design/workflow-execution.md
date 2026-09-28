# Running workflows for real: local, cloud, and the part in between

**Status: design, not built.** This covers how a workflow drawn on the canvas
runs for real, whether it runs on the user's own computer or in Relay Cloud,
and the order to build it in. It builds on
[Relay Cloud runners](relay-cloud-runners.md), which covers the machines. This
document covers what runs on them, and what runs somewhere else.

## Where things stand

A workflow is a graph: a trigger, guardrails, the Agent pipeline, delivery,
and actions after it. Today there are four ways to "run" one, and each treats
the graph differently:

| Way | What runs | Where the graph is interpreted |
|---|---|---|
| Test run | Every node, with made-up effects | `web/src/lib/workflow/simulate.ts`, in the tab |
| Run on this machine | The pipeline and delivery only. The trigger is the person who pressed the button, the guardrails are skipped, and the actions after delivery are skipped | `web/src/lib/companion/machine-run.ts`, in the tab, which also follows the stream and writes the run record |
| Run in Relay Cloud | The same as above, on the person's VM, through the hub | The same |
| Export to GitHub Actions | Only what fits into `.relay/config.json` and a YAML file. GitHub events and schedules are real triggers; Slack, Discord and HTTP become `curl` steps; any other app goes to a "bridge URL"; everything else becomes a warning | `web/src/lib/workflow/compile.ts`, once, at export |

That leads to four problems:

1. **Nothing runs a workflow as drawn.** Only the pipeline node does real work
   in the studio. A Linear trigger, an approval, a Slack message or an AI step
   is only ever simulated, unless the export can turn it into YAML.
2. **Unattended runs exist only through the export**, and only for GitHub
   triggers. A Relay Cloud machine can't be started by an event. That is item 1
   under Next in the runners design.
3. **The browser tab does the orchestrating.** It starts the run, follows the
   stream, builds the record and syncs it to the database. If the tab closes,
   the run keeps going on the runner, but its record doesn't update and nothing
   after delivery happens.
4. **Two settings answer the same question.** Settings has a "Where runs
   execute" picker (`executionTier`: Actions, "Hosted microVMs" (disabled),
   "Self-hosted" (disabled)) and a separate "Where agents run" picker
   (`machine` or `cloud`). The two disabled options describe things the
   second picker now offers.

## Two questions, not one

"Local or cloud" mixes up two separate choices:

1. **Who starts the run:** a person pressing a button (attended), or an event
   such as a label, a new Sentry error or a schedule (unattended).
2. **Where the agents run:** the **runner**. That can be this machine, Relay
   Cloud, a machine of the user's own, or GitHub Actions.

| | Attended | Unattended |
|---|---|---|
| This machine | works today (pipeline only) | not possible: nothing can reach a laptop |
| Relay Cloud | works today (pipeline only) | not possible: nothing wakes the VM |
| A machine of the user's own | by hand, through `relay hub token` | not possible |
| GitHub Actions | `workflow_dispatch` | works today, with a reduced graph |

The goal is every cell working, with the whole graph, and one setting that
means one thing: **which runner this workflow uses.**

## What each node needs

The main decision comes from asking what each node needs in order to run:

| Node | Needs | Runs on |
|---|---|---|
| Triggers | A public address that is always on | **Control plane** |
| Kill switch, allowlist, concurrency limit, budget gate | Lasting state (spend today, runs in flight). The decision has to come *before* anything wakes up or spends money | **Control plane** |
| Human approval, Wait, Wait for business hours | Timers that last hours or days. A VM must not stay awake and billed while it waits | **Control plane** |
| Condition, Filter, Merge paths, Note | Nothing: they are pure functions | **Control plane** |
| Agent pipeline, Fast run, Estimate cost, Deliver, Comment the summary | The repository and the signed-in coding CLIs | **Runner**, as one job: `relay run --json` |
| AI step | A model. Relay never calls a model API | **Runner**, as one structured turn of the user's own CLI |
| Transform (user JavaScript) | A sandbox | Not in the first version; test runs only |
| Slack, Discord, Linear, HTTP and other actions | The app's credentials and the run's outputs | **Control plane** |

So every workflow has the same shape: **a control-plane prefix, one or more
runner jobs, then a control-plane suffix.** The runner only does the work that
needs the repository and the user's sign-ins. Everything that has to be always
on, keep state or hold an app credential happens somewhere that is always on.

This is the split GitHub Actions and Buildkite use: a hosted orchestrator,
with runners that can live anywhere.

## Architecture

```
  app events ──▶ studio (Vercel + Postgres) ◀──── hub (Azure, always on) ◀── runners (all dial out)
                 · webhook intake              · wakes VMs                  · Relay Cloud VM
                 · the graph executor          · claims jobs, forwards them · a machine of your own
                 · guardrails, spend ledger    · ticks the studio           · this laptop, when linked
                 · connections, notifications
                          ▲                                                        │
                          └──────── run records, posted by the runner itself ──────┘
```

**The studio is the control plane.** It already has the database, Clerk, the
workflows, version history, the connector catalog, the compiler, the
validator and the simulator. All of them are isomorphic TypeScript under
`web/src/lib`. The executor goes there too, so a Next.js route can import it.

**The hub stays a gateway to runners.** It keeps its current rule of no
database, and gains two jobs:

1. It claims queued runner jobs from the studio, wakes the right machine and
   forwards each job down that machine's socket as `POST /v1/runs`, the same
   way it forwards a browser's request today.
2. It is the clock. A Vercel function can't sleep for three hours, so the hub
   tells the studio when a timer is due.

**A runner reports home itself.** Each job carries a callback URL and a
capability token that only covers that run. The runner posts `relay run
--json` records to the studio in batches, numbered so that a repeated batch is
ignored. This works the same on a VM, a laptop or a self-hosted box, and later
from inside a GitHub Action. The hub doesn't need to remember which runs to
forward, so it stays stateless. The studio folds the records into the run with
`MachineRunFold`, which is the code the tab uses today, now running on the
server.

**Why the hub pulls instead of the studio pushing.** Serverless functions
can't hold a connection. If the hub restarts, it loses nothing, because jobs
are rows in the database. The studio never needs to reach the hub on a
predictable schedule. To stop the pull from keeping Neon awake around the
clock, the hub doesn't poll on a short fixed interval:

- The studio *nudges* the hub when it queues a job, and tells it when the next
  timer is due.
- A slow safety poll, every 15 minutes, catches a nudge that got lost.

If nothing is happening, nothing runs.

## A run, end to end

Example: an unattended run, triggered from Linear, on Relay Cloud.

1. **The event arrives.** Linear posts to `/api/hooks/<hook id>`. The studio
   checks the signature, finds the workflow's **live version**, and inserts
   the event under a unique dedupe key, so a redelivery is ignored. It then
   answers within a second.
2. **The prefix runs.** The executor starts at the trigger and checks the
   filter and conditions, the kill switch, the allowlist (the person comes
   from the payload), the concurrency limit (runs of this workflow in flight)
   and the budget (spend today, plus the full per-run cap *reserved* for every
   run in flight: the same rule `relay serve` uses). A refusal is recorded as
   a `refused` run that gives the reason, and nothing is woken.
3. **A job is queued.** The pipeline node becomes a `job` row holding
   everything the runner needs: the workflow, the compiled config with the
   unattended ceiling applied, the task and `owner/repo`. The node shows
   *waiting for Relay Cloud*.
4. **The hub claims it.** It wakes the VM (the canvas shows the place in the
   queue) and forwards the job with its callback.
5. **The runner runs it.** It runs `relay run --json` in a worktree and posts
   records to the studio. Anyone who has the run open watches the canvas light
   up.
6. **The suffix runs.** The exit record carries the PR URL, cost, branch and
   summary. The executor puts them in the template context and runs the
   Slack, Linear and HTTP nodes with the user's connections. The run finishes
   and its cost goes into the ledger.
7. **The machine goes back to sleep** after ten idle minutes, as it does
   today.

**An attended run takes the same path.** It starts with a manual-start
record instead of an event, and the event guardrails pass it through (as they
do today). The per-run cap still applies and delivery still stops at a pull
request. What changes is that the browser only watches: the tab can close, and
the Slack message still gets sent.

**When things fail.** A claimed job holds a lease that incoming records keep
renewing.

- If the lease runs out **before** the engine sent anything (the hub died, or
  the VM never came up), the job goes back in the queue once.
- If it runs out **after** records arrived, the job is never run again. Money
  has been spent and a branch may have been pushed. The run is marked
  *runner lost*, and the person decides whether to retry.

Runners refuse a job id they already have, so a job delivered twice runs only
once.

## Which runner a workflow uses

Where a workflow runs becomes a **per-workflow** setting, and it is part of
what gets activated. Settings holds the list of runners and the default:

| Runner | When it can run | Good for |
|---|---|---|
| Relay Cloud | Always: the machine wakes when needed | The default for unattended work |
| A machine of your own (a laptop, a Mac mini, a server) | While it is connected. A job waits for it, up to a limit the workflow sets, then fails with *your machine was offline* | macOS and Xcode workflows, private networks, big repositories |
| GitHub Actions | Always, on the user's minutes | Teams who don't want Relay in the loop |

**There is never a silent fallback.** Moving a run from a laptop to Relay
Cloud would change where the code runs and which sign-ins it uses. The user
chooses what happens when a runner is offline (wait, or fail), and the run
says which one happened.

`executionTier` goes away. Its question is now answered per workflow, from
that list.

**Laptops join by linking, not by copying tokens.** When a signed-in user
turns on "Let triggered runs use this machine", the studio asks the hub for a
runner token for that user. It passes the token to the paired `relay connect`
over the loopback channel, which is already authenticated. The companion saves
it in `~/.relay` with mode 0600 and dials out to the hub, while still serving
the studio on loopback. Nothing to paste. The hub currently keeps one link per
user (`links` in `src/cloud/hub/server.ts` is keyed by user id), so it needs to
key them by user and runner.

**GitHub Actions stays an export.** The whole compiled graph is committed to
the repository, and nothing depends on Relay. There is one change: the export's
"bridge URL" becomes the studio's own hook and callback, so an exported
workflow can hand its Slack, Linear and other actions to the control plane.
Later, Actions can also be a runner the studio dispatches to with
`workflow_dispatch`, and the Action posts records to the callback like any
other runner.

**Direct runs stay.** The current "Run on this machine" goes browser →
loopback, with no Relay server in the path. It is how a guest with no account
tries a real run, and it stays that way: pipeline only, as today. A signed-in
user gets the whole graph by running through the control plane.

## Who holds which credential

| Credential | Held by | Change |
|---|---|---|
| Claude Code and Codex sign-ins | The runner, in the CLIs' own files | None. Relay never holds a model credential |
| GitHub, for code | The runner's `gh` today. Later, per-job GitHub App installation tokens minted by the studio, limited to one repository for about an hour, and used only by Relay's own `git` and `gh` | Hardening, as already planned |
| App connections (Slack, Discord, Linear, HTTP secrets) | **The studio, encrypted at rest** | **New.** Relay already says it never holds a model or code credential. Holding notification credentials is what any automation product does. The first version accepts only webhook URLs (Slack incoming webhooks, Discord webhooks), which can do nothing but post |
| Runner tokens | HMAC-signed by the hub | None |
| Job callback tokens | HMAC-signed by the studio, per run, with an expiry | New |
| Studio ↔ hub | One service secret, used in both directions | **New.** The runners design counts "no secret shared with the studio's server" as a feature. Starting a run with nobody signed in needs one. It is limited to claiming jobs, minting runner tokens and nudging |

The README should say this precisely before app connections ship: *Relay
never holds a model credential or a code credential. It holds the
notification connections you add, encrypted.*

## What the studio stores

| Table or column | Holds |
|---|---|
| `workflow.live_version_id`, `workflow.runner` | What triggers run against, and where. **Activate** pins the current version, so editing a workflow never changes one that is live |
| `hook` | A random id that goes in the URL, and the owner, workflow, trigger node and signing secret |
| `trigger_event` | `(workflow_id, dedupe_key)`, unique |
| `run`, new columns | `origin` (`browser` or `server`), the executor's state as JSON, `reserved_usd`, `wake_at` |
| `job` | The run, node, kind (`pipeline` or `ai-step`), runner, request, status, lease, attempts |
| `connection` | The user, connector, account label and encrypted secret |
| `approval` | The run, node, token and expiry. Decided through a signed link in Slack or email |

A run the server owns is never written by the browser. `web/src/lib/cloud/sync.ts`
has to skip `origin: 'server'` runs, or an old copy in a tab would overwrite
the server's.

## One executor, not four

Today the graph's meaning is written three times: in the simulator, in the
machine-run fold and in the compiler. A real executor would make four. So the
first step is to turn the simulator into **the** executor, with the effects
supplied from outside:

```ts
type Placement = 'control' | 'runner';

interface ExecutionState {
  nodeStatus: Record<string, NodeRunStatus>;
  queue: string[];
  joins: Record<string, number>;
  context: Record<string, unknown>;   // issue, trigger, run.*, workflow.*
  waiting: { nodeId: string; on: 'job' | 'timer' | 'approval'; until?: string } | null;
}

/** Runs control-plane nodes until the run finishes or has to wait for something outside. */
function advance(workflow: Workflow, state: ExecutionState, resume?: Resume): {
  state: ExecutionState;
  events: RunEvent[];
  request?: RunnerJob | Timer | ApprovalRequest;
};
```

- **A test run** loops over `advance` and answers each request immediately
  with the simulated result the simulator produces now.
- **A real run** saves the state, waits for the job, timer or approval, and
  calls `advance` again when it arrives.

Queue order, joins, skipped branches, handles and templates are then written
once. A test run can't promise something a real run won't do. The inspector
can also say for each node where it will run, and whether that node can run
for real yet.

## Build order

Each phase ships on its own and can be demoed.

**Phase 0: one executor. No new infrastructure.**
- Split `simulate.ts` into a resumable `advance()`, per-node handlers that each
  declare a `placement`, and simulated effects.
- Proof: every template's seeded test run produces the same events before and
  after.
- Add `realRunIssues(workflow)` to the validator: the nodes that can't run for
  real yet, with the reason.

**Phase 1: attended runs through the control plane, on Relay Cloud.**
- Add the `job` table and server-owned runs.
- `POST /api/workflows/:id/runs` runs the prefix and queues a job.
- The hub gets the service secret, the nudge, the claim and the forward.
- `StudioRuns` gets a `report` option that posts records to the job's
  callback.
- The studio folds records with `MachineRunFold`. The browser polls the run.
- The suffix runs with webhook-URL connections (Slack, Discord, HTTP).
- Result: press Run, close the tab, and a Slack message arrives with the PR.

**Phase 2: triggers.**
- **Activate** and live versions.
- The Incoming webhook trigger: Sentry, Linear and Zapier can all post to it.
- The Schedule trigger, driven by the hub's clock.
- Real guardrails, with the spend ledger read from `run`. Deduping, and
  refusals recorded as runs.
- Then a **GitHub App**. It delivers `issues.labeled` and `issues.assigned`
  webhooks for every repository it is installed on, and it is also where
  per-job tokens come from. That makes the "Label-triggered GitHub run" and
  "Sentry error to fix" templates real on Relay Cloud.

**Phase 3: the user's own machines as runners.**
- Link a laptop from the studio.
- The hub keeps several links per user.
- A runner choice per workflow, with an offline policy.
- Result: "Xcode nightly build" becomes real on a Mac that is switched on.

**Phase 4: the rest of the graph.**
- The AI step as one structured turn on the runner. The model list becomes the
  agents signed in there.
- Approvals through signed links in Slack and email.
- Wait and Wait for business hours, driven by the hub's clock.
- GitHub Actions as a runner that can be dispatched.

## Decisions to make before Phase 1

1. **The control plane is the studio, not the hub.** The studio already has
   the data, the auth and every piece of graph code; the hub keeps its "no
   database" rule. The cost is one service secret shared between the two.
2. **The studio holds app connections, encrypted,** starting with webhook
   URLs only.
3. **A GitHub App in Phase 2.** It is the only way to receive GitHub events
   for every user without asking each of them to add a webhook to each
   repository.
4. **A laptop becomes an unattended runner only if its owner opts in.** A
   paired laptop is used for attended work only, until its owner links it.
5. **No automatic fallback between runners.**
6. **The hub pulls jobs, prompted by nudges.** The studio never depends on
   reaching the hub.

## What does not change

- Relay never calls a model API and never holds a model credential.
- An unattended run never merges. Guardrails refuse by default, and an empty
  allowlist is a refusal.
- Delivery scans for secrets, and agents work in a separate worktree.
- Test runs are free, and now follow the same code as real runs.
