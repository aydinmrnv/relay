/**
 * The cloud-init a new runner machine boots with.
 *
 * It installs what `scripts/azure/runner-cloud-init.yaml` installs on a
 * development runner — Node 22, gh, bubblewrap with its AppArmor profile,
 * Claude Code and Codex — and then makes the machine a runner: Relay itself,
 * downloaded from the hub so the two are always the same version, and a
 * system service that runs `relay connect --hub` as the unprivileged `relay`
 * user and comes back whenever it stops.
 *
 * Before every start the service checks the hub's Relay version and updates
 * to it, and refreshes the coding CLIs once a week — machines sleep most of
 * the time, so "at boot" is when updates can happen without interrupting a
 * run. A failed update never stops the runner from starting.
 *
 * Keep it ASCII: Azure passes custom data through Latin-1.
 */

export interface RunnerCloudInitOptions {
  hubUrl: string;
  /** Runs at once on the machine; 1 GiB of memory fits one. */
  maxRuns: number;
  adminUser: string;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${pad}${line}`))
    .join('\n');
}

export function runnerCloudInit(options: RunnerCloudInitOptions): string {
  const hub = options.hubUrl.replace(/\/+$/, '');
  if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+(\/[A-Za-z0-9._~/-]*)?$/.test(hub)) throw new Error(`"${hub}" is not a hub address cloud-init can carry.`);
  const user = options.adminUser;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error(`"${user}" is not a user name.`);
  const maxRuns = Math.max(1, Math.min(8, Math.floor(options.maxRuns)));

  const prepare = `#!/bin/bash
# Makes this machine a runner, and keeps it one. Runs as root before every
# start of the runner service: installs whatever is missing (so a first boot
# that failed half way repairs itself on the next), brings Relay to the hub's
# version, and refreshes the coding CLIs once a week. It never fails the start.
set -u
hub="${hub}"
log() { echo "relay-runner-prepare: $*"; }
retry() { local n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && return 1; sleep $((n*15)); done; }
export DEBIAN_FRONTEND=noninteractive

if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  log "installing Node 22"
  retry bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -' && retry apt-get install -y nodejs
fi
if ! command -v gh >/dev/null; then
  log "installing gh"
  install -d -m 0755 /etc/apt/keyrings
  retry curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  retry apt-get update && retry apt-get install -y gh
fi
stamp=/var/lib/relay-runner/clis-updated
if ! command -v claude >/dev/null || ! command -v codex >/dev/null || [ ! -f "$stamp" ] || [ -n "$(find "$stamp" -mtime +6 2>/dev/null)" ]; then
  log "installing or updating Claude Code and Codex"
  retry timeout 900 npm install -g --no-audit --no-fund @anthropic-ai/claude-code@latest @openai/codex@latest && date -u +%FT%TZ > "$stamp" || log "CLI install failed; keeping what is there"
fi

# The hub names its package by version and content hash; the last one installed is kept here.
installed=/var/lib/relay-runner/relay-version
want="$(curl -fsSI -m 20 "$hub/runner/relay.tgz" | tr -d '\\r' | awk -F': ' 'tolower($1)=="x-relay-version"{print $2}')"
have="$(cat "$installed" 2>/dev/null || true)"
if [ -n "$want" ] && { [ "$want" != "$have" ] || ! command -v relay >/dev/null; }; then
  log "Relay \${have:-none} -> $want, from the hub"
  tmp="$(mktemp -d)"
  retry curl -fsS -m 300 -o "$tmp/relay.tgz" "$hub/runner/relay.tgz" && npm install -g --no-audit --no-fund "$tmp/relay.tgz" && echo "$want" > "$installed" || log "could not install Relay $want"
  rm -rf "$tmp"
elif ! command -v relay >/dev/null; then
  log "the hub serves no Relay; building it from GitHub"
  rm -rf /opt/relay-src
  retry git clone --depth 1 https://github.com/aydinmrnv/relay /opt/relay-src \\
    && (cd /opt/relay-src && npm ci --no-audit --no-fund && npm pack --pack-destination /tmp) \\
    && npm install -g --no-audit --no-fund /tmp/relay-orchestrator-*.tgz || log "could not build Relay"
fi
exit 0
`;

  const service = `[Unit]
Description=Relay runner (dials out to the Relay Cloud hub)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${user}
Environment=DISABLE_AUTOUPDATER=1
Environment=RELAY_RUNNER_MAX_RUNS=${maxRuns}
ExecStartPre=+/usr/local/bin/relay-runner-prepare
ExecStart=/usr/bin/env relay connect --hub ${hub} --token-from azure
Restart=always
RestartSec=5
# Runs are children of the runner: stopping it asks them to stop cleanly first.
KillSignal=SIGTERM
TimeoutStopSec=90
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
`;

  const apparmor = `abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
`;

  return `#cloud-config
# A Relay Cloud runner. Made by the hub; see src/cloud/hub/cloudInit.ts.
package_update: true
package_upgrade: false

swap:
  filename: /swapfile
  size: 4G
  maxsize: 4G

packages:
  - bubblewrap
  - build-essential
  - ca-certificates
  - curl
  - git
  - gnupg
  - jq

write_files:
  - path: /etc/profile.d/relay-runner.sh
    permissions: '0644'
    content: |
      export DISABLE_AUTOUPDATER=1
  - path: /etc/apparmor.d/bwrap
    permissions: '0644'
    content: |
${indent(apparmor, 6)}
  - path: /usr/local/bin/relay-runner-prepare
    permissions: '0755'
    content: |
${indent(prepare, 6)}
  - path: /etc/systemd/system/relay-runner.service
    permissions: '0644'
    content: |
${indent(service, 6)}

runcmd:
  - install -d -m 0755 /var/lib/relay-runner
  - apparmor_parser -r /etc/apparmor.d/bwrap || true
  - systemctl daemon-reload
  # The service's own ExecStartPre installs everything, so a restart finishes a first boot that failed.
  - systemctl enable relay-runner.service
  - systemctl start --no-block relay-runner.service
  - date -u +%FT%TZ > /var/lib/relay-runner/ready
`;
}
