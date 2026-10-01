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
 * to it, and brings the coding CLIs to the versions the hub names — machines
 * sleep most of the time, so "at boot" is when updates can happen without
 * interrupting a run. A failed update never stops the runner from starting.
 *
 * **What it runs as root, and how much of it is pinned.** All of this runs
 * as root, on every start, so what it fetches matters:
 *
 *   - Relay comes from the hub and is installed only if its SHA-256 matches
 *     the one the hub states. There is no fallback to building from GitHub.
 *   - Node comes from NodeSource's apt repository, checked by apt against
 *     NodeSource's signing key. No script from the network is piped to a
 *     shell. The key itself is fetched over TLS and its fingerprint is not
 *     pinned here.
 *   - gh comes from GitHub's apt repository, the same way.
 *   - Claude Code and Codex are installed at the versions the hub is
 *     configured with (`RELAY_CLOUD_CLAUDE_CODE_VERSION`,
 *     `RELAY_CLOUD_CODEX_VERSION`), which it also states on every start, so
 *     changing a pin reaches machines that already exist. Left unset they are
 *     `latest`: whatever npm serves that week. npm checks a package against
 *     the registry's own integrity record; nothing here pins their
 *     dependencies or checks a hash of our own choosing.
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
  /** The npm versions of the coding CLIs to install when the hub does not say: an exact version, or a dist-tag such as `latest`. */
  claudeCodeVersion?: string;
  codexVersion?: string;
}

/** What may follow `@` in an npm install: a version or a dist-tag, and nothing a shell would read as more. */
export const NPM_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;

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
  const claudeCode = options.claudeCodeVersion ?? 'latest';
  const codex = options.codexVersion ?? 'latest';
  for (const version of [claudeCode, codex]) {
    if (!NPM_VERSION.test(version)) throw new Error(`"${version}" is not an npm version or tag.`);
  }

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

# What the hub says this machine should run, read once: its own Relay package
# (a version, and the SHA-256 of the file), and the versions of the coding CLIs.
headers="$(curl -fsSI -m 20 "$hub/runner/relay.tgz" | tr -d '\\r')"
header() { printf '%s\\n' "$headers" | awk -F': ' -v name="$1" 'tolower($1)==name{print $2}' | head -n 1; }
# A version or a tag, and nothing a shell or npm would read as more than that.
pin() { case "$1" in ''|*[!A-Za-z0-9.+-]*) return 1 ;; *) return 0 ;; esac; }

if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  log "installing Node 22"
  # NodeSource's apt repository, checked against its signing key: apt verifies
  # what it installs, and nothing downloaded is handed to a shell.
  install -d -m 0755 /etc/apt/keyrings
  retry curl -fsSL -o /tmp/nodesource.key https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \\
    && gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg /tmp/nodesource.key \\
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \\
    && printf 'Package: nodejs\\nPin: origin deb.nodesource.com\\nPin-Priority: 600\\n' > /etc/apt/preferences.d/nodejs \\
    && retry apt-get update && retry apt-get install -y nodejs || log "could not install Node 22"
  rm -f /tmp/nodesource.key
fi
if ! command -v gh >/dev/null; then
  log "installing gh"
  install -d -m 0755 /etc/apt/keyrings
  retry curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  retry apt-get update && retry apt-get install -y gh
fi

# The coding CLIs, at the versions the hub names now, or failing that the ones
# it named when this machine was made. A pinned version is installed once and
# left alone; "latest" is asked for again once a week.
claude_want="${claudeCode}"
codex_want="${codex}"
named="$(header x-relay-claude-code)"; pin "$named" && claude_want="$named"
named="$(header x-relay-codex)"; pin "$named" && codex_want="$named"
stamp=/var/lib/relay-runner/clis-installed
wanted="claude-code@$claude_want codex@$codex_want"
stale=""
case "$wanted" in *@latest*) [ -n "$(find "$stamp" -mtime +6 2>/dev/null)" ] && stale=yes ;; esac
if ! command -v claude >/dev/null || ! command -v codex >/dev/null || [ "$wanted" != "$(cat "$stamp" 2>/dev/null || true)" ] || [ -n "$stale" ]; then
  log "installing Claude Code $claude_want and Codex $codex_want"
  retry timeout 900 npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@$claude_want" "@openai/codex@$codex_want" && echo "$wanted" > "$stamp" || log "CLI install failed; keeping what is there"
fi

# Relay itself, from the hub, and only if the file is the one the hub says it
# is. The hub names its package by version and content hash; the last one
# installed is kept here.
installed=/var/lib/relay-runner/relay-version
want="$(header x-relay-version)"
sum="$(header x-relay-sha256)"
have="$(cat "$installed" 2>/dev/null || true)"
if [ -z "$want" ]; then
  log "the hub serves no Relay package; keeping what is installed"
elif [ "$want" != "$have" ] || ! command -v relay >/dev/null; then
  log "Relay \${have:-none} -> $want, from the hub"
  tmp="$(mktemp -d)"
  if retry curl -fsS -m 300 -o "$tmp/relay.tgz" "$hub/runner/relay.tgz"; then
    got="$(sha256sum "$tmp/relay.tgz" | cut -d' ' -f1)"
    if [ -n "$sum" ] && [ "$got" = "$sum" ]; then
      npm install -g --no-audit --no-fund "$tmp/relay.tgz" && echo "$want" > "$installed" || log "could not install Relay $want"
    else
      log "the Relay package is not the one the hub described (sha256 $got, expected \${sum:-none}); not installing it"
    fi
  else
    log "could not download Relay $want"
  fi
  rm -rf "$tmp"
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
command -v relay >/dev/null || { log "Relay is not installed: relay-runner-prepare could not get it from the hub; not starting"; exit 1; }

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
