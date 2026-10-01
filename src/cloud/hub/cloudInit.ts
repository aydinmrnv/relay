/**
 * The cloud-init a new runner machine boots with.
 *
 * It installs what `scripts/azure/runner-cloud-init.yaml` installs on a
 * development runner — Node 22, gh, bubblewrap with its AppArmor profile,
 * Claude Code and Codex — and then makes the machine a runner: Relay itself,
 * downloaded from the hub so the two are always the same version, and a
 * system service that runs `relay connect --hub` and comes back whenever it
 * stops.
 *
 * Before every start the service checks the hub's Relay version and updates
 * to it, and refreshes the coding CLIs once a week — machines sleep most of
 * the time, so "at boot" is when updates can happen without interrupting a
 * run. A failed update never stops the runner from starting.
 *
 * **Who runs what.** Two users matter on a runner machine:
 *
 *   - the VM's admin user, which Azure creates and which can `sudo` without a
 *     password. Nothing of Relay's runs as it.
 *   - `relay-run`, made here, with no `sudo` and no group that matters. The
 *     runner, the coding CLIs and everything an agent writes run as it, and
 *     its home holds the person's sign-ins.
 *
 * The service starts as root, for the three things only root may do —
 * install, close the instance metadata service, read the runner token — and
 * becomes `relay-run` before a line of Relay runs.
 *
 * **The runner token and the metadata service.** The token is in the VM's
 * user data, and Azure's instance metadata service (169.254.169.254) hands
 * user data to any process on the machine that asks. An agent is a process
 * on the machine. So a firewall rule lets only root reach that address, the
 * start step refuses to go on unless the rule is there, and the token then
 * goes to the runner down a pipe: never in a file, an environment variable
 * or a command line that `relay-run` could read. Core dumps are off and
 * ptrace is restricted to a process's own descendants, so an agent cannot
 * read it out of the runner's memory either. What this does not do is make
 * an agent unable to act as the runner in other ways: both are `relay-run`.
 *
 * NOT VERIFIED ON AZURE. The user, the firewall rule and the pipe were added
 * after the last machine was made for real. The unit tests check the text
 * this file produces and that the shell in it parses; they cannot check that
 * a machine boots with it. Make one machine and watch it connect before
 * relying on any of it (`journalctl -u relay-runner` on the machine).
 *
 * Keep it ASCII: Azure passes custom data through Latin-1.
 */

export interface RunnerCloudInitOptions {
  hubUrl: string;
  /** Runs at once on the machine; 1 GiB of memory fits one. */
  maxRuns: number;
  /** The VM's admin user, which Azure makes. Only named here so the runner's user is never the same one. */
  adminUser: string;
  /** The user the runner and the agents run as. No sudo. */
  runUser?: string;
}

/** The unprivileged user a managed runner and its agents run as. */
export const RUN_USER = 'relay-run';

const METADATA_ADDRESS = '169.254.169.254';

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${pad}${line}`))
    .join('\n');
}

/** The shell scripts and the unit a runner machine gets, before they are folded into cloud-config. Exported for the tests. */
export function runnerFiles(options: RunnerCloudInitOptions): { prepare: string; start: string; service: string } {
  const hub = options.hubUrl.replace(/\/+$/, '');
  if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+(\/[A-Za-z0-9._~/-]*)?$/.test(hub)) throw new Error(`"${hub}" is not a hub address cloud-init can carry.`);
  const user = options.runUser ?? RUN_USER;
  for (const name of [user, options.adminUser]) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`"${name}" is not a user name.`);
  }
  if (user === options.adminUser || user === 'root') throw new Error(`The runner cannot run as "${user}": that user can become root, and the agents would be able to with it.`);
  const maxRuns = Math.max(1, Math.min(8, Math.floor(options.maxRuns)));

  // The rule, spelled once: the check and the insert must name the same thing.
  const rule = `OUTPUT -d ${METADATA_ADDRESS} -m owner ! --uid-owner 0 -j REJECT`;

  const prepare = `#!/bin/bash
# Makes this machine a runner, and keeps it one. Runs as root before every
# start of the runner service: installs whatever is missing (so a first boot
# that failed half way repairs itself on the next), brings Relay to the hub's
# version, and refreshes the coding CLIs once a week. The installs never fail
# the start. The two steps that keep the runner's token from the agents do.
set -u
hub="${hub}"
run_user="${user}"
log() { echo "relay-runner-prepare: $*"; }
retry() { local n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && return 1; sleep $((n*15)); done; }
export DEBIAN_FRONTEND=noninteractive

# Only root may ask the instance metadata service anything. It hands this
# machine's user data, which is the runner token, to whoever asks; an agent
# that could ask could connect to the hub as this machine from anywhere.
# First, before anything is installed, and checked again by the start step.
command -v iptables >/dev/null || retry apt-get install -y iptables
iptables -C ${rule} 2>/dev/null || iptables -I ${rule}
if ! iptables -C ${rule} 2>/dev/null; then
  log "could not close the instance metadata service to everyone but root; not starting"
  exit 1
