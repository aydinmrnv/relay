`src/limiter.js` is a fixed-window rate limiter wearing a sliding-window name.
Because the whole counter resets the moment the window rolls over, a client that
spends its budget at the end of one window and again at the start of the next
gets twice the limit in a very short time.

Turn it into a real sliding window, and give callers the three things they
currently have to guess.

**`allow(key, now = Date.now())`** — true when this request is within the limit.

- The window is half-open: a request recorded at `t` counts while
  `now < t + windowMs`, and stops counting at exactly `t + windowMs`.
- A request that is allowed is recorded. A request that is **rejected is not
  recorded**, so being over the limit does not push the recovery further away.
- Keys are entirely independent of each other.

**`remaining(key, now = Date.now())`** — how many further requests would be
allowed right now. Records nothing, so calling it twice gives the same answer.

**`retryAfter(key, now = Date.now())`** — milliseconds until the next request
would be allowed: `0` when one is allowed now, and otherwise the time until the
oldest counted request leaves the window.

**`prune(now = Date.now())`** — forgets every key with no counted requests left,
and returns how many keys it dropped. Without it the limiter is a memory leak
with one entry per key ever seen.

`size` (the number of tracked keys) and the constructor's validation are already
right: `limit` and `windowMs` must both be integers of at least 1.

Do not change the shape of the exports or the class's public names.
