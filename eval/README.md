# The eval harness

Relay exists because of one empirical claim:

> Specialized agents reviewing and challenging each other's engineering work
> produce better changes than one agent working alone.

Every design decision downstream of it — two review rounds and not three, the
plan reviewed by a different model, `--fast` dropping the plan stage, priming
reviewers on the issue rather than the artifact — is a hypothesis about that
claim. This directory is where those hypotheses get measured instead of
asserted.

```bash
relay eval --check-fixtures        # verify the fixture set. Costs nothing.
relay eval --dry-run               # the plan and the cost estimate. Costs nothing.
relay eval --compare second-agent  # the headline claim: one agent vs. two
relay eval --report                # regenerate results/RESULTS.md
```

`relay eval` runs real `WorkflowEngine` runs against real git repositories with
the real CLIs. Nothing about the pipeline is stubbed for measurement — a harness
that measured a simplified pipeline would be measuring the wrong thing exactly
where it matters.

## What gets measured

| | |
|---|---|
| solve rate | the hidden suite passes |
| regression rate | the change broke something that used to work |
| cost and wall-clock | per task, per configuration |
| review yield | blocking findings raised, and whether they changed the outcome |

Rates carry 95% Wilson intervals and means carry a standard deviation, because
model calls are not deterministic and a result with no error bar on a stochastic
pipeline is not a result. `--repeat` sets how many times each task runs.

Review yield is measured two ways. The finding counts describe the debate. The
`rescued` / `broke` counts are objective: the hidden suite is run against the
diff as it stood *when review began* as well as against the delivered diff, so a
review that turned a failing change into a passing one is visible as a fact
rather than as a count of things somebody said were important.

## The configurations

| arm | |
|---|---|
| `solo` | one agent — the implementer model — plans and implements. Exactly what `relay run --fast` produces. |
| `solo-planner` | the same, on the planner model, so the single-agent baseline is not confounded by which model happens to be alone |
| `same-model` | the full pipeline with one model in all four seats |
| `cross-model` | the shipped default |
| `no-plan-review` | cross-model, plan written inline, code review still on |
| `code-rounds-1` / `code-rounds-3` | cross-model with one and three code-review rounds |

And the comparisons they answer:

| comparison | question |
|---|---|
| `second-agent` | does a second agent help at all? |
| `second-model` | is it the second model, or just a second pass? |
| `plan-stage` | does reviewing the plan earn its turns? |
| `review-depth` | no review, code review only, or the full pipeline? |
| `code-rounds` | is two rounds the right number? |

## The fixture format

```
eval/fixtures/<id>/
  fixture.json     what the task is, where it came from, how it is judged
  task.md          the issue text the agents receive, verbatim
  repo/            the snapshot agents work in — everything they can see
  hidden/          the acceptance suite, overlaid only when grading
  solution/        a reference fix, used only by --check-fixtures
```

`repo/` and `hidden/` are separate trees because the guarantee is structural.
The harness materializes `repo/` into a fresh git repository and nothing else;
the run's worktree is derived from that repository, so there is no instruction
anywhere telling an agent not to read the hidden suite — there is nothing to
read. It is then checked rather than assumed: `materializeFixture` fails closed
if any hidden path exists in the tree the run is about to start from, and the
worktree is checked again afterwards.

Grading happens in a third directory: a detached checkout of the run's commit,
with the fixture's own test files restored and the hidden suite overlaid. The
restoration matters — without it, the cheapest way to pass the regression suite
is to delete the assertion that fails.

### fixture.json

```json
{
  "title": "One line, written as an issue title",
  "kind": "bug | feature | refactor",
  "source": { "kind": "authored", "note": "why this task exists" },
  "acceptance": { "command": ["node", "--test", "tests-hidden/x.acceptance.test.js"] },
  "regression": { "command": ["node", "--test", "test/x.test.js"] },
  "protected": ["test/x.test.js"]
}
```

- `acceptance` — the hidden suite. Passing it is what "solved" means.
- `regression` — the visible suite, which already passed before the change.
- `protected` — files restored from `repo/` before grading. Defaults to
  everything under `test/`, which is where a fixture's behaviour contract lives
  by convention.
- `source.kind: "snapshot"` additionally requires `repository` and `commit`. A
  pinned snapshot with no commit is not pinned, and a result computed against
  "the repository, at some point" cannot be reproduced.

Commands are screened with exactly the rules a project's own `test` script is
screened with, because `--fixtures <dir>` can point anywhere.

### Adding one

1. `mkdir eval/fixtures/<id>` and write the five parts above.
2. The task must be **completely specified** in `task.md`. The hidden suite is
   only fair if everything it checks was stated — an eval that rewards guessing
   an unstated convention measures the wrong thing.
3. Write a `solution/` that satisfies it.
4. `relay eval --check-fixtures --fixture <id>`.

The check enforces the fixture's own contract: at the base commit the hidden
suite must **fail** and the visible suite must **pass**, and with the reference
solution applied both must pass. A hidden suite that already passes measures
nothing, a visible suite that already fails makes every run look like a
regression, and a hidden suite nothing can satisfy drags every arm down by the
same amount and reads as a finding.

The 20 fixtures shipped here are authored rather than snapshotted, and say so in
their `source`. They are small on purpose: a fixture whose hidden suite only
checks the headline behaviour cannot tell a careful change from a lucky one, so
each one specifies the obvious case *and* the edges around it.

## Results

`relay eval` writes one JSON file per session under `results/runs/` and
regenerates `results/RESULTS.md` from every session in the directory, so
re-running accumulates evidence instead of replacing it and the intervals narrow
over time.

Every session records the CLI version and pinned model for each agent. A result
attached to no model version expires silently.

By default results go to `.relay/eval/`, which is local and gitignored. The
published table is produced with `--out eval/results`.

## The honest outcome

If the numbers do not support the design, that is the most valuable thing this
harness can produce. The right response is a changed default and a corrected
README — not a defended one.
