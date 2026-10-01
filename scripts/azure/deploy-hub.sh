#!/usr/bin/env bash
#
# Deploy the Relay Cloud hub on Azure, and everything the runner machines it
# makes need. Safe to run again: it updates what is there, keeps the hub's
# secrets, and keeps every setting this run was not given, so a re-run to
# change one thing never resets another.
#
#   scripts/azure/deploy-hub.sh --expose public-ip --allow user_2abc     # a new hub VM with its own address
#   scripts/azure/deploy-hub.sh --allow user_2abc,user_2def              # change who may have a machine
#   scripts/azure/deploy-hub.sh --upgrade                                # new Relay code only
#   scripts/azure/deploy-hub.sh --rotate-secret                          # replace the secret runner tokens are signed with
#   scripts/azure/deploy-hub.sh --print-admin-token
#   scripts/azure/deploy-hub.sh --vm <group>/<name> ...                  # the same, on a VM you already have
#
# What it makes:
#
#   relay-cloud                  a resource group for the runners (their VMs, disks and NICs)
#   relay-runners-<region>       one virtual network per runner region, whose subnet keeps
#                                Azure's default outbound access: the runners' only way out,
#                                free, and no public address to come in by
#   the hub                      `relay hub serve` as a system service, on a new
#                                Standard_B2pts_v2 or on --vm. Its managed identity gets
#                                Contributor on relay-cloud, so no Azure secret exists.
#
# The hub's VM must be the hub's alone. Its managed identity can make, delete and run
# commands on every runner machine, and its disk holds the secret runner tokens are
# signed with; any program on that VM can reach both. So this script refuses a VM that
# has the coding CLIs installed: that is a machine agents run on. (--unsafe-shared-vm
# overrides the refusal, for a hub nobody but its developer uses.)
#
# How browsers and runners reach the hub (--expose):
#
#   funnel      Tailscale Funnel: https://<vm>.<tailnet>.ts.net, free, no public IP. The VM
#               must be on your tailnet with Funnel allowed (the default). Fine for trying
#               the hub out; some networks block *.ts.net, so not for other people.
#   public-ip   a static public IP with an Azure DNS name, and Caddy with a Let's Encrypt
#               certificate.
#
# Afterwards, set RELAY_CLOUD_HUB_URL on the studio's deployment to the URL this prints,
# and redeploy it.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

group="relay-cloud"
vm=""
location="northcentralus"
regions="northcentralus,spaincentral,mexicocentral,belgiumcentral"
expose="funnel"
hub_name="relay-hub"
hub_size="Standard_B2pts_v2"
runner_size="Standard_B2ats_v2"
clerk_key="${CLERK_PUBLISHABLE_KEY:-}"
# Settings a re-run keeps unless it is given them. Empty here means "not given".
studios=""
allow=""
allow_given=no
max_machines=""
idle_minutes=""
claude_code_version=""
codex_version=""
upgrade=false
print_admin=false
rotate_secret=false
shared_vm_ok=false

# The studio this hub serves unless told otherwise: the one the CLI trusts. It is
# written in one place, src/studio/protocol.ts, and read from there.
default_studio() {
  if [[ -n "${RELAY_STUDIO_URL:-}" ]]; then
    echo "$RELAY_STUDIO_URL"
    return
  fi
  sed -n "s/^export const TRUSTED_STUDIO_ORIGIN = '\(.*\)';\$/\1/p" "$root/src/studio/protocol.ts"
}

