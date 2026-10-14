# Changelog

What changed for people who use Relay: the studio, the CLI, the GitHub Action
and Relay Cloud. Newest first.

## Unreleased

Launch readiness. Relay is in beta, and free while it is.

### Workflows run as drawn

- `relay workflow run` performs a workflow from the studio as it was drawn:
  the guardrails, conditions and filters, an AI step, the agent pipeline,
  delivery and the app steps after it. `--dry-run` decides everything and
  starts and sends nothing.
- `relay workflow serve` keeps a workflow's own trigger on a machine of yours:
  an incoming webhook, a schedule, a label on a GitHub issue, and the webhooks
  GitHub, Linear and Sentry send for their own events. Deliveries are signed,
  and one sent twice starts one run.
- Human approval is real. The run waits until a person answers, in the
  studio's run panel or with `relay workflow approve`, and takes the Rejected
  path on a no or on silence.
- Steps in Slack, Discord, GitHub and Linear and HTTP requests are performed.
  A step in an app Relay has no connection to is handed to a bridge URL of
  yours, or reported as not performed. Nothing is reported as done that was
  not.
- *Run on your computer* runs the whole workflow, not the pipeline alone, and
  the canvas shows what became of every node.
- Export writes `.relay/workflows/<name>.json`, the workflow compiled for the
  CLI, beside the config and the GitHub Actions workflow.
- Every node says what a real run does with it. A Filter is evaluated in a
  test run, by the evaluator a real run uses.
- The workflow's own credentials are read from the environment or `--env-file`
  and are never passed on to the agents, the AI step's included.
- An event is a stranger's words. It can name an issue in a tracker and never
  a file; what it says is escaped before it lands in a Slack message, a JSON
  body or a URL; and it cannot set what the run works out for itself, such as
  an estimate.
- An event may start the agents only when the workflow has a Budget gate with
  a per-run cost and a daily budget. `.relay/STOP` stops every workflow's
  unattended starts, and `relay workflow serve` reads the workflow file again
  for each event, so pausing it needs no restart.
- With no secret set, an incoming webhook is taken only from a script on the
  same machine, never from a web page, and nobody's word is taken for who
  sent it.
- A step that two paths lead to runs when either arrives, and a Merge paths
  after it waits for the one still coming.
- Answering an approval from the studio needs the same yes at `relay connect`'s
  terminal that starting a run does.

### Projects, and a setup that ends in your repository

- Relay says one thing about itself: it builds automations that run on your
  own GitHub Actions, in your repository. The site's first button is *Get
  started*, beside *Sign in*; the playground is called the demo, and is no
  longer what the main button opens.
- A project is one repository and where its workflows run: its own GitHub
  Actions, your computer, or Relay Cloud. An account has as many as it has
  repositories. The switcher at the top of the sidebar picks the one in view,
  and the dashboard, the workflows and the runs follow it.
- Setup after sign-up asks, in order: which repository, where it runs, what
  the first workflow does, and the rules it runs under — the label that starts
  it, who may add that label, what a run and a day may cost, which agents do
  the work. The workflow it makes exports with nothing left to fix.
- The last step is the install, for the runner you chose: the three files to
  commit, each agent's sign-in as a repository secret, the repository setting
  that lets Actions open pull requests, and the label that starts a run. For a
  public repository the studio can check the files arrived. All of it is under
  Projects afterwards.
- Every workflow type says how it starts on the runner you picked. On GitHub
  Actions an issue event starts it by itself; a schedule or a failed build is
  started by hand there, and the card says so.
- A new account opens on setup, not on an empty dashboard. An account never
  starts with example workflows or runs in it.
- SETUP.md in an export now says to let Actions open pull requests, which
  GitHub leaves off for new repositories.

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

- A pull request Relay opens carries its receipts as a table: each claim an
  agent made about the change, beside what Relay measured, and whether the two
  agree.

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
