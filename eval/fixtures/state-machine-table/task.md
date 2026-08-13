`src/machine.js` encodes the document workflow as nested `if`/`else if`. The
rules are only executable, never readable: the UI wants to render the buttons
that are legal from the current state and there is no way to ask.

Restructure it around an exported table. **The transitions themselves do not
change** — this is a refactor, and the acceptance suite is the behaviour it has
to preserve.

Export `TRANSITIONS`: an object keyed by state, each holding an object mapping
an event to the state it leads to. Every state has an entry, including the
terminal ones, which map to `{}`.

| from | event | to |
|---|---|---|
| `draft` | `submit` | `review` |
| `draft` | `discard` | `discarded` |
| `review` | `approve` | `approved` |
| `review` | `reject` | `draft` |
| `review` | `discard` | `discarded` |
| `approved` | `publish` | `published` |
| `approved` | `reject` | `draft` |
| `published` | `archive` | `archived` |
| `discarded` | — | terminal |
| `archived` | — | terminal |

Export `STATES`: every state name, sorted alphabetically.

`transition(state, event)` reads the table and returns the next state. When the
pair is not in it — including when the state itself is unknown — it throws an
`Error` whose message is exactly `cannot <event> from <state>`, as it does today.

Export `canTransition(state, event)`: `true` or `false`, and **never throws**,
including for an unknown state or event.

Export `eventsFrom(state)`: the legal events from that state, sorted
alphabetically. A terminal state gives `[]`, and so does an unknown one.