usage() {
  sed -n '3,40p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --vm <group>/<name>          install on this existing Linux VM instead of making one
  --location <region>          where a new hub VM goes (default: $location)
  --regions <a,b,...>          regions runners are made in (default: $regions)
  --group <name>               the runners' resource group (default: $group)
  --expose funnel|public-ip    how the hub is reached (default: $expose)
  --studio <origins>           comma-separated studio origins (first deploy: $(default_studio))
  --clerk-publishable-key <pk> the studio's Clerk key (default: \$CLERK_PUBLISHABLE_KEY)
  --allow <'*'|ids>            who may have a machine: '*' or Clerk user ids (first deploy: nobody)
  --max-machines <n>           machines the hub will ever make (first deploy: the hub's own default)
  --idle-minutes <n>           minutes idle before a machine is put to sleep (first deploy: the hub's own default)
  --claude-code-version <v>    the Claude Code version runner machines install (first deploy: latest)
  --codex-version <v>          the Codex version runner machines install (first deploy: latest)
  --runner-size <sku>          runner VM size (default: $runner_size)
  --upgrade                    only ship this checkout's Relay to the hub and restart it
  --rotate-secret              replace the hub's secret; the old one is still read until you remove it
  --print-admin-token          print the token for the hub's /admin routes, and stop
  --unsafe-shared-vm           install on a VM that also runs coding agents (development only)

A setting marked "first deploy" keeps the value the last deploy wrote when it is not given.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm) vm="$2"; shift 2 ;;
    --location) location="$2"; shift 2 ;;
    --regions) regions="$2"; shift 2 ;;
    --group) group="$2"; shift 2 ;;
    --expose) expose="$2"; shift 2 ;;
    --studio) studios="$2"; shift 2 ;;
    --clerk-publishable-key) clerk_key="$2"; shift 2 ;;
    --allow) allow="$2"; allow_given=yes; shift 2 ;;
    --max-machines) max_machines="$2"; shift 2 ;;
    --idle-minutes) idle_minutes="$2"; shift 2 ;;
    --claude-code-version) claude_code_version="$2"; shift 2 ;;
    --codex-version) codex_version="$2"; shift 2 ;;
    --runner-size) runner_size="$2"; shift 2 ;;
    --upgrade) upgrade=true; shift ;;
    --rotate-secret) rotate_secret=true; shift ;;
    --print-admin-token) print_admin=true; shift ;;
    --unsafe-shared-vm) shared_vm_ok=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$expose" in funnel|public-ip) ;; *) echo "--expose is funnel or public-ip." >&2; exit 2 ;; esac

# Everything below is written into a script that runs as root on the hub, between
# single quotes. Each value is checked to be made only of characters that cannot end one.
safe() {
  local name="$1" value="$2" pattern="$3"
  [[ -z "$value" || "$value" =~ $pattern ]] || { echo "$name: \"$value\" is not a value this script can carry." >&2; exit 2; }
}
safe --allow "$allow" '^(\*|[A-Za-z0-9_]+(,[A-Za-z0-9_]+)*)$'
safe --studio "$studios" '^[A-Za-z0-9.:/,_-]+$'
safe --max-machines "$max_machines" '^[0-9]+$'
safe --idle-minutes "$idle_minutes" '^[0-9]+$'
safe --claude-code-version "$claude_code_version" '^[A-Za-z0-9][A-Za-z0-9.+-]*$'
safe --codex-version "$codex_version" '^[A-Za-z0-9][A-Za-z0-9.+-]*$'
safe --clerk-publishable-key "$clerk_key" '^pk_[A-Za-z0-9_=+/-]+$'
safe --regions "$regions" '^[a-z0-9]+(,[a-z0-9]+)*$'
safe --group "$group" '^[A-Za-z0-9._()-]+$'
safe --runner-size "$runner_size" '^[A-Za-z0-9_]+$'
if [[ "$allow_given" == yes && -z "$allow" ]]; then
  echo "--allow '' would let nobody in. To do that on purpose, pass --allow none." >&2
  exit 2
fi
[[ "$allow" == none ]] && allow=""

if [[ -n "$vm" ]]; then
  hub_group="${vm%%/*}"
  hub_vm="${vm#*/}"
  [[ "$hub_group" != "$vm" && -n "$hub_vm" ]] || { echo "--vm is <resource group>/<vm name>." >&2; exit 2; }
else
  hub_group="$group"
  hub_vm="$hub_name"
fi

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Runs a script on the hub as root through the Azure agent: no inbound port needed.
on_hub() {
  az vm run-command invoke --resource-group "$hub_group" --name "$hub_vm" \
    --command-id RunShellScript --scripts "$1" \
    --query "value[0].message" -o tsv --only-show-errors
}

# What a script printed on the hub, without the agent's framing.
hub_stdout() { sed -n '/\[stdout\]/,/\[stderr\]/p' | sed '1d;$d'; }

if $print_admin; then
  on_hub "cat /etc/relay/admin-token" | hub_stdout | tr -d '[:space:]'
  echo
  exit 0
fi

