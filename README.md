# Relay

Relay takes a GitHub issue and coordinates the coding agents you already have installed — Claude Code and Codex — to plan, critique, implement, review and verify the work inside an isolated git worktree.

It is not "run several agents in parallel". The point is that **specialized agents review and challenge each other's actual engineering work**, and that every claim they make is checked against git rather than taken at face value.

```bash
relay start       # one command: dependencies, sign-in, config, and a first run
relay run 142
```

`relay start` is the whole path from a fresh clone to a run you understand. It
checks that `git`, `gh`, Claude Code and Codex are installed *and* signed in,
runs each vendor's own login command for you when one is not, hands off to
`relay init` for configuration, explains what a run does before you spend
anything on one, and then offers to start one. Every step is skipped when it is
already satisfied, so re-running it is also the repair path when a CLI breaks
later.

**It never handles a credential.** Relay has no API keys and never sees a token:
`start` only ever spawns `claude auth login`, `codex login` or `gh auth login`
with the terminal handed over, and then asks that CLI again whether it worked.

| | |
|---|---|
| `relay start --dry-run` | walk the whole pipeline with no agent calls, so a run costs nothing to preview |
| `relay start --tour` | replay the explanation of the phases, artifacts, cost and guarantees |
| `relay start --check` | report what is missing and exit non-zero, prompting nothing — what a pipe and CI get automatically |

`relay init` walks through configuration on a terminal and asks the one question
that actually shapes a run — which model reviews the work another model
produced. `relay init --yes` skips every prompt and writes the detected
defaults, which is what CI and scripts should use.

## What actually happens

```
issue
  → plan                    (planner reads the codebase, writes plan.md)
  → plan review             (a different model attacks the plan against the real code)
  → revised plan            (planner responds ACCEPT / REJECT / NEEDS_CLARIFICATION to every finding)
  → implementation diff     (implementer works in an isolated worktree)
  → code review findings    (reviewer reads the diff Relay computed from git)
  → revised implementation  (only BLOCKING findings are routed back)
  → test evidence           (the project's own test command, judged by exit code)
  → final summary
  → optional local commit   (--commit, on the run's own branch — never pushed)
```

Every one of those is a real artifact on disk. Nothing is a chat transcript.

## Design

**Relay never calls a model API.** It has no API keys, reads no credentials, and never sees a token. It launches the official CLIs you have already authenticated (`claude`, `codex`, `gh`) as child processes and lets each one own its own auth.

**Agents are behind one interface.** `AgentHarness` (`src/agents/types.ts`) has `checkAvailability`, `start`, `resume` and `cancel`. Claude's `stream-json` and Codex's JSONL are normalized into one `AgentEvent` union at the harness boundary; nothing above `src/agents/` knows which CLI produced an event. Adding a third CLI means adding one file under `src/agents/` and one row in `AGENT_REGISTRY` (`src/agents/index.ts`) — config validation, `relay doctor`, `relay init`, `relay start` and the `--planner` / `--implementer` flags all read that array, so none of them need touching. Each row also declares how that vendor is installed and how it is signed in, which is all onboarding needs to know to delegate.

**Issue trackers use the same seam.** `IssueProvider` (`src/github/types.ts`) is implemented today only by `gh`, and `ISSUE_PROVIDER_REGISTRY` (`src/issues/registry.ts`) is where a second tracker plugs in: one implementation plus one row, carrying its own install command and its own login command. `relay start` asks where issues live by reading that array rather than by naming GitHub.

**Cost is reported, not guessed.** Both CLIs report what a turn consumed, and Relay accumulates it per phase and per run. `relay status` shows the run total, `relay logs` breaks it down by phase, so `maxPlanReviewRounds` can be tuned against a real number. Relay never prices tokens itself: a missing cost means the CLI did not publish one, never that the work was free.

**Verification is mechanical, not conversational.** Relay computes the diff itself (`git add -A` + `git diff --cached <baseSha>`), so an implementer that reports success while changing nothing fails the run. Test results come from process exit codes. A phase is never marked successful because an agent said so. Test discovery recognizes what the project already declares — Node, Rust, Go, Python, Gradle, Maven, Ruby, .NET and a `Makefile` `test` target — and, when the root declares nothing, falls back to the one package the run's changes were confined to.

**Transient failures are retried; real ones are not.** A turn that dies on a rate limit, a dropped connection or a 5xx is retried up to `workflow.maxTransientRetries` times with exponential backoff and jitter, resuming the agent's session when the CLI reported one so the retry keeps its context. Auth failures, a missing binary and cancellation are never retried — retrying them only spends tokens to reach the same error. Every retry is announced and logged; none are silent.

**Agent output is untrusted input.** Artifacts are exchanged in delimited sections (`===RELAY:BEGIN REVIEW=== … ===RELAY:END REVIEW===`) carrying small JSON payloads. Parsing is tolerant but validating: unknown enum values are coerced with a recorded warning, malformed findings are dropped, and a review that requests changes without naming anything is rejected. If output does not parse, Relay resumes the same session once with a format reminder rather than re-running the turn.

**Sessions persist.** Revisions resume the agent's existing session, so the planner still has the codebase reading that produced the plan, and the implementer still has the reasoning behind its own code.

## Safety

