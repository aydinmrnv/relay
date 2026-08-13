`src/retry.js` retries too much, and retries the wrong things.

Three separate problems, all in `retry`:

1. **One attempt too many.** `attempts: 3` should mean the operation is called
   at most three times. It is currently called four.
2. **A wasted sleep at the end.** After the final attempt fails there is nothing
   left to wait for, but the helper sleeps anyway before rethrowing.
3. **Errors marked non-retryable are retried.** An error with
   `retryable === false` must be rethrown immediately, without a further attempt
   and without a sleep. Authentication failures and missing binaries are marked
   this way, and retrying them only spends time to reach the same error.

The rest of the contract, which must keep holding:

- On success, `retry` returns the operation's value and makes no further calls.
- When every attempt fails, the *last* error is thrown.
- `operation` receives the zero-based attempt index.
- Sleeps happen *between* attempts, so N attempts means N−1 sleeps at most.
- The delay before attempt `n` is `delayFor(n - 1, options)`: the first retry
  waits `baseMs`, and each subsequent one multiplies by `factor`, capped at
  `maxMs`. `delayFor` is already correct.
- `options.sleep` overrides how waiting is done, and is what tests use.
- `attempts: 1` means no retrying at all.

Do not change the shape of the exports or the module's public names.