# ---------------------------------------------------------------------
# The hub's VM must not be one agents run on. Asked of the VM itself, before
# anything is shipped to it: the coding CLIs on its PATH or among its global npm
# packages, or a sign-in for one in any home directory.
refuse_shared_vm() {
  local found
  found="$(on_hub "for b in claude codex; do command -v \$b 2>/dev/null; done; npm ls -g --depth=0 2>/dev/null | grep -E '@anthropic-ai/claude-code|@openai/codex'; ls -d /root/.claude /root/.codex /home/*/.claude /home/*/.codex 2>/dev/null; true" | hub_stdout | sed '/^[[:space:]]*$/d')"
  [[ -z "$found" ]] && return 0
  echo >&2
  echo "$hub_vm has the coding CLIs on it:" >&2
  sed 's/^/  /' <<<"$found" >&2
  if $shared_vm_ok; then
    echo "Going on because of --unsafe-shared-vm. Anything an agent runs on $hub_vm can use the hub's" >&2
    echo "Azure identity and read the secret runner tokens are signed with. Do not let anyone else use this hub." >&2
    return 0
  fi
  cat >&2 <<EOF
That makes it a machine agents run on, and the hub cannot share one: whatever an agent
runs there can use the hub's Azure identity (which can run commands on every runner
machine) and read the secret runner tokens are signed with.

Give the hub a VM of its own: run this again without --vm to make one. For a hub that
only you use, --unsafe-shared-vm goes on anyway.
EOF
  exit 1
}

# ---------------------------------------------------------------------
if $rotate_secret; then
  [[ -z "$vm" ]] || refuse_shared_vm
  step "Replacing the hub's secret"
  # The old secret is kept beside the new one and still read (RELAY_HUB_SECRET_PREVIOUS_FILE),
  # so machines that are awake stay connected. Every machine gets a token signed with the
  # new secret at its next start.
  rotate=$(cat <<'SCRIPT'
set -e
[ -s /etc/relay/hub-secret ] || { echo "no hub secret on this VM: deploy the hub first" >&2; exit 1; }
umask 077
{ cat /etc/relay/hub-secret; echo; cat /etc/relay/hub-secret.previous 2>/dev/null || true; } | sed '/^$/d' > /etc/relay/hub-secret.previous.new
mv /etc/relay/hub-secret.previous.new /etc/relay/hub-secret.previous
openssl rand -base64 48 | tr -d '\n' > /etc/relay/hub-secret.new
mv /etc/relay/hub-secret.new /etc/relay/hub-secret
chown relay-hub:relay-hub /etc/relay/hub-secret /etc/relay/hub-secret.previous
chmod 0400 /etc/relay/hub-secret /etc/relay/hub-secret.previous
grep -q '^RELAY_HUB_SECRET_PREVIOUS_FILE=' /etc/relay/hub.env || echo 'RELAY_HUB_SECRET_PREVIOUS_FILE=/etc/relay/hub-secret.previous' >> /etc/relay/hub.env
systemctl restart relay-hub
sleep 3
systemctl is-active relay-hub
echo "earlier secrets still read: $(wc -l < /etc/relay/hub-secret.previous | tr -d ' ')"
SCRIPT
)
  on_hub "$rotate" | hub_stdout
  cat <<EOF

The hub now signs runner tokens with a new secret and still reads the old one.
  - Machines the hub manages are re-keyed at their next start. Nothing to do.
  - Tokens you minted by hand (relay hub token, POST /admin/v1/tokens) keep working until the
    old secret is removed; mint new ones before then.
  - To stop reading the old secret (which revokes every token it signed), empty
    /etc/relay/hub-secret.previous on $hub_vm and restart relay-hub.
EOF
  exit 0
fi

subscription="$(az account show --query id -o tsv)"
group_id="/subscriptions/$subscription/resourceGroups/$group"

# An existing VM is checked before anything is packed or shipped. A VM this script makes
# is new and empty, and is checked again on every later run, because it is found by name.
if [[ -n "$vm" ]] || az vm show -g "$hub_group" -n "$hub_vm" --only-show-errors -o none 2>/dev/null; then
  refuse_shared_vm
fi

# ---------------------------------------------------------------------
step "Packing Relay from this checkout"
pack_dir="$(mktemp -d)"
trap 'rm -rf "$pack_dir"' EXIT
(cd "$root" && npm ci --silent --no-audit --no-fund >/dev/null && npm pack --silent --pack-destination "$pack_dir" >/dev/null)
tarball="$(ls "$pack_dir"/relay-orchestrator-*.tgz)"
echo "$(basename "$tarball"), $(du -h "$tarball" | cut -f1)"

