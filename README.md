# Relay

Relay takes a GitHub issue and coordinates the coding agents you already have installed — Claude Code and Codex — to plan, critique, implement, review and verify the work inside an isolated git worktree, then delivers the result as far as you let it: a commit, a pushed branch, a pull request, or a merge.

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
  → delivery                (commit → push → pull request → merge, as far as the policy allows)
```

Every one of those is a real artifact on disk. Nothing is a chat transcript.

## Wall-clock

Only one thing in that pipeline has to be serial: an agent cannot review work
that has not been written yet. Everything else Relay overlaps.

```
                        plan ████████████
   plan reviewer reads ahead ████████████        ← same wall-clock, no waiting
                 plan review             ███
              implementation                ████████████████
   code reviewer reads ahead                ████████████               ← free
                 code review                                ████
                  test suite                                ██████     ← free
```

**Reviewers read ahead.** Most of a review turn is not judgement, it is opening
the files the issue touches. That reading does not depend on the artifact under
review, so it does not wait for it: the plan reviewer reads while the planner
plans, the code reviewer reads while the code is written, and the review then
resumes that same session already knowing the codebase. Each reviewer is primed
on the *issue*, never on the artifact, so it forms its own view first —
independence and latency point the same way here. A priming turn that fails is
recorded and forgotten; the review runs cold, exactly as it did before.

**The suite runs during the code review.** Both look at the same tree and
neither needs the other's verdict, so the only thing that ever serialized them
was the phase order. A code revision cancels the run in flight and starts a new
one against the new tree, so nothing is ever reported against code that no
longer exists.

**Nobody runs the suite twice.** When Relay is running it, the implementer is
told so, and asked for the targeted checks only it can run instead of a full
suite whose result is already on its way.

**`-f` / `--fast` drops both reviews.** The implementer plans and implements in
one session and nothing reviews either artifact: no planner turn, no plan
review, no code review. That is the whole critique removed, so what is left
checking the work is the project's own test suite — which is why the run says so
out loud, the summary records `Code review: skipped`, and the pull request says
no second model read the diff. It is the right trade for a small ticket and the
wrong one for anything whose approach is the risky part. `plan.md` is still
written either way.

`relay run` prints where the time actually went, per phase, when it finishes.
Tune against that, not against this list.

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
2. `git push`, `git merge`, `gh pr create` and `gh pr merge` are denied to every agent in every role. Publishing is the delivery phase's job, under a policy you set — never something a model can decide to do mid-turn.
3. Publishing is off by default. Push, pull request creation, and merge require their own explicit flag/config opt-in or a TTY confirmation that defaults to no. These commands remain forbidden to every agent; only Relay's delivery code can execute them. Merge additionally requires passing tests, resolved blocking findings, an approved reviewed plan, an unprotected base branch, and a pull request created by this run. Every skipped step is recorded with its reason.
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
| `relay status [run]` | list runs, or print one run's summary |
| `relay watch [run]` | follow a run's events live |
| `relay diff [run]` | show the diff a run produced (`--stat` for a file list) |
| `relay plan [run]` | print the approved plan |
| `relay logs [run]` | print the event log |
| `relay resume <run>` | continue an interrupted or failed run |
| `relay deliver [run]` | run a finished run's delivery again (`--to <policy>`) |
| `relay stop [run]` | cancel a run at its next phase boundary |
| `relay --update` | update Relay itself to the latest version |

Every command above except `--update` takes `--json`, and exits with a code from
a documented table. Both are below, under [Machine-readable
output](#machine-readable-output) and [Exit codes](#exit-codes).

`relay run` accepts `142`, `#142`, `owner/repo#142`, or a full issue URL, plus `--verbose`, `--base <branch>`, `--planner`, `--implementer`, `--max-plan-rounds`, `--max-code-rounds`, `--no-tests`, `--commit`, `--push`, `--pr`, `-m` / `--merge`, `--merge-method`, the deprecated `--deliver <policy>`, `--no-offer-merge`, and `--tuff`.

The three worth typing by hand:

| | |
|---|---|
| `-f` | fast: one agent plans and implements, and neither the plan nor the diff is reviewed |
| `-m` | merge: take the work all the way — commit, push, pull request, merge — without being asked |
| `--tuff` | write this run's pull request, commit messages and code comments the way a person types them |

The other wall-clock flags: `--no-prime` (each reviewer reads only once its own
turn starts) and `--no-parallel-tests` (run the suite after the code review
instead of during it).

`-f -m` is the whole spectrum in four characters: nothing reviews it and it
lands anyway. The merge still has to pass its own gates — the tests must have
verifiably passed, and a protected base branch is still refused — so what `-f`
removes is the critique, never the evidence.

### `--tuff`

