# Relay Cloud runners

**Status: design.** The runners, the hub and the cloud VMs described here are
not built yet. Studio accounts are: sign-in through Clerk, and Postgres through
Drizzle (`web/src/server/db/schema.ts`). The findings under
[Verified on a real VM](#verified-on-a-real-vm) come from a real Azure VM.

Relay runs a workflow's Agent pipeline with Claude Code and Codex, signed in
with the user's own Claude and ChatGPT plans, so a run costs nothing in API
fees. Today that only works on the user's own computer, through
[`relay connect`](../cli.md#the-studio-companion). Relay Cloud does the same
thing on a machine Relay runs for them. The user never sees that machine.

## What a user does

1. Signs in to their Relay account, and installs the Relay GitHub App on the
   repositories their workflows work on.
2. Opens **Settings → Agent accounts** and clicks **Sign in with Claude** and
   **Sign in with ChatGPT**. Each one runs the vendor's own sign-in: a Claude
   page that shows a code to paste back, and an OpenAI page that asks for a
   device code. The first time, the studio says *Starting your cloud machine*
   while one is made for them.
3. Presses **Run in the cloud** on a workflow, or lets a trigger start one.

That is all. There is no Azure account, SSH key, VPN or terminal on their side.
Everything the rest of this document describes is Relay's job.

## The idea: runners

The AI connector stops being a setting of the studio and becomes a property of
a **runner**. A runner is the place where a run executes and where the coding
CLIs are signed in. Every AI call is still the vendor's own CLI, unmodified,
signed in by the user. Relay never calls a model API and never holds a model
credential ([Design](../cli.md#design)).

| Runner | Where | Exists today |
|---|---|---|
| This machine | the user's computer, through `relay connect` | yes |
| GitHub Actions | an exported workflow, on the user's Actions minutes | yes |
| **Relay Cloud** | a machine Relay runs for that one user | this document |
| Self-hosted | the same program as Relay Cloud, on a box the user owns | later |

Agent accounts belong to a runner. The Agent accounts card shows one tab per
runner, and each tab has its own sign-ins. The Claude Code and Codex connectors
in the catalog show where they are signed in instead of offering a Connect
button.

## One machine per person

Every Relay Cloud user gets their own Linux VM, and nobody else's runs ever
touch it. That is the whole isolation story between users, and it is what the
vendors' rules need:

- **Claude Code** keeps its sign-in in `~/.claude` on that VM. The user signs in
  to the unmodified binary through Anthropic's own page, and Relay's code never
  reads the file.
- **Codex** keeps `~/.codex/auth.json` on that VM. OpenAI says one `auth.json`
  must live on one machine and never be shared across machines at once, because
  it rewrites itself when it refreshes. One VM per person gives exactly that.

Several runs of the same user share that VM, each in its own git worktree, as
they would on a laptop. A VM-wide limit (two at a time on the smallest size)
keeps them from starving each other.

The VM runs only while it is needed. Relay **deallocates** it after a few idle
minutes, and a deallocated Azure VM bills its disk and nothing else. The next
sign-in check, run or trigger starts it again, which takes 30–60 seconds.

## How the pieces talk

```
 browser (studio) ──HTTPS──▶ hub ◀──WebSocket (outbound)── runner VM (one per user)
        │                    │                              relay connect --hub
        └──HTTPS──▶ studio backend (Vercel): sign-in, database, hub tokens
```

**The runner dials out; nothing dials in.** A runner VM has no public IP
address and no open port. When it boots, a system service starts
`relay connect --hub <url>`, which opens a WebSocket *to* the hub and keeps it
open. The runner only needs outbound internet, which Azure's default outbound
access gives a VM without a public IP, for free.

**The hub** is one small, always-on service. It does three jobs:

1. **Proxy.** It accepts the studio's requests for a user and forwards them over
   that user's WebSocket. It speaks [companion protocol v1](../../src/studio/protocol.ts)
   on both sides, so the studio talks to `https://<hub>/u/<user>/v1/...`
   exactly as it talks to `http://127.0.0.1:4477/v1/...` today.
2. **Lifecycle.** When a request arrives for a runner that is not connected, the
   hub starts the VM (or creates it, the first time) and waits for it to dial
   in. After N idle minutes with no active runs, it asks the runner to drain
   (`POST /v1/shutdown`) and then deallocates it. It calls Azure through the hub
   VM's managed identity, so no Azure secret exists anywhere.
3. **GitHub.** It holds the GitHub App key, mints a token scoped to one
   repository for each run, and refreshes it before the hour runs out.

**The studio backend** (Next.js route handlers on Vercel) already has accounts
and Postgres. Relay Cloud adds runners and GitHub App installations to that
schema, plus a route that mints the short-lived token the browser uses to call
the hub. The browser talks to the hub directly, so long run streams don't hit
Vercel's function time limits, and sign-in codes never pass through Vercel.

**Why the runner dials out.** It needs no public IP (about $3.65 a month each on
Azure), no inbound firewall rule, no VPN and no pairing link. The hub knows
which WebSocket belongs to which user because each VM is created with its own
runner token.

## Sign-in on a VM

The studio's sign-in dialog already handles both flows a machine without a
browser needs. The runner offers only those:

| Agent | Offered on a cloud runner | Not offered, and why |
|---|---|---|
| Claude Code | Sign in with Claude (open a page, paste the code back); Anthropic Console API key | none |
| Codex | Device code | ChatGPT browser sign-in: it redirects to `localhost` on the VM, which the user's browser cannot reach |

A pasted code travels browser → hub → runner → the CLI's stdin. The hub never
logs or stores request bodies on the sign-in routes. The credential is written
by the CLI, on the user's VM, and Relay has no route that reads it.

## A run in the cloud

1. The studio asks the hub to start a run: the workflow's compiled config, the
   task, and `owner/repo`.
2. The hub checks that the user can reach that repository, mints a GitHub token
   scoped to it, and forwards the run with the token.
3. The runner fetches or clones the repository under `~/.relay/repos/`, then runs
   `relay run --json` there with the workflow's config layered over the
   repository's own. This is the same child process a studio run on a laptop
   uses today.
4. The engine's JSON lines stream back through the hub, and the canvas lights up
   as it does for a run on this machine.
5. Delivery pushes and opens the pull request with the scoped token. Agents
   never see the token: it reaches only Relay's own `git` and `gh` calls.

A trigger (a label, an assignment, a schedule) takes the same path from the
webhook. The hub wakes the owner's runner and starts
`relay serve --once --issue <n>`, which is what the GitHub Action runs today,
with the same allowlist, budgets and kill switches.

## Hosting on Azure

Relay Cloud starts on an Azure for Students subscription and can move to a
pay-as-you-go one by changing a single setting.

| Piece | Size | Cost on the student subscription |
|---|---|---|
| Hub | `Standard_B2pts_v2` (2 vCPU Arm, 1 GiB), always on | free: 750 h/month of this size for 12 months |
| Runners | `Standard_B2ats_v2` (2 vCPU AMD, 1 GiB, 4 GiB swap), one per user, deallocated when idle | free up to 750 h/month across all runners, then about $0.01/hour |
| Disks | a 64 GiB P6 for the hub and the first runner; a 32 GiB Standard HDD for each other runner | 2 × P6 free; about $1.50/month for each other disk |
| Public IPs | none: runners dial out; the hub is published through Tailscale Funnel while in development | $0 |
| Outbound traffic | default outbound access | free; the first 100 GB/month out is free |

**The limit that matters is quota, not money.** The subscription allows
6 vCPUs running at once in a region, and the hub uses 2, so **two runners can
run at the same time**. Deallocated VMs don't count toward the quota, so any
number of users can have a runner as long as no more than two are awake. Past
that, the hub queues a start until a slot frees.

**Keeping idle users cheap.** A user who has been idle for more than a week has
their disk turned into a snapshot (about $0.05 per GB-month of used space, so a
few cents) and then deleted. Their next run restores it, which takes a couple
of minutes longer than an ordinary start.

**The image.** New runners install everything through
[`scripts/azure/runner-cloud-init.yaml`](../../scripts/azure/runner-cloud-init.yaml),
which takes about five minutes, once per user. A captured image in an Azure
Compute Gallery would cut that to a normal boot, and can come later.

A $1 budget alert on the subscription emails the owner on any real charge.

## What changes in the code

**The CLI (`src/`)**

- `src/studio/server.ts`: move the router out of the HTTP handler, so the same
  routes can be driven by frames arriving over the hub's WebSocket. Loopback
  mode keeps its three locks; hub mode is authenticated by the runner token
  instead.
- A new `src/studio/dialout.ts`: `relay connect --hub <url>` connects out with
  Node's built-in `WebSocket`, reconnects with backoff, and multiplexes
  requests and run streams as `{id, …}` frames. It takes the token from the
  environment and deletes it immediately, the way `adoptConfigOverlay` does
  (`src/storage/config.ts:471`).
- `src/studio/runs.ts`: a repository per run instead of one fixed root, cloning
  or fetching before the child starts, and a run registry on disk so a restart
  doesn't lose runs.
- A new `src/github/credentials.ts`: the per-run token is read from a file by
  Relay's own `git` (`src/git/repository.ts:39`) and `gh` calls only.
- `src/studio/agents.ts`: the login modes above, advertised in `hello` so the
  studio draws the right buttons.
- `src/agents/sandbox.ts`: `--unshare-pid`, and masks that hide the CLIs'
  credential folders from test commands and from each other.

**The hub (new, `cloud/hub/`)**: a small Node service, containing the
WebSocket endpoint, the protocol proxy, Azure lifecycle through the managed
identity, the idle reaper, and GitHub App tokens.

**The studio (`web/`)**

- `web/src/lib/companion/client.ts`: the base URL and token become a
  **runner endpoint**: `127.0.0.1:<port>` plus the pairing token for this
  machine, or the hub URL plus a hub token for the cloud.
- `use-agent-accounts.ts` and `agent-accounts-card.tsx`: keyed by runner, with
  buttons from the runner's `hello`. Polling never wakes a stopped cloud runner.
- `run-launcher.ts` and the builder: **Run in the cloud** next to **Run on this
  machine**, with a repository field.
- `running-settings.tsx`: the runner picker. Relay Cloud replaces the greyed-out
  "Hosted microVMs" card.
- A `runners` table next to the account tables in
  `web/src/server/db/schema.ts`, and a route under `web/src/app/api/` that mints
  a hub token for the signed-in user.

## Security

- **Between users:** a separate VM each. A runner's token lets it reach only its
  own hub socket, and the hub routes a user's requests only to that user's
  runner.
- **From the internet:** runners have no public IP and no inbound rules. The hub
  is the only thing reachable, and every hub route needs a signed-in user.
- **Credentials:** model sign-ins live in the CLIs' own files on the user's VM.
  GitHub tokens are short-lived, scoped to one repository, and never enter the
  agents' environment.
- **Inside a VM:** test commands and agents run under bubblewrap with the
  credential folders masked. An agent can always read its own CLI's sign-in,
  and nothing can prevent that.
- **Exposure over time:** deallocating idle VMs, and snapshotting long-idle
  ones, keeps most users' machines switched off most of the time.

## Verified on a real VM

These come from a `Standard_B2ats_v2` running Ubuntu 24.04 in North Central US,
set up with [`scripts/azure/create-runner.sh`](../../scripts/azure/create-runner.sh).

- **bubblewrap needs an AppArmor profile.** Ubuntu 24.04 stops unprivileged
  programs from creating user namespaces, so `bwrap` failed with `setting up uid
  map: Permission denied`. A profile allowing `userns` for `/usr/bin/bwrap`
  alone fixes it, and cloud-init installs it.
- **Codex's own Linux sandbox works unchanged.** `/tmp` and `$HOME` were
  read-only inside it.
- **Claude Code's sign-in works headless.** On a VM with no browser,
  `claude auth login --claudeai` prints a manual URL, which redirects to
  `platform.claude.com/oauth/code/callback` and shows a code, followed by
  `Paste code here if prompted >`. That is exactly what `parseLoginOutput`
  (`src/studio/agents.ts:299`) already recognises.
- **No public IP is needed.** With the public IP deleted, the VM kept outbound
  access through default outbound access and reached GitHub, npm, Anthropic
  and OpenAI.
- **`npm install -g github:aydinmrnv/relay` leaves `relay` missing.** npm points
  the global package at a temporary clone and then deletes the clone.
  Cloud-init installs a packed tarball of a clone instead. The README's install
  line has the same problem.
- **Memory:** 892 MiB usable, with 4 GiB of swap. Memory and CPU during a real
  run are still to be measured.
- **Not yet verified:** Codex device-code sign-in on the VM, and a full pipeline
  run.

## Milestones

1. **Dial-out.** `relay connect --hub`, and a hub that proxies protocol v1 for
   one hard-coded user. Point the studio at it. This proves the path with the
   runner that exists today.
2. **Machines per account.** Runner records on the existing accounts, and the
   hub creating, starting and deallocating each user's VM.
3. **Any repository.** A repository per run, GitHub App tokens, and the masks.
4. **Triggers.** Webhooks wake the owner's runner and start
   `relay serve --once`.
5. **AI steps on runners.** The canvas's AI step runs as a single structured
   turn on the runner instead of being simulated. Until then, `compile.ts`
   should warn that AI steps are left out of an export rather than dropping
   them silently.

## Open questions

- Where the hub lives in production: a public IP and a domain on Azure, or a
  small always-on service elsewhere.
- Whether a Claude Pro or Max plan's limits hold up under unattended runs, or
  whether heavy users will want Team plans or an API key on their runner.
- Whether "deallocated VMs don't count toward the vCPU quota" holds on the
  student subscription in practice (Azure documents it, but it hasn't been
  tested here).