if ! $upgrade; then
  [[ "$clerk_key" == pk_* ]] || { echo "Pass --clerk-publishable-key (the studio's pk_test_/pk_live_ key)." >&2; exit 2; }

  # -------------------------------------------------------------------
  step "Resource group and runner networks"
  az group create --name "$group" --location "$location" --only-show-errors -o none
  index=0
  IFS=',' read -r -a region_list <<<"$regions"
  for region in "${region_list[@]}"; do
    index=$((index + 1))
    vnet="relay-runners-$region"
    if ! az network vnet show -g "$group" -n "$vnet" --only-show-errors -o none 2>/dev/null; then
      az network vnet create -g "$group" -n "$vnet" --location "$region" \
        --address-prefixes "10.$((100 + index)).0.0/16" --subnet-name runners --subnet-prefixes "10.$((100 + index)).0.0/20" \
        --only-show-errors -o none
    fi
    # Without it a subnet made after September 2025 has no way out at all.
    az network vnet subnet update -g "$group" --vnet-name "$vnet" -n runners --default-outbound true --only-show-errors -o none
    echo "$region: $vnet"
  done

  # -------------------------------------------------------------------
  if [[ -z "$vm" ]]; then
    step "The hub VM"
    if ! az vm show -g "$hub_group" -n "$hub_vm" --only-show-errors -o none 2>/dev/null; then
      hub_vnet="relay-runners-$location"
      if ! az network vnet subnet show -g "$group" --vnet-name "$hub_vnet" -n hub --only-show-errors -o none 2>/dev/null; then
        prefix="$(az network vnet show -g "$group" -n "$hub_vnet" --query 'addressSpace.addressPrefixes[0]' -o tsv)"
        az network vnet subnet create -g "$group" --vnet-name "$hub_vnet" -n hub --address-prefixes "${prefix%.0.0/16}.255.0/24" --default-outbound true --only-show-errors -o none
      fi
      address=(--public-ip-address "")
      if [[ "$expose" == public-ip ]]; then
        address=(--public-ip-sku Standard --public-ip-address-allocation static --public-ip-address-dns-name "relay-hub-${subscription:0:8}")
      fi
      az vm create -g "$hub_group" -n "$hub_vm" --location "$location" \
        --image Canonical:ubuntu-24_04-lts:server-arm64:latest --size "$hub_size" \
        --admin-username relay --generate-ssh-keys \
        --storage-sku Premium_LRS --os-disk-size-gb 64 \
        --vnet-name "$hub_vnet" --subnet hub "${address[@]}" --nsg "$hub_vm-nsg" --nsg-rule NONE \
        --only-show-errors -o none
      echo "Made $hub_vm ($hub_size) in $location."
    else
      echo "$hub_vm is already there."
    fi
  fi

  step "The hub's identity: Contributor on $group"
  az vm identity assign -g "$hub_group" -n "$hub_vm" --role Contributor --scope "$group_id" --only-show-errors -o none
  echo "Assigned."
fi

# ---------------------------------------------------------------------
step "Shipping Relay to $hub_vm"
b64="$pack_dir/relay.b64"
base64 < "$tarball" | tr -d '\n' > "$b64"
# Run-command truncates scripts much past 150 kB without saying so, so the
# package goes over in pieces of that size and is checked when it lands.
split -b 150000 "$b64" "$pack_dir/part-"
part=0
for piece in "$pack_dir"/part-*; do
  redirect=">>"
  (( part == 0 )) && redirect=">"
  on_hub "install -d -m 0755 /opt/relay; printf '%s' '$(cat "$piece")' $redirect /opt/relay/relay.b64" >/dev/null
  part=$((part + 1))
  printf '.'
done
echo " $part parts"
remote_sum="$(on_hub "set -e; base64 -d /opt/relay/relay.b64 > /opt/relay/relay.tgz.new && rm /opt/relay/relay.b64 && sha256sum /opt/relay/relay.tgz.new" | grep -o '[0-9a-f]\{64\}' | head -1)"
local_sum="$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
if [[ "$remote_sum" != "$local_sum" ]]; then
  echo "The package arrived damaged (sha256 ${remote_sum:0:12} there, ${local_sum:0:12} here). Nothing was installed; run this again." >&2
  on_hub "rm -f /opt/relay/relay.tgz.new" >/dev/null
  exit 1
fi
on_hub "mv /opt/relay/relay.tgz.new /opt/relay/relay.tgz" >/dev/null
echo "arrived intact, sha256 ${local_sum:0:12}"

# ---------------------------------------------------------------------
if $upgrade; then
  step "Installing and restarting"
  on_hub "set -e; npm install -g --no-audit --no-fund /opt/relay/relay.tgz 2>&1 | tail -3; systemctl restart relay-hub; sleep 3; systemctl is-active relay-hub; curl -fsS http://127.0.0.1:8080/healthz" | hub_stdout
  echo "Runners pick the new version up the next time they start."
  exit 0
