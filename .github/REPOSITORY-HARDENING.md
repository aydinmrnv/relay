# Repository hardening

What this repository does to keep a public repository safe to leave alone, and
the settings that only an admin can switch on.

The split matters. Everything in the first section is committed here and takes
effect the moment it is merged. Everything in the second lives in GitHub's own
settings, which no file in a repository can set — including this one — so it is
written as a checklist to work through once. Tick it and the two halves agree.

Current state, for the record: `aydinmrnv` is the sole collaborator, with the
`admin` role. Nobody else has any permission on this repository. The point of
what follows is to keep that true and to make it matter.

---

## Part 1 — committed here

| File | What it does |
| --- | --- |
| `.github/CODEOWNERS` | Names `@aydinmrnv` as the owner of every path, and separately of the paths where a bad change is worst — CI, the Action, `package.json`, and the unattended guardrails. Enforced by the `require_code_owner_review` rule below. |
| `.github/workflows/ci.yml` | Declares `permissions: contents: read`, so the job token cannot write to the repository whatever the account-wide default becomes later. A `concurrency` group cancels superseded runs, so a push loop from a fork costs one run rather than a queue of them. |
| `.github/workflows/codeql.yml` | Code scanning on push, on pull requests, and weekly. `security-events: write` is granted to that one job and nowhere else. |
| `.github/dependabot.yml` | Weekly updates for npm and for the actions the workflows run. Both arrive as pull requests against the protected branch, so neither can merge itself. |
| `.github/rulesets/main.json` | The default-branch ruleset, ready to import. See below. |
| `.github/rulesets/tags.json` | The same for `v*` release tags: they cannot be deleted or moved. |
| `SECURITY.md` | Private reporting, and what counts as a vulnerability in a tool like this one. |

### Importing the rulesets

**Settings → Rules → Rulesets → New ruleset → Import a ruleset**, once per file.
Upload `.github/rulesets/main.json`, then `.github/rulesets/tags.json`.

What `main.json` enforces on the default branch:

- **No direct pushes.** Every change arrives as a pull request.
- **No force-push and no deletion.** History on `main` only moves forward.
- **Linear history.** Merge commits from a pull request are fine; a tangled push is not.
- **Code-owner review required.** Which is what makes `CODEOWNERS` real.
- **Stale reviews dismissed on push,** and approval required of the last push — so an approval cannot be collected and then quietly amended.
- **Conversations resolved** before merge.
- **CI green** before merge, against an up-to-date branch: `check (ubuntu-latest)`, `check (macos-latest)`, `check (windows-latest)`, and `unattended`.

Two deliberate choices worth knowing about, because both are one field away from
the opposite:

- `required_approving_review_count` is **0**, not 1. On a repository with one
  maintainer, requiring an approval means requiring an approval you are not
  allowed to give yourself, and the only way out is a bypass — which is a
  standing hole punched in the ruleset to work around a rule that was never
  achievable. Everything else still applies: a pull request, green CI, resolved
  conversations. **Raise it to 1 the day a second person gets write access,**
  and not before.
- `bypass_actors` is **empty**, so the rules apply to the owner too. That is the
  stricter reading and the right default: the protection you can step around
  without noticing is not protection. If you want an escape hatch for a broken
  `main`, add **Repository admin** as a bypass actor in the ruleset UI — but
  prefer setting the ruleset to **Evaluate** or **Disabled** for the minute you
  need it, because that leaves a record and turning it back on is a decision
  rather than something you forget you never made.

After importing, add `Analyze` to the required checks if you want CodeQL to
block a merge as well as report on one. Leave it out to start with: let it run
for a few weeks first, so you are blocking on a signal you have read.

---

## Part 2 — settings only an admin can change

Nothing in a repository can set these. Work through them once.

### Access — the "only I have permissions" part

- **Settings → Collaborators and teams** — confirm the list is you alone. It is,
  today. Anything that appears here later is somebody who can push.
- **Settings → Deploy keys** — should be empty. A deploy key with write access
  is a credential that survives a password change.
- **Settings → Webhooks** and **Integrations → GitHub Apps** — audit what is
  installed and what scope it holds. An app with `contents: write` is a
  collaborator that does not appear on the collaborators page.
