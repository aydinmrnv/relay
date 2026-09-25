#!/usr/bin/env bash
#
# Create a Relay runner VM on Azure: Ubuntu 24.04 with the coding CLIs installed
# by runner-cloud-init.yaml, and no inbound port open to the internet.
#
#   scripts/azure/create-runner.sh --location northcentralus
#   scripts/azure/create-runner.sh --location northcentralus --public-ip   # SSH over the internet instead
#   scripts/azure/create-runner.sh --refresh-ip                             # --public-ip only: your IP changed
#
# By default the VM has no public IP address and you reach it over Tailscale
# (free for personal use): the VM dials out, your Mac joins the same tailnet,
# and `ssh relay@<name>` works from anywhere. A Standard public IPv4 address is
# the one thing the Azure for Students free tier does not cover (about
# $3.65/month); --public-ip adds one, with SSH open to your current address.
#
# Safe to run again: an existing resource group, network or VM is reused.
#
# Day to day:
#   az vm deallocate -g relay-dev -n relay-runner      # stop paying for compute
#   az vm start      -g relay-dev -n relay-runner
#   az group delete  -n relay-dev                      # remove everything
#
# Defaults suit an Azure for Students subscription: Standard_B2ats_v2 with a
# 64 GiB P6 disk is inside its 750 free hours a month for the first 12 months.
# Students may deploy to five regions only; run without --location to list them.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

group="relay-dev"
name="relay-runner"
location=""
size="Standard_B2ats_v2"
admin="relay"
ssh_key="$HOME/.ssh/relay_azure.pub"
public_ip=false
refresh_ip=false

usage() {
  sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --location <region>   Azure region (required when creating)
  --group <name>        resource group (default: $group)
  --name <name>         VM name, also its Tailscale name (default: $name)
  --size <sku>          VM size (default: $size)
  --admin <user>        admin user; the companion runs as this user (default: $admin)
  --ssh-key <path>      public key to install (default: $ssh_key)
  --public-ip           give the VM a public IPv4 address and open SSH to your IP
  --refresh-ip          re-point the SSH rule at your current IP (--public-ip VMs)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --location) location="$2"; shift 2 ;;
    --group) group="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    --size) size="$2"; shift 2 ;;
    --admin) admin="$2"; shift 2 ;;
    --ssh-key) ssh_key="$2"; shift 2 ;;
    --public-ip) public_ip=true; shift ;;
    --refresh-ip) refresh_ip=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

nsg="${name}-nsg"
vnet="${name}-vnet"
subnet="default"

# Runs a script on the VM through the Azure agent, which needs no inbound port.
on_vm() {
  az vm run-command invoke --resource-group "$group" --name "$name" \
    --command-id RunShellScript --scripts "$1" \
    --query "value[0].message" -o tsv --only-show-errors
}

# Every public IPv4 address this machine leaves from. Behind carrier-grade NAT
# (a phone hotspot, some ISPs) web requests and SSH can exit from different
# addresses, so ask over both the IPv4 and the IPv6 path and keep each answer.
my_ips() {
  {
    curl -4 -fsS -m 5 https://api.ipify.org || true
    echo
    curl -6 -fsS -m 5 https://api64.ipify.org || true
    echo
  } | grep -E '^[0-9]+(\.[0-9]+){3}$' | sort -u
}

allow_ssh_from_my_ip() {
  local ips prefixes=()
  ips="$(my_ips)"
  if [[ -z "$ips" ]]; then
    echo "Could not work out your public IP address; SSH rule left as it is." >&2
    return 1
  fi
  while read -r ip; do prefixes+=("${ip}/32"); done <<<"$ips"
  az network nsg rule create \
    --resource-group "$group" --nsg-name "$nsg" --name ssh-from-admin \
    --priority 1000 --direction Inbound --access Allow --protocol Tcp \
    --source-address-prefixes "${prefixes[@]}" --destination-port-ranges 22 \
    --only-show-errors -o none
  echo "SSH is open to ${prefixes[*]} only. If it stops answering, your address changed: run with --refresh-ip."
}

if $refresh_ip; then
  allow_ssh_from_my_ip
  exit 0
fi