fi

step "Where the hub is reached"
if [[ "$expose" == funnel ]]; then
  dns="$(on_hub "tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty'" | hub_stdout | tr -d '[:space:]')"
  if [[ -z "$dns" ]]; then
    echo "$hub_vm is not on a tailnet. Add it with \`tailscale up\` on the VM, or use --expose public-ip." >&2
    exit 1
  fi
  public_url="https://${dns%.}"
else
  fqdn="$(az vm show -d -g "$hub_group" -n "$hub_vm" --query fqdns -o tsv)"
  if [[ -z "$fqdn" ]]; then
    echo "$hub_vm has no public DNS name. Give it a public IP with a DNS label, or use --expose funnel." >&2
    exit 1
  fi
  nsg="$(az network nic show --ids "$(az vm show -g "$hub_group" -n "$hub_vm" --query 'networkProfile.networkInterfaces[0].id' -o tsv)" --query 'networkSecurityGroup.id' -o tsv)"
  if [[ -n "$nsg" ]]; then
    az network nsg rule create --resource-group "$(cut -d/ -f5 <<<"$nsg")" --nsg-name "${nsg##*/}" --name https \
      --priority 1010 --direction Inbound --access Allow --protocol Tcp --destination-port-ranges 80 443 --only-show-errors -o none
  fi
  public_url="https://$fqdn"
fi
echo "$public_url"

# ---------------------------------------------------------------------
step "Installing the hub service"
first_studio="$(default_studio)"
safe "the default studio" "$first_studio" '^[A-Za-z0-9.:/,_-]+$'
[[ -n "$first_studio" ]] || { echo "Could not read TRUSTED_STUDIO_ORIGIN from src/studio/protocol.ts; pass --studio." >&2; exit 1; }
setup=$(cat <<SCRIPT
set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  # NodeSource's apt repository, checked against its signing key; nothing downloaded is piped to a shell.
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL -o /tmp/nodesource.key https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg /tmp/nodesource.key
  rm -f /tmp/nodesource.key
  echo "deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodejs
  apt-get update >/dev/null
  apt-get install -y nodejs >/dev/null
fi
command -v jq >/dev/null || apt-get install -y jq >/dev/null
npm install -g --no-audit --no-fund /opt/relay/relay.tgz >/dev/null 2>&1
id relay-hub >/dev/null 2>&1 || useradd --system --home-dir /var/lib/relay-hub --create-home --shell /usr/sbin/nologin relay-hub
install -d -m 0750 -o root -g relay-hub /etc/relay
# Secrets are made here, once, and never leave the VM. Runner tokens are signed with the first.
[ -s /etc/relay/hub-secret ] || { openssl rand -base64 48 | tr -d '\n' > /etc/relay/hub-secret; }
[ -s /etc/relay/admin-token ] || { openssl rand -base64 32 | tr -d '\n/+=' > /etc/relay/admin-token; }
[ -s /etc/relay/runner-ssh ] || ssh-keygen -q -t ed25519 -N '' -C relay-runners -f /etc/relay/runner-ssh
chown relay-hub:relay-hub /etc/relay/hub-secret /etc/relay/admin-token
chmod 0400 /etc/relay/hub-secret /etc/relay/admin-token /etc/relay/runner-ssh

# BEGIN settings
# A setting this run was not given keeps the value the last deploy wrote. Running this
# again to ship new code, or to change one setting, must never quietly reset another:
# it used to empty the allow-list, which locked everyone out of their machines.
env_file=/etc/relay/hub.env
kept() { [ -f "\$env_file" ] && sed -n "s/^\$1=//p" "\$env_file" | tail -n 1 || true; }
setting() { if [ -n "\$2" ]; then printf '%s' "\$2"; else kept "\$1"; fi; }
studios="\$(setting RELAY_HUB_STUDIO_ORIGINS '$studios')"
[ -n "\$studios" ] || studios='$first_studio'
if [ '$allow_given' = yes ]; then allowed='$allow'; else allowed="\$(kept RELAY_CLOUD_ALLOWED_USERS)"; fi
max_machines="\$(setting RELAY_CLOUD_MAX_MACHINES '$max_machines')"
idle_minutes="\$(setting RELAY_CLOUD_IDLE_MINUTES '$idle_minutes')"
claude_code="\$(setting RELAY_CLOUD_CLAUDE_CODE_VERSION '$claude_code_version')"
codex="\$(setting RELAY_CLOUD_CODEX_VERSION '$codex_version')"
ssh_key="\$(cat /etc/relay/runner-ssh.pub)"
{
  cat <<ENV
RELAY_HUB_SECRET_FILE=/etc/relay/hub-secret
RELAY_HUB_SECRET_PREVIOUS_FILE=/etc/relay/hub-secret.previous
RELAY_HUB_ADMIN_TOKEN_FILE=/etc/relay/admin-token
RELAY_HUB_HOST=127.0.0.1
RELAY_HUB_PORT=8080
RELAY_HUB_PUBLIC_URL=$public_url
RELAY_HUB_STUDIO_ORIGINS=\$studios
RELAY_HUB_TARBALL=/opt/relay/relay.tgz
CLERK_PUBLISHABLE_KEY=$clerk_key
AZURE_SUBSCRIPTION_ID=$subscription
RELAY_CLOUD_RESOURCE_GROUP=$group
RELAY_CLOUD_REGIONS=$regions
RELAY_CLOUD_VM_SIZE=$runner_size
RELAY_CLOUD_SSH_KEY=\$ssh_key
RELAY_CLOUD_ALLOWED_USERS=\$allowed
HOME=/var/lib/relay-hub
RELAY_HOME=/var/lib/relay-hub
ENV
  # Left out when never set, so the hub's own defaults apply and there is one of each.
  [ -z "\$max_machines" ] || echo "RELAY_CLOUD_MAX_MACHINES=\$max_machines"
  [ -z "\$idle_minutes" ] || echo "RELAY_CLOUD_IDLE_MINUTES=\$idle_minutes"
  [ -z "\$claude_code" ] || echo "RELAY_CLOUD_CLAUDE_CODE_VERSION=\$claude_code"
  [ -z "\$codex" ] || echo "RELAY_CLOUD_CODEX_VERSION=\$codex"
} > "\$env_file.new"
mv "\$env_file.new" "\$env_file"
echo "who may have a machine: \${allowed:-nobody}"
# END settings

chmod 0640 /etc/relay/hub.env
chgrp relay-hub /etc/relay/hub.env
cat > /etc/systemd/system/relay-hub.service <<UNIT
[Unit]
Description=Relay Cloud hub
Wants=network-online.target
After=network-online.target

[Service]
User=relay-hub
EnvironmentFile=/etc/relay/hub.env
ExecStart=/usr/bin/env relay hub serve --json
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/relay-hub

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable relay-hub >/dev/null 2>&1
systemctl restart relay-hub
sleep 3
systemctl is-active relay-hub
curl -fsS http://127.0.0.1:8080/healthz
SCRIPT
)
on_hub "$setup" | hub_stdout

