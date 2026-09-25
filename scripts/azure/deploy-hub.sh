#!/usr/bin/env bash
#
# Deploy the Relay Cloud hub on Azure, and everything the runner machines it
# makes need. Safe to run again: it updates what is there and keeps the hub's
# secrets, so runners already made keep their tokens.
#
#   scripts/azure/deploy-hub.sh --vm relay-dev/relay-runner --allow user_2abc   # on a VM you have, via Tailscale Funnel
#   scripts/azure/deploy-hub.sh --expose public-ip --allow '*'                  # a new hub VM with its own address
#   scripts/azure/deploy-hub.sh --vm relay-dev/relay-runner --upgrade           # new Relay code only
#   scripts/azure/deploy-hub.sh --vm relay-dev/relay-runner --print-admin-token
#
# What it makes:
#
#   relay-cloud                  a resource group for the runners (their VMs, disks and NICs)
#   relay-runners-<region>       one virtual network per runner region, whose subnet keeps
#                                Azure's default outbound access: the runners' only way out,
#                                free, and no way in
#   the hub                      `relay hub serve` as a system service, on a new
#                                Standard_B2pts_v2 (free for 12 months on Azure for Students)
#                                or on --vm. Its managed identity gets Contributor on
#                                relay-cloud and nothing else, so no Azure secret exists.
#
# How browsers and runners reach the hub (--expose):
#
#   funnel      Tailscale Funnel: https://<vm>.<tailnet>.ts.net, free, no public IP. The VM
#               must be on your tailnet with Funnel allowed (the default).
#   public-ip   a static public IP with an Azure DNS name, and Caddy with a Let's Encrypt
#               certificate. About $3.65/month for the address.
#
# Afterwards, set RELAY_CLOUD_HUB_URL on the studio's deployment (Vercel) to the URL
# this prints, and redeploy it.

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
studios="https://relay-olive-omega.vercel.app,http://localhost:3000"
clerk_key="${CLERK_PUBLISHABLE_KEY:-}"
allow=""
max_machines="10"
idle_minutes="10"
upgrade=false
print_admin=false

usage() {
  sed -n '3,33p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --vm <group>/<name>          install on this existing Linux VM instead of making one
  --location <region>          where a new hub VM goes (default: $location)
  --regions <a,b,...>          regions runners are made in (default: $regions)
  --group <name>               the runners' resource group (default: $group)
  --expose funnel|public-ip    how the hub is reached (default: $expose)
  --studio <origins>           comma-separated studio origins (default: $studios)
  --clerk-publishable-key <pk> the studio's Clerk key (default: \$CLERK_PUBLISHABLE_KEY)
  --allow <'*'|ids>            who may have a machine: '*' or Clerk user ids (default: nobody yet)
  --max-machines <n>           machines the hub will ever make (default: $max_machines)
  --idle-minutes <n>           minutes idle before a machine is put to sleep (default: $idle_minutes)
  --runner-size <sku>          runner VM size (default: $runner_size)
  --upgrade                    only ship this checkout's Relay to the hub and restart it
  --print-admin-token          print the token for the hub's /admin routes, and stop
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
    --allow) allow="$2"; shift 2 ;;
    --max-machines) max_machines="$2"; shift 2 ;;
    --idle-minutes) idle_minutes="$2"; shift 2 ;;
    --runner-size) runner_size="$2"; shift 2 ;;
    --upgrade) upgrade=true; shift ;;
    --print-admin-token) print_admin=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$expose" in funnel|public-ip) ;; *) echo "--expose is funnel or public-ip." >&2; exit 2 ;; esac

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

if $print_admin; then
  on_hub "cat /etc/relay/admin-token" | sed -n '/\[stdout\]/,/\[stderr\]/p' | sed '1d;$d' | tr -d '[:space:]'
  echo
  exit 0
fi

subscription="$(az account show --query id -o tsv)"
group_id="/subscriptions/$subscription/resourceGroups/$group"

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

  step "The hub's identity: Contributor on $group, nothing else"
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
  on_hub "set -e; npm install -g --no-audit --no-fund /opt/relay/relay.tgz 2>&1 | tail -3; systemctl restart relay-hub; sleep 3; systemctl is-active relay-hub; curl -fsS http://127.0.0.1:8080/healthz" | sed -n '/\[stdout\]/,/\[stderr\]/p' | sed '1d;$d'
  echo "Runners pick the new version up the next time they start."
  exit 0
fi

step "Where the hub is reached"
if [[ "$expose" == funnel ]]; then
  dns="$(on_hub "tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty'" | sed -n '/\[stdout\]/,/\[stderr\]/p' | sed '1d;$d' | tr -d '[:space:]')"
  if [[ -z "$dns" ]]; then
    echo "$hub_vm is not on a tailnet. Add it (scripts/azure/create-runner.sh shows how), or use --expose public-ip." >&2
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
allowed="${allow:-}"
setup=$(cat <<SCRIPT
set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
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
cat > /etc/relay/hub.env <<ENV
RELAY_HUB_SECRET_FILE=/etc/relay/hub-secret
RELAY_HUB_ADMIN_TOKEN_FILE=/etc/relay/admin-token
RELAY_HUB_HOST=127.0.0.1
RELAY_HUB_PORT=8080
RELAY_HUB_PUBLIC_URL=$public_url
RELAY_HUB_STUDIO_ORIGINS=$studios
RELAY_HUB_TARBALL=/opt/relay/relay.tgz
CLERK_PUBLISHABLE_KEY=$clerk_key
AZURE_SUBSCRIPTION_ID=$subscription
RELAY_CLOUD_RESOURCE_GROUP=$group
RELAY_CLOUD_REGIONS=$regions
RELAY_CLOUD_VM_SIZE=$runner_size
RELAY_CLOUD_SSH_KEY=\$(cat /etc/relay/runner-ssh.pub)
RELAY_CLOUD_ALLOWED_USERS=$allowed
RELAY_CLOUD_MAX_MACHINES=$max_machines
RELAY_CLOUD_IDLE_MINUTES=$idle_minutes
HOME=/var/lib/relay-hub
RELAY_HOME=/var/lib/relay-hub
ENV
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
on_hub "$setup" | sed -n '/\[stdout\]/,/\[stderr\]/p' | sed '1d;$d'

if [[ "$expose" == funnel ]]; then
  on_hub "tailscale funnel --bg --https=443 http://127.0.0.1:8080 >/dev/null 2>&1 || tailscale funnel --bg 8080 >/dev/null; tailscale funnel status" | sed -n '/\[stdout\]/,/\[stderr\]/p' | sed '1d;$d'
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

cat <<EOF

The hub is at $public_url

  Studio:       set RELAY_CLOUD_HUB_URL=$public_url on the studio's deployment, and redeploy it.
  Who may use:  ${allow:-nobody yet} (re-run with --allow '*' or --allow user_a,user_b to change it)
  Admin token:  scripts/azure/deploy-hub.sh ${vm:+--vm $vm }--print-admin-token
  Logs:         az vm run-command invoke -g $hub_group -n $hub_vm --command-id RunShellScript --scripts 'journalctl -u relay-hub -n 100 --no-pager'
  Upgrade:      scripts/azure/deploy-hub.sh ${vm:+--vm $vm }--upgrade
EOF
