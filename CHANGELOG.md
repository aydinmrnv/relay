# Changelog

What changed for people who use Relay: the studio, the CLI, the GitHub Action
and Relay Cloud. Newest first.

## Unreleased

Launch readiness. Relay is in beta, and free while it is.

### The studio

- The command palette (⌘K) no longer crashes the page.
- Sign-in can no longer be used to send someone to another site.
- Exports never contain a secret you typed into a node; each becomes a named
  repository secret. A workflow with errors, placeholder names on its
  allowlist, or no repository does not export.
- An exported workflow says truthfully what starts it. A label on a GitHub
  issue starts it by itself; any other trigger exports as a workflow you start
  with an issue number, and the export says so.
- Edits made just before leaving the builder are kept. A full browser store, a
  damaged saved item or a failed save is reported instead of losing work, and
  importing asks before it replaces anything.
- Sync between tabs and devices no longer drops or duplicates changes, and
  signing out with unsent changes asks first.
- The builder works on a phone, and shortcuts show the right keys on Windows
  and Linux.
- Test runs, simulated pull requests and simulated spend are labelled as such
  everywhere. Apps that cannot be connected yet say "Planned".
- Templates start paused, like every other new workflow.
- The product is called Relay; renaming it was removed.
- Relay Cloud is described as what it is, an invite-only beta, with its limits,
  and is only offered where it is switched on.
- Privacy and terms name the operator, NullStack.one, and a contact address.
- Every page has its own title; error, loading and not-found screens exist.
- The API is rate limited, accounts have a size limit, and share pages are
  not indexed and hide more of what could identify you.
- The Animations setting applies to sheets, dialogs and menus too.

### The CLI and the Action

- Ctrl-C stops `relay run`, `relay resume` and `relay watch` cleanly.
- The Action installs the CLI from the release tarball, and releases are made
  only from builds that passed CI.
- Only the agents that hold a role need to be installed and signed in.
- An unknown key in `.relay/config.json` is an error that names it.
- Shell completion covers subcommands and flags; help fits the terminal;
  a mistyped command gets a suggestion; errors are JSON with `--json`.
- Unattended runs read only comments from people they have a reason to trust,
  and keep secret-looking environment variables away from the agents.
- The reference says how agents are confined, on which operating system, and
  that the daily budget is not enforced on GitHub Actions.

### `relay connect` and Relay Cloud

- A paired studio holds a token that is good for one start of `relay connect`,
  and the first run or install it asks for is confirmed in the terminal.
- An install can write only the three files an export produces, and never over
  a file an export did not write.
- The hub survives malformed requests, re-issues machine tokens at every start,
  re-checks who is admitted at every wake, and puts idle machines to sleep.
- A long run keeps its first and latest lines instead of stopping at 5,000.
