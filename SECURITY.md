# Security

## Reporting a vulnerability

Report privately, not in a public issue. Use GitHub's **Report a vulnerability**
button on this repository's [Security advisories][advisories] page, which opens
a draft advisory only the maintainer can read.

[advisories]: https://github.com/aydinmrnv/relay/security/advisories/new

Please include what you did, what happened, and what you expected instead. A
reproduction against a scratch repository is worth more than a description of
one. Expect an acknowledgement within a week.

Do not open a public issue, a pull request, or a discussion for a vulnerability
until a fix has shipped. A pull request is a public disclosure with a patch
attached.

## What is in scope

Relay orchestrates coding CLIs against a git worktree and a GitHub issue, so
the interesting failures are the ones where a guardrail does not hold:

- A path that lets an **unattended run start without the allowlist**, or that
  lets something other than the labeller's identity decide whether it may.
- A path that lets an unattended run **deliver past a draft pull request** —
  push to the default branch, merge, or otherwise bypass the `pr` ceiling.
- A **budget** that can be exceeded or reset, in a way that turns a public
  repository into a way to spend somebody else's money.
- A path where Relay **reads, logs, forwards or persists a credential**. Relay
  handles none, by design; anywhere it does is a bug of this kind.
- A change that gets **past the secret scan** between commit and push.
- A **worktree escape** — writes outside the isolated worktree a run was given.
- Anything in this repository's own CI that lets a fork's pull request obtain
  write access or read a secret.

## What is not

- A coding CLI (Claude Code, Codex) doing something you did not want inside its
  own sandbox. Report that to its vendor.
- A model writing bad code. That is what the review rounds and the tests are
  for, and a draft pull request is where a person is meant to catch it.
- Configuration you deliberately loosened. `unattended.authors` naming somebody
  you did not mean to trust is not a vulnerability in Relay.

## Supported versions

The latest published `relay-orchestrator` release, and `main`. Fixes land on
`main` and go out in the next release; there are no backports to older lines.