Relay's writing reads like a machine wrote it, because one did. `--tuff` makes
a run's output read like a person instead: the pull request, the commit messages
and the comments the implementer leaves in the code all carry the ordinary
typos of someone typing at speed.

The line it does not cross is anything read by something other than a person.
`Closes #142`, trailers, URLs, file paths, fenced blocks, inline code spans and
identifiers are left byte-for-byte alone (`src/util/typos.ts`), because a
mistyped issue reference does not look human — it looks broken. The transform is
seeded on the run id, so `relay deliver <run>` re-opens the same pull request
rather than a differently-mistyped one.

## Delivery

The pipeline does not stop at a diff. Delivery is the last phase of a run — it
commits the work, pushes the branch, opens the pull request, and merges it if
that is what the repository asked for. No question at the end, because a
question at the end of a twenty-minute run is answered by an empty terminal as
often as by a person.

```
Delivery
  policy pr
  ✓ Commit        ad183e8a on relay/13-ce2ubs
  ✓ Push          origin/relay/13-ce2ubs
  ✓ Pull request  https://github.com/acme/widgets/pull/21
  · Merge         not requested (deliver: pr)
```

The default ceiling is `branch`: Relay commits locally and publishes nothing.
`--push`, `--pr`, and `-m` / `--merge` independently opt in (each higher step
implies its prerequisites). The legacy `--deliver <policy>` remains available for
scripts.

| policy | |
|---|---|
| `none` | leave the diff staged in the worktree |
| `branch` | commit to the run branch, and stop (`--commit` is shorthand for this) |
| `push` | commit and push the branch |
| `pr` | commit, push and open a pull request |
| `merge` | all of the above, then merge the pull request (`github.mergeMethod`, default `squash`) |

The `github` config section contains `autoPush`, `autoPr`, `autoMerge` (all
default `false`), `mergeMethod`, `deleteBranchOnMerge`, and
`protectedBranches`. When cleanup is enabled, Relay deletes the remote run
branch and removes its guarded worktree after a successful run-created PR merge.

**Every step is gated before anything runs.** The policy says how far; the gate
says whether it is possible. No `origin` remote stops it at `branch`; no `gh`
stops it at `push`; a `merge` with no pull request to merge happens locally, and
only into a clean checkout already sitting on the base branch. A step that does
not run is *recorded with the reason*, and the run says so out loud rather than
reporting a clean success — a silent shortfall is the failure mode of anything
autonomous.

**It opens as a draft when the run's own evidence says so:** failing tests, a
plan that was never approved, or blocking review findings the implementer never
accepted. The reasons go at the top of the pull request body. Delivery is
automatic; looking ready to merge is not.

**A failed step stops the ones that depended on it and never fails the run** —
the work is committed on the branch either way. Nothing is retried behind your
back, and nothing is repeated: delivery is idempotent, so `relay deliver <run>`
picks up exactly where a run left off once `gh` is installed, the remote is
reachable, or the policy is raised.

A run that fails or is cancelled never reaches this phase. Its work is still
committed to the run branch so a `git worktree prune` cannot take it, and
nothing is published.

### Delivery consent

On an interactive terminal Relay offers each unpublished step in order: push,
pull request, then merge. Every question defaults to no, and declining a
prerequisite ends the sequence. A command-line flag or `github.auto*` setting
is already consent and skips that step's prompt. The merge prompt looks like:

```
  Merge https://github.com/acme/widgets/pull/21 into main now? (squash) [y/N]
```

**Enter is no.** A yes raises the ceiling and re-runs the idempotent delivery
phase. Non-interactive runs never prompt and publish only what flags or config
explicitly authorized.

It is never asked when the answer could only be no: work the run could not
vouch for (failing tests, an unapproved plan, unanswered blocking findings — the
same reasons the pull request opened as a draft), a checkout that cannot take a
local merge, `deliver: merge` (which already merged it), or a terminal nobody is
watching, which gets `relay deliver <run> --to merge` instead. `--no-offer-merge`
or `workflow.offerMerge: false` turns it off.

## Terminal output

A run takes minutes, so `relay run` shows a live dashboard: one framed row per
phase, in fixed columns, redrawn in place.

```
◆ RELAY ───────────────────────────────────────────────────────── Issue #142
Add authentication rate limiting

╭─ Pipeline ───────────────────────────────────────────────────────────────╮
│ ● Fetching issue              complete                                   │
│ ● Creating workspace          complete                                   │
│ ● Planning             1m 4s  claude · reading the codebase              │
│ ● Plan review          21.0s  codex · round 1/3 · reviewing              │
│ ⠋ Implementation      2m 12s  codex · editing src/auth/limiter.ts        │
│ ○ Code review                 claude · waiting                           │
│ ○ Tests                       waiting                                    │
├──────────────────────────────────────────────────────────────────────────┤
│ → implementer: $ npm test -- auth                                        │
│ ███████░░░░░  4/7 phases                                          3m 37s │
╰──────────────────────────────────────────────────────────────────────────╯
```

