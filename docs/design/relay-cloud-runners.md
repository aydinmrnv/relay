# Relay Cloud runners

**Status: built, invite-only beta.** The hub (`relay hub serve`), dial-out
runners (`relay connect --hub`), one Azure VM per person made and put to sleep
by the hub, and the studio's **Relay Cloud** runner (Settings → Where agents
run) are in this repository. An earlier version of all of it ran end to end
on Azure ([Verified on Azure](#verified-on-azure)). The hardening since then —
runner tokens that are re-issued, the unprivileged run user, the closed
metadata service, pinned installs — is covered by unit tests and has **not**
been run on a real machine ([Not yet verified](#not-yet-verified)). Not built:
webhook triggers waking a runner, per-run GitHub App tokens, network isolation
between runner machines, snapshots of long-idle disks, and a baked VM image.

Relay runs a workflow's Agent pipeline with Claude Code and Codex, signed in
with the user's own Claude and ChatGPT plans, so a run costs nothing in API
fees. On the user's own computer that happens through
[`relay connect`](../cli.md#the-studio-companion). Relay Cloud does the same
thing on a machine Relay runs for them. The user never sees that machine.

## What a user does

1. Signs in to their Relay account, and picks **Relay Cloud** under
   Settings → Where agents run. **Make my machine** makes it; the first time
   takes about five minutes, later starts about a minute. Only people the
   operator has let in can ([Admission](#hosting-on-azure)).
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
the user. Relay never calls a model API. On a person's own computer Relay never
holds a model credential either; on a Relay Cloud machine the sign-ins sit on a
VM Relay operates ([Security](#security) says exactly who can reach them).

| Runner | Where | Exists |
|---|---|---|
| This machine | the user's computer, through `relay connect` | yes |
| GitHub Actions | an exported workflow, on the user's Actions minutes | yes |
| Relay Cloud | a machine Relay runs for that one user | yes, invite-only |
| Self-hosted | `relay connect --hub` on a box the user owns, with a token from `relay hub token` | yes, by hand; the token expires |

The studio talks to a runner the same way whichever it is: companion protocol
v1 (`src/studio/protocol.ts`). The routes live in one place
(`src/studio/router.ts`) and two transports carry them — the loopback HTTP
server on a laptop, and the hub's WebSocket to a cloud runner. The studio keeps
which runner it uses (`target`) next to the pairing, and every machine run
remembers the runner it started on, so switching does not orphan a run.

## One machine per person

Every Relay Cloud user gets their own Linux VM, and nobody else's runs ever
execute on it. That is the isolation between users at the level of processes
and files, and it is what the vendors' rules need:

- **Claude Code** keeps its sign-in in `~/.claude` on that VM. The user signs in
  to the unmodified binary through Anthropic's own page, and Relay's code never
  reads the file.
- **Codex** keeps `~/.codex/auth.json` on that VM. OpenAI says one `auth.json`
  must live on one machine and never be shared across machines at once, because
  it rewrites itself when it refreshes. One VM per person gives exactly that.
  Sign in with ChatGPT (`relay chatgpt login`, docs/cli.md) is deliberately not
  offered on a runner: its callback is a loopback address, and OpenAI opens
  that flow to open-source apps on a person's own machine. Offering it from a
  hosted runner needs their approval first
  (https://openai.com/form/sign-in-with-chatgpt-interest/).

It is not isolation at the level of the network: see [Security](#security).

Runs on one machine take turns: one at a time by default
(`RELAY_CLOUD_RUNNER_MAX_RUNS`), because 1 GiB of memory fits one Claude Code
or Codex plus a test suite, and two would swap. The next waits, marked
`queued`, and starts when the first ends.

The machine runs only while it is needed. The hub **deallocates** it after ten
idle minutes, and a deallocated Azure VM bills its disk and nothing else.

## How the pieces talk

```
 browser (studio) ──HTTPS, Clerk session──▶ hub ◀──WebSocket (outbound)── runner VM (one per person)
                                             │                              relay connect --hub
                                             └──Azure Resource Manager (managed identity)
```

**The runner dials out; nothing dials in.** A runner VM has no public IP. A
system service starts as root, installs what is missing, and then runs
`relay connect --hub <url> --token-from stdin` as the unprivileged `relay-run`
user, which opens a WebSocket *to* the hub and keeps it open. Azure's default
outbound access gives a subnet its way out.

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
   `/runner/relay.tgz`, and states beside it the package's SHA-256 and the
   versions of Claude Code and Codex machines should have, so a runner runs
   the Relay its hub does and installs only a file that matches.

**Who is calling.** A person presents their **Clerk session token**, the
short-lived JWT the browser already has; the hub verifies it against the Clerk
instance's published keys (`src/cloud/hub/auth.ts`), which it reads again when
they are an hour old. The token must name the site it was issued to (`azp`),
and that site must be one of the hub's studios. No secret is shared with the
studio's server and there is no token-minting route for people.

A runner presents a **runner token**: which machine it is and whose, a random
id, when it was made and when it expires, HMAC-signed by the hub's secret. A
signature alone is not enough:

- A managed machine has one current token. The hub issues a new one every time
  it makes or starts the machine, puts it in the VM's **user data**, and
  records its id in a `relay-token` tag on the VM, so a hub that restarts reads
  back which token is current. A token from an earlier start is refused.
- A token is refused unless the hub wants that machine awake (being made,
  starting, or connected), so a copy cannot turn a sleeping machine into a
  connected one.
- Removing a machine ends its token at once.
- A token minted by hand (`relay hub token`, or `POST /admin/v1/tokens`) is for
  a runner someone starts themselves. It can never name a managed machine, and
  it expires: thirty days unless asked otherwise. It is refused while the hub
  manages a machine for the same person: someone is served by a managed machine
  or by a runner of their own, never both, so a runner of their own cannot take
  a managed machine out of reach of the allow-list and the limits.

The hub's secret can be replaced on a running fleet: with the old secret in
`RELAY_HUB_SECRET_PREVIOUS`, tokens it signed are still read while every
machine is re-keyed at its next start (`deploy-hub.sh --rotate-secret`).

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
tags (`relay-role=runner`, `relay-user=<Clerk id>`, `relay-token=<id of its
current token>`) and its name is a hash of the owner's id. The hub keeps no
database: at start it lists the VMs and rebuilds everything, and every 30
seconds it reconciles again. The fleet never assumes a request it made has
landed; each tick it compares what it wants with what Azure last said and with
who is connected, and takes the next step. A hub that crashed halfway through
starting a machine carries on after the restart.

**The hub stays up.** A request line it cannot read is a 400. A runner frame is
checked field by field, and one that is not what its type promises closes that
one connection. Every handler turns a throw into an answer for the one caller,
and `relay hub serve` logs and carries on through an error nothing caught,
because the alternative is every person's machine and every run stream going
down with it.

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
- A machine's own report that it is busy keeps it awake, but not for ever: a
  machine nobody has asked anything of through the hub for six hours is put to
  sleep whatever it says (`RELAY_CLOUD_MAX_UNATTENDED_MINUTES`), and one
  person's machine is awake for at most twelve hours in a UTC day
  (`RELAY_CLOUD_DAILY_HOURS`). The daily count is kept in the hub's memory, so
  a hub restart starts the day again.

  **This stops real work.** A run, or a queue of runs, that goes on for more
  than six hours with nobody starting, stopping or signing in to anything is
  stopped with the machine, and the person is told why. Following the run in
  the studio does not count as asking: an open stream says a tab is open, and
  the records in it are the runner's own word. Raise the limit for longer
  work.

What still depends on the hub being up: every one of these. If the hub is down,
a machine that is awake stays awake until the hub is back. Nothing outside the
hub stops it.

**The link is expected to drop.** Runs belong to the runner process, not the
socket. Reconnects back off exponentially with jitter, so a restarted hub is
not met by every runner in the same second. While a runner is away, the
studio's run stream stays open at the hub; when it is back, the hub asks for
the run again from the first record the browser has not seen
(`/v1/runs/:id/events?since=<seq>`). The studio also retries a stream that
ends without the run's exit record, from where it left off, before calling the
run lost. A runner or a browser that stops reading is cut rather than buffered
for without limit, and one person may follow eight streams at once.

**Boot repairs itself.** Everything a runner needs is installed by the
service's own `ExecStartPre` (`relay-runner-prepare`), with retries, before
the runner starts; cloud-init only writes the files and starts the service. A
first boot that failed halfway finishes on the next start instead of leaving a
machine that never works. The same step brings Relay to the hub's version and
the coding CLIs to the versions the hub names — at boot, because that is when
a machine that sleeps most of the time can update without interrupting a run.

What that step runs as root: Relay from the hub, installed only when its
SHA-256 is the one the hub states; Node and gh from their publishers' apt
repositories, checked against their signing keys; Claude Code and Codex from
npm at the versions set in `RELAY_CLOUD_CLAUDE_CODE_VERSION` and
`RELAY_CLOUD_CODEX_VERSION`. Left unset, those two are `latest`, and the hub
says so in its log at every start. The apt signing keys are fetched over TLS
and their fingerprints are not pinned; the CLIs' own dependencies are whatever
npm resolves; the VM image is `latest` unless `RELAY_CLOUD_IMAGE` names a
version.

## Hosting on Azure

**The limit that matters is quota, and it is per region.** A subscription has
a ceiling on vCPUs running at once *in each region*, and a small subscription
may deploy to only a few regions. The fleet spreads people across the regions
it is given (`RELAY_CLOUD_REGIONS`), so the number of 2-vCPU runners awake at
once is the sum over those regions of what each allows, less the hub's own
VM. A new person's machine goes to the region with the most room; after that
it stays there, with its disk. Deallocated VMs do not count against the quota.

How many machines exist at all, asleep or awake, is a separate limit:
`RELAY_CLOUD_MAX_MACHINES`, ten unless set. Each one is a disk that bills
whether or not it is awake. The eleventh person is told Relay Cloud is full.

**When a region is full.** A wake waits in that region's queue, in order, and
the studio shows its place. A machine idle for two minutes gives up its slot
early to someone waiting (its idle timeout is otherwise ten); a busy one never
does. If Azure refuses a start for quota or capacity, the fleet marks the
region full for a moment and keeps the person in line.

| Piece | Size | Billed |
|---|---|---|
| Hub | `Standard_B2pts_v2` (2 vCPU Arm, 1 GiB), always on, on a VM of its own | by the hour, always |
| Runners | `Standard_B2ats_v2` (2 vCPU AMD, 1 GiB, 4 GiB swap), one per person, deallocated when idle | by the hour, while awake |
| Runner disks | 32 GiB Standard SSD, deleted with the VM | by the month, awake or not |
| Public IPs | none for runners; the hub is published through Tailscale Funnel, or on a static IP with Caddy | the static IP, if used |
| Outbound traffic | default outbound access | by volume past the free allowance |

**Admission.** Machines cost money, so the hub makes one only for people on
`RELAY_CLOUD_ALLOWED_USERS` (Clerk ids, or `*`). The list is checked on every
wake and every tick, not only when a machine is first made: someone taken off
it cannot start their machine again, a machine of theirs that is awake is put
to sleep, and the hub refuses requests that would start something on it. The
machine is not deleted. Its disk and sign-ins stay until the person removes it
from the studio or the operator does (`GET /admin/v1/fleet` lists such
machines under `revoked`; `DELETE /admin/v1/runners/<user id>` removes one).
Deleting a Relay account does not remove its machine either: the studio has to
ask the hub to, before the account goes.

**Operating it.** [`scripts/azure/deploy-hub.sh`](../../scripts/azure/deploy-hub.sh)
makes the resource group, one virtual network per runner region, the hub, its
managed identity and the service. The hub needs a VM of its own, and the
script refuses one that has the coding CLIs on it. Run again, it keeps every
setting it is not given, the allow-list included. `--upgrade` ships new code;
runners follow on their next start. `--rotate-secret` replaces the secret
runner tokens are signed with. The hub logs one JSON line per event to the
journal, answers `/healthz` with whether it is up and its version, and has
operator routes under `/admin/v1` behind a token that never leaves the VM
unless you print it: the fleet, one person's machine, wake, sleep, remove,
drop a runner's socket, and mint a token for a self-hosted runner.

## Security

What is true of the code in this repository, stated without the parts that are
only planned.

- **Between users, on the machine:** a separate VM each. A runner token reaches
  only its own owner's socket, and the hub routes a person's requests only to
  their runner.
- **Between users, on the network:** not isolated. The deploy script creates
  no network security group, all runner machines in a region share one subnet,
  and a hub the script makes sits in a second subnet of the same virtual
  network. One runner machine can open a connection to another. What it finds
  there is sshd, which takes only the key the hub holds. Closing this is an
  operator step today.
- **From the internet:** runners have no public IP. The hub's routes need a
  Clerk session or a current runner token, except `/healthz` (up, and the
  version), `/runner/relay.tgz` (the Relay package, which is public) and the
  operator routes, which need the admin token and answer 404 without it. Every
  frame and body is size-limited; a runner that stops answering pings, or
  stops reading, is cut.
- **The hub's reach:** its managed identity has Contributor on the runners'
  resource group. That is enough to make and delete machines, and it is also
  enough to run a command as root on any of them, which means reading any
  person's sign-ins. So does the SSH key the hub generates for the machines'
  admin user. Whoever controls the hub's VM controls every runner machine;
  that is why the hub must not share a VM with anything that runs agents.
- **Credentials:** model and GitHub sign-ins live in the CLIs' own files in
  `relay-run`'s home on the person's VM. The runner token is in the VM's user
  data. Only root may reach the instance metadata service that serves user
  data; the service's root start step reads the token and passes it to the
  runner down a pipe, so it is never in a file, the environment or a command
  line the agents' user can read.
- **Inside a VM:** the runner, the coding CLIs and everything an agent writes
  run as `relay-run`, which has no `sudo`. (The VM's admin user, which Azure
  creates, does; nothing of Relay's runs as it.) Read-only turns run under
  bubblewrap. An agent runs as the same user as the runner, so it can read the
  sign-ins on its own machine, as it can on a laptop, and it can signal or
  stop the runner. What it cannot do is read the runner's token: core dumps
  are off, ptrace is limited to a process's own descendants, Node's SIGUSR1
  debugger is refused by the runner and switched off for the machine where the
  installed Node has the flag, and only root schedules jobs. A separate user for agent turns, and per-run GitHub App
  tokens, are what would close the rest.

## What changed from the first design

| First design | Now | Why |
|---|---|---|
| Runners awake at once limited by one region's quota | Spread across every configured region | The quota is per region |
| The studio's server mints hub tokens | The hub verifies Clerk session tokens itself | No shared secret, no extra hop, one less route to secure |
| A `runners` table in the studio's Postgres | No database: VM tags are the record | A hub that loses its memory rebuilds it from Azure; nothing to migrate or keep in step |
| Runner tokens stored per VM | HMAC tokens in user data, re-issued at every start, their id in a tag | Stateless to sign, and a copied token stops working when the machine next sleeps and wakes |
| GitHub App tokens per run | `gh`'s device flow on the runner, for now | Works today with nothing to register; the App is the next hardening step |
| Two runs at a time on 1 GiB | One, the rest queued | Two coding agents and a test suite do not fit in 1 GiB |
| Cloud-init installs everything | The service's start step installs, with retries | A failed first boot repairs itself |
| Hub on any VM you have | Hub on a VM of its own | Its identity and its secret must not be within reach of code an agent runs |
| 32 GiB Standard HDD disks | 32 GiB Standard SSD | Git and package installs on HDD latency make every run slower |

## Verified on Azure

These come from real VMs, with the hub deployed by an earlier `deploy-hub.sh`
and a person signed in through Clerk. They predate the changes listed under
[Not yet verified](#not-yet-verified).

- **A first machine, from nothing to connected: 2 minutes 10 seconds**, in the
  region with the most room. Waking it again from asleep: **30 seconds**,
  including updating itself to the hub's newer Relay.
- **The hub rebuilds itself from Azure.** Restarted with one machine asleep, it
  reported that machine asleep before anyone asked.
- **All three sign-ins start headless through the hub**: GitHub and Codex show
  a device code, Claude a page and a paste prompt.
- **A run in the cloud** cloned a 15 MB repository blobless, branched a
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
  refused `*.ts.net` — no DNS answer, then a reset TLS handshake — from a
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
- **`npm install -g github:<owner>/<repo>` leaves `relay` missing**, so
  runners install a packed tarball — the hub's own.
- **Memory:** 892 MiB usable on `Standard_B2ats_v2`, with 4 GiB of swap.

## Not yet verified

Changed since the last machine was made for real. The unit tests run the hub's
logic against an in-memory cloud and run the machine's start-up scripts with
the programs they call replaced by stand-ins. None of the following has been
seen working on Azure, and each should be checked on one machine before anyone
is invited:

- **Replacing a machine's token before a start**: one `PATCH` of the VM with
  new user data and tags. If Azure refuses it, the machine is not started and
  the person sees the error.
- **The `relay-run` user**, and the service starting as root and dropping to it
  with `setpriv`. Sign-ins now live in `/home/relay-run`.
- **The firewall rule** that lets only root reach 169.254.169.254, and that
  nothing else on the image needs that address as another user.
- **bubblewrap and both CLIs' sandboxes as `relay-run`**, a user made by
  `useradd` rather than by Azure.
- **Installing Node from NodeSource's apt repository** instead of its setup
  script, and Relay only on a matching SHA-256.
- **Machines made by the earlier hub** have none of this: their unit, their
  admin-user runner and their permanent token. The new hub refuses that token.
  Remove and re-make them.

## Next

1. **Network isolation.** A network security group on every runners' subnet
   that denies traffic between machines, and the hub in a virtual network of
   its own.
2. **Something outside the hub that stops machines** when the hub is down.
3. **Triggers.** Webhooks wake the owner's runner, with the same allowlist,
   budgets and kill switches as the GitHub Action. The studio does the
   deciding, before anything is woken, and the hub hands the runner a job:
   [Running workflows for real](workflow-execution.md).
4. **GitHub App tokens.** A token scoped to one repository per run, handed only
   to Relay's own `git` and `gh`, so no agent ever holds a GitHub credential.
5. **A separate user for agent turns**, so an agent cannot read the sign-ins or
   signal the runner.
6. **A baked image** in an Azure Compute Gallery, so a first start is a normal
   boot and every runner starts from the same bytes.
7. **Idle disks.** Snapshot a disk idle for weeks and delete it; restore it on
   the next wake.
8. **AI steps on runners.** The canvas's AI step as a single structured turn on
   the runner, instead of simulated.