if [[ -z "$location" ]]; then
  echo "--location is required. Your subscription's allowed regions:" >&2
  az policy assignment list --query "[].parameters.listOfAllowedLocations.value" -o tsv 2>/dev/null | tr '\t' '\n' | sort -u >&2 || true
  exit 2
fi

if [[ ! -f "$ssh_key" ]]; then
  echo "No public key at $ssh_key. Create one: ssh-keygen -t ed25519 -f ${ssh_key%.pub} -N \"\"" >&2
  exit 1
fi

az group create --name "$group" --location "$location" --only-show-errors -o none

if az vm show --resource-group "$group" --name "$name" --only-show-errors -o none 2>/dev/null; then
  echo "VM $name already exists in $group; leaving it as it is."
else
  # The network is made here rather than by `az vm create` so the subnet can
  # keep default outbound access: with no public IP that is the VM's only way
  # out to npm, GitHub, the model vendors and Tailscale, and unlike a NAT
  # gateway it is free.
  if ! az network vnet show --resource-group "$group" --name "$vnet" --only-show-errors -o none 2>/dev/null; then
    az network vnet create --resource-group "$group" --name "$vnet" --location "$location" \
      --address-prefixes 10.0.0.0/16 --subnet-name "$subnet" --subnet-prefixes 10.0.0.0/24 \
      --only-show-errors -o none
  fi
  az network vnet subnet update --resource-group "$group" --vnet-name "$vnet" --name "$subnet" \
    --default-outbound true --only-show-errors -o none

  address=(--public-ip-address "")
  if $public_ip; then
    # A DNS label gives the VM a stable name (<label>.<region>.cloudapp.azure.com).
    # Unique per region, so derive it from the subscription.
    label="${name}-$(az account show --query id -o tsv | cut -c1-8)"
    address=(--public-ip-sku Standard --public-ip-address-dns-name "$label")
  fi
  az vm create \
    --resource-group "$group" --name "$name" --location "$location" \
    --image Ubuntu2404 --size "$size" \
    --admin-username "$admin" --ssh-key-values "$ssh_key" \
    --storage-sku Premium_LRS --os-disk-size-gb 64 \
    --vnet-name "$vnet" --subnet "$subnet" "${address[@]}" \
    --nsg "$nsg" --nsg-rule NONE \
    --custom-data "$here/runner-cloud-init.yaml" \
    --only-show-errors -o none
  echo "Created $name ($size) in $location."
fi

az vm show --show-details --resource-group "$group" --name "$name" \
  --query "{name:name, size:hardwareProfile.vmSize, location:location, state:powerState, ip:publicIps}" -o table

if $public_ip; then
  allow_ssh_from_my_ip
  ip="$(az vm show --show-details --resource-group "$group" --name "$name" --query publicIps -o tsv)"
  echo
  echo "Connect:  ssh -i ${ssh_key%.pub} ${admin}@${ip}"
  exit 0
fi

echo "Waiting for the VM to finish installing (a few minutes)..."
on_vm "cloud-init status --wait >/dev/null; cat /var/lib/relay-runner/ready" >/dev/null

# `tailscale up` waits for someone to approve the machine, so start it in the
# background and hand back the approval link it prints.
login="$(on_vm "tailscale status >/dev/null 2>&1 && echo signed-in && exit 0
rm -f /tmp/ts-up.log; (nohup tailscale up --hostname=$name >/tmp/ts-up.log 2>&1 &); sleep 8
grep -o 'https://login.tailscale.com/[^ ]*' /tmp/ts-up.log | head -1")"
login="$(grep -Eo 'signed-in|https://login\.tailscale\.com/[^[:space:]]+' <<<"$login" | head -1 || true)"

echo
if [[ "$login" == "signed-in" ]]; then
  echo "The VM is already on your tailnet."
elif [[ -n "$login" ]]; then
  echo "Add the VM to your tailnet: open $login"
else
  echo "Could not get a Tailscale login link. Start it by hand:"
  echo "  az vm run-command invoke -g $group -n $name --command-id RunShellScript --scripts 'tailscale up --hostname=$name'"
fi
echo "Then, with Tailscale on on this Mac:  ssh -i ${ssh_key%.pub} ${admin}@${name}"