Every column starts in the same place from the first row to the last: mark,
phase, clock, then who is doing what. A duration sits directly beside the phase
it times rather than a column away from it, review phases show the round being
consumed (`round 2/2`) rather than a bare "revising", and the footer carries how
far in the run is and how long it has taken. A `--fast` run shows the five steps
it will actually take rather than greying out two it never enters. The run ends
with one block covering phases, rounds, diff, tests, cost and the next command —
with a per-phase duration, which is the number to tune against. When a phase
fails, that block names the agent that failed, the phase, and the two commands
worth running next.

`relay doctor` and `relay status` are framed the same way, and the commands a
session opens with — `relay start`, `relay doctor` — print the wordmark first.
The wordmark is drawn from a 5×5 pixel font (`src/ui/logo.ts`) rather than
pasted as art, so one drawing serves both alphabets: the ink is a block on a
unicode terminal and `#` everywhere else, and the two can never drift apart.

The display resolves colour, unicode and interactivity once, from the
environment, and everything routes through those primitives:

| | effect |
|---|---|
| not a TTY (a pipe, a redirect) | append-only lines, no colour, no cursor control, no wordmark |
| `CI=1` | same as a pipe, even on an allocated TTY |
| `NO_COLOR=1` | colour off; the display is otherwise unchanged |
| `TERM=dumb` | append-only, no colour, ASCII only |
| `RELAY_ASCII=1` | ASCII glyphs, punctuation, frames and logo; colour kept |

Frames are structure and are drawn wherever the output goes — they survive
`cat`, and they carry what belongs with what. The wordmark is decoration and is
drawn only for a person: a log collector does not need five rows of block
letters at the top of every file.

Two rules hold across all of it. Every border character is chosen from the
theme rather than written literally, so a terminal with no box drawing gets a
frame of `+-|` instead of a row of question marks. And every width is measured
with `visibleWidth`, never `.length`, because a coloured cell carries bytes that
occupy no columns — padding by `.length` puts the right-hand border in a
different place on every row exactly when colour is on.

Content Relay only passes through — a patch, a `--json` payload, an agent's
plan — is never rewritten by any of that.

## Machine-readable output

Every command that reports something takes `--json`, and under it **stdout
carries the JSON document and nothing else**. The banner, the frames, the
progress, the advice and the errors all move to stderr, so `relay run --json |
jq` works while the run is still printing.

| | |
|---|---|
| `relay --json` | the home screen: repository, config, recent runs, next command |
| `relay doctor --json` | every readiness check with its status, detail and remedy |
| `relay start --json` | the same checks (implies `--check`: a guided walkthrough has no JSON form) |
| `relay init --json` | the config it wrote, the test command it detected, the agents it found (implies `--yes`) |
| `relay run --json` | one object per line as phases complete, then a summary |
| `relay resume --json` | the same stream |
| `relay status [run] --json` | `runs` for the listing, `run` for one — unabridged, unlike the table |
| `relay watch [run] --json` | one object per line, as each event arrives |
| `relay diff [run] --json` | the file list, the counts, and the patch (`--stat` drops the patch, keeps the files) |
| `relay plan [run] --json` | the approved plan as markdown |
| `relay logs [run] --json` | the event log, with `data` as recorded, plus usage by phase |
| `relay deliver [run] --json` | the run after delivery, ledger included |
| `relay stop [run] --json` | what was signalled, and whether the process was still alive |

**Every document carries `schema`.** The moment something parses this output the
shape is a contract, and a contract needs a version to change under:

```json
{ "schema": 1, "command": "status", "run": { "runId": "…", "phase": "COMPLETE" } }
```

`schema` is bumped when a field is removed, renamed, or changes meaning. Adding
a field is *not* a bump — a consumer that ignores unknown keys survives it, and
one that does not was never going to survive any change at all.

`relay run --json` is a stream, not a blob, because a single document at the end
is the one shape that is useless while it matters. It emits `run_started`, then
`phase_started` / `phase_completed` per phase — the engine's own phases, so a
plan revision appears even though the dashboard folds it into the review row —
then `note` and `warning` lines, and finally one `summary` object carrying the
whole run and the code the command is about to exit with. Agent events are in
the stream only under `--verbose`.

```console
$ relay run 142 --json | jq -r 'select(.type == "phase_completed") | "\(.phaseLabel) \(.durationMs)ms"'
Fetching issue 412ms
Creating workspace 1203ms
Planning 64119ms
```

Serializers live next to `src/cli/runJson.ts` and are built from state, git and
the event log — never from the strings the terminal view paints. Nothing there
imports `output.ts`, which is why no payload can carry a colour code, an
ellipsis, or a column sized to fit a frame.