1. Agents only ever run with the worktree as their working directory. Codex gets a real OS sandbox (`--sandbox read-only` / `workspace-write`); Claude gets a tool deny list.
2. `git push`, `git merge`, `gh pr create` and `gh pr merge` are denied to every agent in every role.
3. Relay never pushes, merges, or opens a pull request. That is your decision. `--commit` is opt-in and goes no further: it commits to the run's own local branch inside `~/.relay/workspaces`, moving no shared ref, so finished work survives a `git worktree prune` instead of stranding as a staged index. Without it, `relay status` marks a completed run whose diff is uncommitted as **unlanded**.
4. The user's working tree is only read. Runs happen in a separate worktree, so your branch, index and uncommitted files are untouched.
5. Worktree removal is guarded: the path must be inside `~/.relay/workspaces`, at least three levels deep, and registered with git. Everything else is refused.
6. No shell, anywhere. Every subprocess is spawned with an explicit argv, so issue text and agent output cannot become shell syntax.
7. Test commands are screened. A `scripts.test` or `Makefile` `test` recipe (including the targets it depends on) containing `rm -rf`, `sudo`, `curl | sh`, `docker`, `publish`, or `deploy` is reported and skipped, not run.
8. Credential-shaped strings are redacted before anything reaches `events.jsonl`.
9. Round limits are enforced (plan 3, code 2 by default), so two agents cannot debate forever.
10. Authentication is delegated, never handled. Onboarding can only spawn a vendor's own login command with the terminal inherited — Relay reads none of that exchange, prompts for no secret, and writes nothing about it to `.relay/`.

## Commands

| Command | |
|---|---|
| `relay start` | guided onboarding: dependencies, sign-in, config, tour, first run (`--check`, `--tour`, `--dry-run`) |
| `relay init` | guided setup, writing `.relay/config.json` (`--yes` for the detected defaults) |
| `relay doctor` | check git, gh, Claude Code, Codex, repo, sign-in state and auth |
| `relay run <issue>` | run the full workflow |
| `relay status [run]` | list runs, or print one run's summary (`--json` for machine-readable output) |
| `relay watch [run]` | follow a run's events live |
| `relay diff [run]` | show the diff a run produced (`--stat` for a file list) |
| `relay plan [run]` | print the approved plan |
| `relay logs [run]` | print the event log |
| `relay resume <run>` | continue an interrupted or failed run |
| `relay stop [run]` | cancel a run at its next phase boundary |

`relay run` accepts `142`, `#142`, `owner/repo#142`, or a full issue URL, plus `--verbose`, `--base <branch>`, `--planner`, `--implementer`, `--max-plan-rounds`, `--max-code-rounds`, `--no-tests` and `--commit`.

`relay resume <run> --commit` also works on a run that already completed: it commits that run's stranded work and does nothing else.

## Terminal output

A run takes 10–20 minutes, so `relay run` shows a live checklist: the active
phase carries a spinner and an elapsed time, review phases show the round being
consumed (`round 2/3`) rather than a bare "revising", and the run ends with one
block covering phases, rounds, diff, tests, cost and the next command. When a
phase fails, that block names the agent that failed, the phase, and the two
commands worth running next.

The display resolves colour, unicode and interactivity once, from the
environment, and everything routes through those primitives:

| | effect |
|---|---|
| not a TTY (a pipe, a redirect) | append-only lines, no colour, no cursor control |
| `CI=1` | same as a pipe, even on an allocated TTY |
| `NO_COLOR=1` | colour off; the display is otherwise unchanged |
| `TERM=dumb` | append-only, no colour, ASCII only |
| `RELAY_ASCII=1` | ASCII glyphs and punctuation, colour kept |

Content Relay only passes through — a patch, a `--json` payload, an agent's
plan — is never rewritten by any of that.

## Run state

```
.relay/
  config.json
  runs/<run-id>/
    state.json                 phase, sessions, rounds, diff summary, test results, token usage, commit
    issue.md                   the issue as the agents received it
    plan.md                    current plan (rewritten on each revision)
    implementation-notes.md
    summary.md                 what was decided and why
    events.jsonl               full audit trail
    reviews/plan-round-N.json  every finding, with the raw agent message
    discussion/…               ACCEPT / REJECT / NEEDS_CLARIFICATION per finding
    patches/…                  the diff at each stage
    tests/test-run.log
```

Worktrees live outside the repository, at `~/.relay/workspaces/<owner>/<repo>/issue-<n>-<id>`, on a branch named `relay/<n>-<id>`. Run state is written atomically (temp file + fsync + rename), so an interrupted Relay never leaves a corrupt `state.json` — `relay resume` picks up from the last completed phase.

## Configuration

`.relay/config.json`:

```json
{
  "agents": {
    "planner": "claude",
    "planReviewer": "codex",
    "implementer": "codex",
    "codeReviewer": "claude"
  },
  "workflow": {
    "maxPlanReviewRounds": 3,
    "maxCodeReviewRounds": 2,
    "runTests": true,
    "commit": false,
    "maxTransientRetries": 2
  },
  "tests": { "command": null }
}
```

Roles are deliberately crossed: whoever plans does not review the plan, and whoever implements does not review the code. Invalid values are rejected at load time rather than silently ignored.

## Requirements

Node ≥ 22.6, git, and whichever agent CLIs you assign to roles — installed and already authenticated. Run `relay doctor` to check.

## Development

```bash
npm install
npm run typecheck
npm test          # 305 tests, no network, no real agents
npm run build
```

The test suite uses `FakeAgentHarness` (deterministic scripted responses) and real temporary git repositories, so workflows, review loops, round limits, cancellation and resume are all tested without a model in the loop.