if [[ "$expose" == funnel ]]; then
  on_hub "tailscale funnel --bg --https=443 http://127.0.0.1:8080 >/dev/null 2>&1 || tailscale funnel --bg 8080 >/dev/null; tailscale funnel status" | hub_stdout
else
  caddy=$(cat <<SCRIPT
set -e
command -v caddy >/dev/null || apt-get install -y caddy >/dev/null
cat > /etc/caddy/Caddyfile <<CADDY
${public_url#https://} {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
CADDY
systemctl reload caddy || systemctl restart caddy
SCRIPT
)
  on_hub "$caddy" >/dev/null
fi

# ---------------------------------------------------------------------
step "Checking it from here"
for attempt in 1 2 3 4 5 6; do
  if curl -fsS -m 10 "$public_url/healthz"; then echo; break; fi
  (( attempt == 6 )) && { echo "The hub is running on the VM but $public_url does not answer yet. Give DNS and the certificate a minute." >&2; }
  sleep 10
done

if [[ "$allow_given" == yes ]]; then
  who="${allow:-nobody}"
else
  who="as it was (see \"who may have a machine\" above)"
fi
cat <<EOF

The hub is at $public_url

  Studio:       set RELAY_CLOUD_HUB_URL=$public_url on the studio's deployment, and redeploy it.
  Who may use:  $who. Change it with --allow '*', --allow user_a,user_b or --allow none.
  Admin token:  scripts/azure/deploy-hub.sh ${vm:+--vm $vm }--print-admin-token
  Logs:         az vm run-command invoke -g $hub_group -n $hub_vm --command-id RunShellScript --scripts 'journalctl -u relay-hub -n 100 --no-pager'
  Upgrade:      scripts/azure/deploy-hub.sh ${vm:+--vm $vm }--upgrade
EOF
