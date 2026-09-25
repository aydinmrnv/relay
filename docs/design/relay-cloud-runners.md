# Relay Cloud runners

**Status: built, invite-only.** The hub (`relay hub serve`), dial-out runners
(`relay connect --hub`), one Azure VM per person made and put to sleep by the
hub, and the studio's **Relay Cloud** runner (Settings → Where agents run) are
in this repository and tested end to end on Azure
([Verified on Azure](#verified-on-azure)). Not built yet: webhook triggers
waking a runner, per-run GitHub App tokens, snapshots of long-idle disks, and
a baked VM image. [What changed from the first design](#what-changed-from-the-first-design)
says why the rest looks the way it does.

Relay runs a workflow's Agent pipeline with Claude Code and Codex, signed in
with the user's own Claude and ChatGPT plans, so a run costs nothing in API
fees. On the user's own computer that happens through
[`relay connect`](../cli.md#the-studio-companion). Relay Cloud does the same
thing on a machine Relay runs for them. The user never sees that machine.

## What a user does

1. Signs in to their Relay account, and picks **Relay Cloud** under
   Settings → Where agents run. **Make my machine** makes it; the first time
   takes about five minutes, later starts about a minute.
2. Under Coding agents, clicks **Sign in with Claude**, **Sign in with ChatGPT**
   and **Sign in to GitHub**. Each runs the vendor's own sign-in on their
   machine: a Claude page with a code to paste back, and a device code to type
   on OpenAI's and GitHub's pages.
3. Presses **Run in Relay Cloud** on a workflow, names the repository, and
   watches the canvas light up. The pull request opens as them.

There is no Azure account, SSH key, VPN or terminal on their side.

## The idea: runners

A **runner** is the place where a run executes and where the coding CLIs are
signed in. Every AI call is still the vendor's own CLI, unmodified, signed in by
the user. Relay never calls a model API and never holds a model credential
([Design](../cli.md#design)).

| Runner | Where | Exists |
|---|---|---|
| This machine | the user's computer, through `relay connect` | yes |
| GitHub Actions | an exported workflow, on the user's Actions minutes | yes |
| Relay Cloud | a machine Relay runs for that one user | yes, invite-only |
| Self-hosted | `relay connect --hub` on a box the user owns, with a token from `relay hub token` | yes, by hand |

The studio talks to a runner the same way whichever it is: companion protocol
v1 (`src/studio/protocol.ts`). The routes live in one place
(`src/studio/router.ts`) and two transports carry them — the loopback HTTP
server on a laptop, and the hub's WebSocket to a cloud runner. The studio keeps
which runner it uses (`target`) next to the pairing, and every machine run
remembers the runner it started on, so switching does not orphan a run.

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

Runs on one machine take turns: one at a time by default
(`RELAY_RUNNER_MAX_RUNS`), because 1 GiB of memory fits one Claude Code or
Codex plus a test suite, and two would swap. The next waits, marked `queued`,
and starts when the first ends.

The machine runs only while it is needed. The hub **deallocates** it after ten
idle minutes, and a deallocated Azure VM bills its disk and nothing else.

## How the pieces talk

```
 browser (studio) ──HTTPS, Clerk session──▶ hub ◀──WebSocket (outbound)── runner VM (one per person)
                                             │                              relay connect --hub
                                             └──Azure Resource Manager (managed identity)
```

**The runner dials out; nothing dials in.** A runner VM has no public IP and no
open port. A system service runs `relay connect --hub <url> --token-from azure`,
which opens a WebSocket *to* the hub and keeps it open. Azure's default
outbound access gives a subnet its way out, free.

**The hub** is one small, always-on process, `relay hub serve`, shipped in the
same package as the runner (no new dependency: a small RFC 6455 server in
`src/cloud/ws.ts`, Azure through its REST API). It does three jobs:

1. **Proxy.** The studio calls the hub at the same paths it calls a laptop's
   companion — `https://<hub>/v1/agents`, `/v1/runs`, … — and the hub carries
   each request down the person's socket as a frame (`src/cloud/frames.ts`).
   `/cloud/v1/runner` is the one thing a laptop does not have: the machine's
   own state, and wake, sleep and remove.
2. **Lifecycle.** The fleet (`src/cloud/hub/fleet.ts`) makes, starts and
   deallocates each person's VM ([below](#keeping-it-reliable)).
3. **Versions.** It serves its own Relay package to runners at
   `/runner/relay.tgz`, named by version and content hash, so a runner always
   runs the Relay its hub does.

**Who is calling.** A person presents their **Clerk session token**, the
short-lived JWT the browser already has; the hub verifies it against the Clerk
instance's published keys (`src/cloud/hub/auth.ts`). No secret is shared with
the studio's server and there is no token-minting route. A runner presents a
**runner token**: which machine it is and whose, HMAC-signed by the hub's
secret. The hub keeps no list of tokens, so a hub that restarts empty still
knows every runner. A managed VM gets its token in its **user data**, which the
runner reads from the instance metadata service at every connect — it is never
written to disk.

## Sign-in on a VM

| Account | Offered on a cloud runner | Not offered, and why |
|---|---|---|
| Claude Code | Sign in with Claude (open a page, paste the code back); Anthropic Console API key | none |
| Codex | Device code | ChatGPT browser sign-in: it returns to `localhost` on the VM, which the user's browser cannot reach |
| GitHub | `gh auth login` device code; `gh auth setup-git` points git at it | none |

A pasted code travels browser → hub → runner → the CLI's stdin. The hub never
logs a request body. The credential is written by the CLI, on the user's VM,
and Relay has no route that reads it.

## A run in the cloud

1. The studio sends the compiled workflow, the task and `owner/repo`.
2. The hub wakes the machine if it is asleep (a run is a reason to; a status
   check never is) and forwards the request.
3. The runner fetches or clones the repository under `~/.relay/repos/` —
   blobless, so history without file contents until a worktree needs them — and
   runs `relay run --json` there with the workflow's config layered over the
   repository's own: the same child process a laptop runs.
4. The engine's JSON lines stream back through the hub; the canvas lights up
   as it does for a run on this machine.
5. Delivery pushes and opens the pull request with the user's own GitHub
   sign-in.

## Keeping it reliable

**The cloud is the source of truth.** Every runner VM carries its owner in its
tags (`relay-role=runner`, `relay-user=<Clerk id>`) and its name is a hash of
that id. The hub keeps no database: at start it lists the VMs and rebuilds
everything, and every 30 seconds it reconciles again. The fleet never assumes
a request it made has landed; each tick it compares what it wants with what
Azure last said and with who is connected, and takes the next step. A hub that
crashed halfway through starting a machine carries on after the restart.

**Nothing stuck, nothing billing by accident.**

- A machine that is running but never dials in is restarted once, then put to
  sleep with an error the person sees (*Your machine started but Relay could not
  reach it*), and Start tries again.
- A VM Azure failed to make is removed and made again on the next wake.
- A VM left `stopped` — shut down from inside, still holding its CPUs and still
  billed — is deallocated.
- A runner that dials back in during the seconds its machine is being
  deallocated is refused, so a sleeping machine is never mistaken for an awake
  one.
- A runner that drops mid-run gets ten extra minutes to come back before its
  machine is restarted under it.

**The link is expected to drop.** Runs belong to the runner process, not the
socket. Reconnects back off exponentially with jitter, so a restarted hub is
not met by every runner in the same second. While a runner is away, the
studio's run stream stays open at the hub; when it is back, the hub asks for
the run again from the first record the browser has not seen
(`/v1/runs/:id/events?since=<seq>`). The studio also retries a stream that
ends without the run's exit record, from where it left off, before calling the
run lost.

**Boot repairs itself.** Everything a runner needs is installed by the
service's own `ExecStartPre` (`relay-runner-prepare`), with retries, before
`relay connect --hub` starts; cloud-init only writes the files and starts the
service. A first boot that failed halfway finishes on the next start instead of
leaving a machine that never works. The same step brings Relay to the hub's
version and refreshes Claude Code and Codex once a week — at boot, because
that is when a machine that sleeps most of the time can update without
interrupting a run.

## Hosting on Azure

**The limit that matters is quota, and it is per region.** An Azure for
Students subscription allows 6 vCPUs running at once *in each region*, and five
regions. `Standard_B2ats_v2` is offered in four of them (not in Switzerland
North), so the fleet spreads people across North Central US, Spain Central,
Mexico Central and Belgium Central: **eleven 2-vCPU runners awake at once**
with the hub in one region, not the two a single region allows. A new person's
machine goes to the region with the most room; after that it stays there, with
its disk. Deallocated VMs do not count, so any number of people can have a
machine.

**When a region is full.** A wake waits in that region's queue, in order, and
the studio shows its place. A machine idle for two minutes gives up its slot
early to someone waiting (its idle timeout is otherwise ten); a busy one never
does. If Azure refuses a start for quota or capacity, the fleet marks the
region full for a moment and keeps the person in line.

| Piece | Size | Cost on the student subscription |
|---|---|---|
| Hub | `Standard_B2pts_v2` (2 vCPU Arm, 1 GiB), always on; or any VM you have | free: 750 h/month of this size for 12 months |
| Runners | `Standard_B2ats_v2` (2 vCPU AMD, 1 GiB, 4 GiB swap), one per person, deallocated when idle | free up to 750 h/month across runners of this size, then about $0.01/hour |
| Runner disks | 32 GiB Standard SSD, deleted with the VM | about $2.40/month each |
| Public IPs | none for runners; the hub is published through Tailscale Funnel, or on a static IP with Caddy | $0, or about $3.65/month |
| Outbound traffic | default outbound access | the first 100 GB/month are free |

**Admission.** Machines cost money, so the hub makes one only for people on
`RELAY_CLOUD_ALLOWED_USERS` (Clerk ids, or `*`), and never more than
`RELAY_CLOUD_MAX_MACHINES` in all.

**Operating it.** [`scripts/azure/deploy-hub.sh`](../../scripts/azure/deploy-hub.sh)
makes the resource group, one virtual network per runner region, the hub (or
installs it on a VM you have), its managed identity — Contributor on the
runners' resource group, nothing else — and the service. Run again with
`--upgrade` to ship new code; runners follow on their next start. The hub logs
one JSON line per event to the journal, answers `/healthz`, and has operator
routes under `/admin/v1` behind a token that never leaves the VM unless you
print it: the fleet, one person's machine, wake, sleep, remove, drop a
runner's socket, and mint a token for a self-hosted runner.

## Security

- **Between users:** a separate VM each. A runner token reaches only its own
  owner's socket, and the hub routes a person's requests only to their runner.
- **From the internet:** runners have no public IP and no inbound rules. The
  hub's routes all need a Clerk session or a runner token, except `/healthz`
  and the public Relay package. Every frame and body is size-limited; a runner
  that stops answering pings is cut.
- **Credentials:** model and GitHub sign-ins live in the CLIs' own files on the
  person's VM. The Azure credential is the hub's managed identity, scoped to one
  resource group. The runner token is in the VM's user data, not on its disk.
- **Inside a VM:** agents run as the unprivileged `relay` user; read-only turns
  run under bubblewrap. An agent can read the sign-ins on its own machine, as
  it can on a laptop — with per-run GitHub App tokens (below) that stops being
  true for GitHub.

## What changed from the first design

| First design | Now | Why |
|---|---|---|
| Two runners awake at once (6 vCPUs, hub takes 2) | Eleven, across four regions | The quota is per region; the size is offered in four of the five allowed |
| The studio's server mints hub tokens | The hub verifies Clerk session tokens itself | No shared secret, no extra hop, one less route to secure |
| A `runners` table in the studio's Postgres | No database: VM tags are the record | A hub that loses its memory rebuilds it from Azure; nothing to migrate or keep in step |
| Runner tokens stored per VM | HMAC tokens carrying their identity, in user data | Stateless to verify; never on disk |
| GitHub App tokens per run | `gh`'s device flow on the runner, for now | Works today with nothing to register; the App is the next hardening step |
| Two runs at a time on 1 GiB | One, the rest queued | Two coding agents and a test suite do not fit in 1 GiB |
| Cloud-init installs everything | The service's start step installs, with retries | A failed first boot repairs itself |
| Hub on its own VM only | Its own VM, or any VM you have | Deploy on the development VM today, move to a free Arm VM later |
| 32 GiB Standard HDD disks | 32 GiB Standard SSD | Git and package installs on HDD latency make every run slower, for $0.86/month |

## Verified on Azure

These come from real VMs in the subscription the design was written for, with
the hub deployed by `deploy-hub.sh` and a person signed in through Clerk.

- **A first machine, from nothing to connected: 2 minutes 10 seconds**, in
  Spain Central, the region with the most room. Waking it again from asleep:
  **30 seconds**, including updating itself to the hub's newer Relay.
- **The hub rebuilds itself from Azure.** Restarted with one machine asleep, it
  reported that machine asleep before anyone asked.
- **All three sign-ins start headless through the hub**: GitHub and Codex show
  a device code, Claude a page and a paste prompt.
- **A run in the cloud** cloned `aydinmrnv/relay` (15 MB blobless), branched a
  worktree from `origin/main` and streamed every record back through the hub.
- **Listing VMs with `$expand=instanceView` fails once the resource group holds
  one** ("only supported when Virtual Machine Scale Set resource filter is
  applied"). The hub lists the group for tags and the subscription with
  `statusOnly=true` for power states, and merges them by id — which also
  spells regions in two cases (`spaincentral`, `SpainCentral`).
- **Run-command truncates scripts past about 150 kB without an error**, so
  `deploy-hub.sh` ships the package in pieces of that size and checks its
  hash before installing it.
- **Some networks block Tailscale Funnel.** A filtering resolver and firewall
  refused `*.ts.net` — no DNS answer, then a reset TLS handshake — from a home
  network where it had worked ten minutes earlier. Funnel is fine for trying
  Relay Cloud; for other people, publish the hub on a static IP with Caddy
  (`--expose public-ip`) or a domain of your own.
- **bubblewrap needs an AppArmor profile** on Ubuntu 24.04, which restricts
  unprivileged user namespaces; runner cloud-init installs one for `bwrap` alone.
- **Codex's own Linux sandbox works unchanged.**
- **Claude Code's sign-in works headless**: `claude auth login --claudeai`
  prints a URL whose page shows a code, then `Paste code here if prompted >`.
- **GitHub's device flow works headless**: `gh auth login --web` without a
  terminal prints `First copy your one-time code: XXXX-XXXX` and the device URL,
  then polls.
- **No public IP is needed**: default outbound access reaches GitHub, npm,
  Anthropic and OpenAI.
- **`npm install -g github:aydinmrnv/relay` leaves `relay` missing**, so
  runners install a packed tarball — now the hub's own.
- **Memory:** 892 MiB usable, with 4 GiB of swap.
- **Quota:** 6 vCPUs per region in each of `northcentralus`, `spaincentral`,
  `mexicocentral`, `belgiumcentral` and `switzerlandnorth`;
  `Standard_B2ats_v2` is not offered in `switzerlandnorth`.

## Next

1. **Triggers.** Webhooks wake the owner's runner and start
   `relay serve --once --issue <n>`, with the same allowlist, budgets and kill
   switches as the GitHub Action.
2. **GitHub App tokens.** A token scoped to one repository per run, handed only
   to Relay's own `git` and `gh`, so no agent ever holds a GitHub credential.
3. **A baked image** in an Azure Compute Gallery, so a first start is a normal
   boot and every runner starts from the same bytes.
4. **Idle disks.** Snapshot a disk idle for weeks and delete it; restore it on
   the next wake.
5. **AI steps on runners.** The canvas's AI step as a single structured turn on
   the runner, instead of simulated.