fi

# The user the runner and the agents run as: no sudo, no password, no extra groups.
if ! id -u "$run_user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$run_user" || { log "could not make the user $run_user; not starting"; exit 1; }
fi
passwd -l "$run_user" >/dev/null 2>&1 || true
if id -nG "$run_user" | tr ' ' '\\n' | grep -Eqx 'sudo|admin|wheel|adm|docker|lxd'; then
  log "$run_user is in a group that leads to root; not starting"
  exit 1
fi

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

  const start = `#!/bin/bash
# Starts the runner as ${user}, handing it its token on the way down.
# Root reads the token; ${user} never can, and so neither can an agent.
set -u
hub="${hub}"
run_user="${user}"
log() { echo "relay-runner-start: $*"; }

# Not read unless nobody but root can read it: see relay-runner-prepare.
if ! iptables -C ${rule} 2>/dev/null; then
  log "the instance metadata service is not closed to other users; not starting"
  exit 1
fi
home="$(getent passwd "$run_user" | cut -d: -f6)"
[ -n "$home" ] && [ -d "$home" ] || { log "$run_user has no home; not starting"; exit 1; }

token=""
for attempt in 1 2 3 4 5 6; do
  token="$(curl -fsS -m 10 -H 'Metadata: true' 'http://${METADATA_ADDRESS}/metadata/instance/compute/userData?api-version=2021-01-01&format=text' | base64 -d 2>/dev/null)" || token=""
  [ -n "$token" ] && break
  sleep 5
done
[ -n "$token" ] || { log "this machine has no runner token in its user data; not starting"; exit 1; }

# No core file may hold the runner's memory, and so its token.
ulimit -c 0
cd "$home" || exit 1
# A clean environment, the unprivileged user, and the token on standard input:
# through a pipe, so it is never in a file, a variable a child inherits, or ps.
exec env -i HOME="$home" USER="$run_user" LOGNAME="$run_user" SHELL=/bin/bash LANG=C.UTF-8 \\
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
  DISABLE_AUTOUPDATER=1 RELAY_RUNNER_MAX_RUNS=${maxRuns} \\
  setpriv --reuid "$run_user" --regid "$run_user" --init-groups \\
  relay connect --hub "$hub" --token-from stdin < <(printf '%s' "$token")
`;

  const service = `[Unit]
Description=Relay runner (dials out to the Relay Cloud hub)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
# Both steps start as root; relay-runner-start becomes ${user} before it runs Relay.
ExecStartPre=/usr/local/bin/relay-runner-prepare
ExecStart=/usr/local/bin/relay-runner-start
Restart=always
RestartSec=5
LimitCORE=0
# Runs are children of the runner: stopping it asks them to stop cleanly first.
KillSignal=SIGTERM
TimeoutStopSec=90
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
`;

  return { prepare, start, service };
}

export function runnerCloudInit(options: RunnerCloudInitOptions): string {
  const { prepare, start, service } = runnerFiles(options);
  const user = options.runUser ?? RUN_USER;

  const apparmor = `abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
`;

  // Ubuntu's defaults, stated rather than assumed: they are part of what keeps
  // the runner's token from the agents that share its user.
  const sysctl = `# A process may be traced only by its own ancestors, so an agent cannot attach to the runner that started it.
kernel.yama.ptrace_scope = 1
fs.suid_dumpable = 0
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
  - iptables
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
  - path: /etc/sysctl.d/60-relay-runner.conf
    permissions: '0644'
    content: |
${indent(sysctl, 6)}
  # Only root schedules anything: a job ${user} could leave behind would run outside the runner service.
  - path: /etc/cron.allow
    permissions: '0644'
    content: |
      root
  - path: /etc/at.allow
    permissions: '0644'
    content: |
      root
  - path: /usr/local/bin/relay-runner-prepare
    permissions: '0755'
    content: |
${indent(prepare, 6)}
  - path: /usr/local/bin/relay-runner-start
    permissions: '0755'
    content: |
${indent(start, 6)}
  - path: /etc/systemd/system/relay-runner.service
    permissions: '0644'
    content: |
${indent(service, 6)}

runcmd:
  - install -d -m 0755 /var/lib/relay-runner
  - apparmor_parser -r /etc/apparmor.d/bwrap || true
  - sysctl -p /etc/sysctl.d/60-relay-runner.conf || true
  # Crash reports would hold a copy of a crashed process's memory where its own user can read it.
  - systemctl disable --now apport.service || true
  - systemctl daemon-reload
  # The service's own ExecStartPre installs everything, so a restart finishes a first boot that failed.
  - systemctl enable relay-runner.service
  - systemctl start --no-block relay-runner.service
  - date -u +%FT%TZ > /var/lib/relay-runner/ready
`;
}
