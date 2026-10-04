# Deploying Relay

The studio is a Next.js app in `web/`; Relay Cloud is the hub and the runner
machines it starts. Neither is needed to use Relay: the hosted studio and the
CLI are. This is for whoever runs their own.

## Deploying the studio

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

Every variable is described in [`web/.env.example`](../web/.env.example). Without
a database or the Clerk keys the deployment keeps the site up, but the studio
stays closed and `/sign-in` says sign-in is not available. `GET /api/health`
answers 503 and names what is missing until all four are set, so use it as the
deployment's health check.

## Relay Cloud on Azure

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
[design](design/relay-cloud-runners.md#hosting-on-azure) lists what it
costs and what the hub cannot do for you: network isolation between runners,
capacity, and stopping machines while the hub itself is down.

## A development runner VM on Azure

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
