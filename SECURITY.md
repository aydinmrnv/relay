# Security

## Reporting a vulnerability

Write to **support@nullstack.one** with "Relay security" in the subject. Please
do not open a public issue for something that could be used against other
people before it is fixed.

Say what you found, how to reproduce it, and which part it is in: the studio
(`web/`), the CLI and engine (`src/`), the GitHub Action (`action.yml`), or
Relay Cloud (`src/cloud/`, `scripts/azure/`). You will get an answer saying
whether it is accepted and what happens next. Relay is in beta, so there
is no bounty and no guaranteed response time; reports are read, and credited in
the changelog unless you ask otherwise.

## What is in scope

- The hosted studio and its API: reading or changing another account's
  workflows, runs, connections or share links; getting a stored connection out
  in the clear; getting a secret into a share link or an export.
- `relay connect`: reaching the companion on 127.0.0.1 from a page that was
  not paired with it.
- The engine and the Action: an agent publishing (push, merge, pull request)
  on its own, a run started by someone who is not on the allowlist, a secret
  leaving in a commit, a log or an event stream.
- Relay Cloud: reaching another person's machine or its sign-ins.

## What to know before you report

These are how Relay works today, described under
[Safety](docs/cli.md#safety), and are not vulnerabilities by themselves:

- The coding agents run without their own permission prompts. A Claude Code
  implementer is not sandboxed and can do what your account can do.
- An issue is untrusted input that reaches the agents' prompts. Unattended runs
  narrow that (an allowlist, trusted comments only, secret-looking environment
  variables withheld) and do not close it.
- `.relay/config.json` names programs Relay runs. Review a change to it as you
  would a change to a CI workflow.

## Supported versions

Fixes go to `main`, the hosted studio, the rolling `cli-latest` release and
the `v1` Action tag. Older numbered releases are not patched.