- **Your account → Password and authentication** — 2FA on, with a recovery
  method stored somewhere that is not the laptop.
- **Your account → SSH and GPG keys** — enable **Vigilant mode** so unsigned
  commits attributed to you are flagged as `Unverified`. On a public repository
  anybody can push a commit claiming your name and email to their own fork.

### Actions — the part that runs strangers' code

**Settings → Actions → General.** This is the most important section on a public
repository, because `pull_request` builds code that came from a fork.

- **Fork pull request workflows from outside collaborators** →
  **Require approval for all external contributors.** The default only holds
  first-time contributors, so one merged typo fix buys somebody unreviewed CI
  runs forever.
- **Workflow permissions** → **Read repository contents and packages
  permissions.** `ci.yml` declares its own scope regardless; this closes the
  default for anything added later that forgets to.
- **Allow GitHub Actions to create and approve pull requests** → **off.** An
  Actions run that can approve a pull request defeats the review rule above.
- **Actions permissions** → allow actions by GitHub and by verified creators,
  rather than all actions. The workflows here use `actions/*` and
  `github/codeql-action/*`, both of which qualify.

### Code security

**Settings → Code security.** All of these are free on a public repository.

- **Private vulnerability reporting** → **Enable.** This is what the button in
  `SECURITY.md` points at; without it the link goes nowhere.
- **Dependency graph**, **Dependabot alerts**, **Dependabot security updates** →
  on. The alerts are the half that tells you; the updates are the half that
  opens the pull request.
- **Secret scanning** and **Push protection** → **Enable.** Push protection
  blocks a credential at `git push`, which is the one place Relay's own secret
  scan cannot help: it runs between commit and push for the changes Relay
  writes, not for the ones you write by hand.
- **Code scanning** — already configured by `codeql.yml` as advanced setup. Do
  not also enable default setup; they conflict.

### General

**Settings → General.**

- **Automatically delete head branches** → on. Relay opens a branch per run, and
  these accumulate.
- **Wikis** → off, unless you want one. A wiki is a second, unprotected place to
  publish from this repository's name.
- **Allow forking** → leave on. It is what makes the pull-request flow work, and
  a public repository is copyable regardless.
- **Moderation options → Interaction limits** — nothing to set now. Worth
  knowing it exists: it throttles issues and pull requests from new or non-
  contributing accounts for up to six months, and it is the right tool if this
  repository is ever brigaded.

### npm, if you publish `relay-orchestrator`

The package is a second distribution channel with its own permissions, and a
GitHub ruleset does not reach it.

- 2FA required for publishing, on the npm account.
- Prefer **trusted publishing** from a GitHub Actions workflow over a long-lived
  `NPM_TOKEN` in repository secrets. A token in secrets is a credential any
  workflow in the repository can be made to read.
- If a token is unavoidable, make it granular, scope it to this one package, and
  give it an expiry.

---

## What was already safe

Worth stating, because it is the reason this repository is not currently at
risk from the thing that usually bites a public repository running agents:

**Relay's unattended runs cannot start here.** `.relay/config.json` has no
`unattended` block, so every default applies, and every default is the closed
one — the switch is off, the allowlist is empty, both budgets are unset.
`assertUnattendedReady` in `src/unattended/policy.ts` refuses to run rather than
reading an empty allowlist as "anyone", which on a public repository would be a
funded denial-of-wallet attack with a UI in front of it. No workflow in
`.github/workflows/` triggers on `issues`, `issue_comment`, `pull_request_target`
or `workflow_run`, so there is no event a stranger can raise that reaches an
agent.

If you ever do enable unattended runs on this repository, three keys have to be
answered together and all three are the guardrail:

```jsonc
"workflow": { "triggerLabel": "relay:go" },
"unattended": {
  "enabled": true,
  "authors": ["aydinmrnv"],   // the labeller, not the issue author
  "maxRunCostUsd": 2.50,
  "maxDailyCostUsd": 20
}
```

Keep `authors` to yourself while the repository is public. The label is the
authorisation gesture, and on a public repository anybody who can be granted
triage can apply one.
