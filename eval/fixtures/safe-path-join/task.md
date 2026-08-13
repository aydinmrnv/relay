`src/paths.js` is what the file-serving endpoint uses to turn a request path
into a path on disk. Neither function does what its name says.

`safeJoin('/srv/data', '../../etc/passwd')` currently returns `/etc/passwd`, and
`isInside('/srv/data', '/srv/data-old/secrets')` returns `true` because one
string happens to start with the other.

Both are POSIX-only by design — the module imports `node:path/posix` so the
behaviour does not change with the machine it runs on.

Fix them:

**`safeJoin(root, ...segments)`** returns the normalized path of `segments`
resolved under `root`, and throws `PathEscapeError` when the result would not be
inside `root`.

- `..` is allowed as long as the final path stays inside: `safeJoin('/srv/data',
  'a/../b')` is `/srv/data/b`.
- An absolute segment throws. Silently reinterpreting `/etc/passwd` as a
  relative path is a surprise, not a safeguard.
- Empty and `.` segments are ignored.
- The result never has a trailing slash unless it is `/` itself, and a `root`
  written with a trailing slash behaves exactly like one without.
- With no segments it returns the normalized root.

**`isInside(root, candidate)`** is true when `candidate` is `root` itself or
something beneath it, and false otherwise — including for a sibling whose name
merely starts with the root's, such as `/srv/data-old`. Trailing slashes on
either argument make no difference.

`PathEscapeError` already exists and must keep its name.
Do not change the shape of the exports or the module's public names.