## Exit codes

| code | |
|---|---|
| 0 | success |
| 1 | a Relay error — the message on stderr says which |
| 2 | usage error: an unknown command, a missing argument, a bad flag |
| 3 | preconditions unmet: a missing CLI, a signed-out tool, not a repository |
| 4 | the run finished, and its work is committed nowhere |
| 5 | the run failed on its own terms: blocking findings unresolved, tests failed |
| 130 | cancelled — Ctrl-C, `relay stop`, or an abandoned prompt |

3 and 5 are the ones automation actually needs. *You are not set up* and *the
work is not good enough* are different answers requiring different responses,
and collapsing both into 1 makes a CI job page a person for a missing `gh`.

The distinctions worth stating outright. A run that **broke** mid-phase exits 1
— unless it broke on a precondition it had already named, which exits 3. A run
that **reached a verdict** and the verdict is bad exits 5: tests that were
discovered and failed, or blocking review findings the implementer never
accepted. A repository with no test suite has not failed its tests, so it does
not exit 5. Exit 4 is reserved for work that came out fine and is sitting
uncommitted in a throwaway worktree, which one `git worktree prune` would take
with it. When a run is both condemned and stranded, 5 wins: it is the answer
that decides whether anything downstream should happen at all.

The table lives in `src/cli/exit.ts`, and the tests assert one invocation per
code.

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
  "models": { "codeReviewer": "haiku" },
  "workflow": {
    "plan": "review",
    "reviewCode": true,
    "maxPlanReviewRounds": 2,
    "maxCodeReviewRounds": 2,
    "primeReviewers": true,
    "concurrentTests": true,
    "runTests": true,
    "deliver": "pr",
    "mergeMethod": "squash",
    "offerMerge": true,
    "maxTransientRetries": 2
  },
  "tests": { "command": null }
}
```

Roles are deliberately crossed: whoever plans does not review the plan, and whoever implements does not review the code. Invalid values are rejected at load time rather than silently ignored.

`models` is keyed by role or by provider, and a role wins. That is what puts a
review on a faster model than the turn it is reviewing even when both seats are
the same CLI — the cheapest latency lever in the file, and the one worth
reaching for before turning a review off.

| key | |
|---|---|
| `workflow.plan` | `review` (planner + adversarial plan review) or `inline` (the implementer plans in its own session — what `--fast` sets) |
| `workflow.reviewCode` | whether the other model reviews the diff (default `true`; `--fast` sets it `false`) |
| `workflow.typos` | write the pull request, commits and code comments with human typos (default `false`; what `--tuff` sets) |
| `github.autoPush` / `autoPr` / `autoMerge` | authorize each publishing step without a prompt (all default `false`) |
| `github.mergeMethod` | how a pull request lands: `squash` (default), `merge`, `rebase` |
| `github.deleteBranchOnMerge` | delete the remote run branch and guarded worktree after merge (default `false`) |
| `github.protectedBranches` | base branches Relay refuses to merge into (default `[]`) |
| `workflow.offerMerge` | ask once, at the end of a run that delivered short of a merge (default `true`) |
| `workflow.primeReviewers` | let each reviewer read the repository during the phase it will review |
| `workflow.concurrentTests` | run the suite during the code review rather than after it |
| `timeouts.primingMs` | cap on a read-ahead turn, which is speculative and must not stall a run |
| `timeouts.primeGraceMs` | how long a review waits for a read-ahead that has not landed; past it the reader is abandoned and the review starts cold |

## Requirements

Node ≥ 22.6, git, and whichever agent CLIs you assign to roles — installed and already authenticated. Run `relay doctor` to check.

## Updating

```bash
relay --update
```

It updates Relay itself, from anywhere: the repository you happen to be
standing in is never the thing it touches. How depends on how this copy was
installed — a git checkout is fetched and **fast-forwarded**, an npm-managed
copy is reinstalled from the repository, and an arrangement Relay does not
recognize is reported with the command to run instead of being guessed at.

A checkout with local commits of its own is left alone: Relay only
fast-forwards, so it never merges your work to update itself. Afterwards it
reinstalls dependencies only if the manifest moved, and rebuilds `dist/` only
if there is one to go stale — `bin/relay.mjs` runs the sources directly when
there is not.

## Development

```bash
npm install
npm run typecheck
npm test          # 448 tests, no network, no real agents
npm run build
```

The test suite uses `FakeAgentHarness` (deterministic scripted responses) and real temporary git repositories, so workflows, review loops, round limits, cancellation and resume are all tested without a model in the loop. The overlapping work is tested for overlap rather than for its effects: the suite writes a marker as it starts, and the code review asserts the marker is already there.
