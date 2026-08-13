`src/glob.js` turns a pattern into a regular expression by replacing every `*`
with `.*`. That makes `src/*.js` match `src/vendor/bundled/thing.js`, which is
the opposite of what a glob is for.

Give `matches(pattern, path)` real glob semantics. Paths always use `/`.

- `*` matches any run of characters **except `/`**, including an empty run.
- `**` matches any run of characters including `/`.
- `**/` matches zero or more whole path segments, so `**/*.js` matches both
  `app.js` and `src/a/app.js`, and `a/**/b` matches `a/b` as well as `a/x/y/b`.
- `?` matches exactly one character that is not `/`.
- `[abc]` matches one of the listed characters and `[a-z]` a range. A leading
  `!` or `^` inside the brackets negates the set: `[!a]`. An unclosed `[` is a
  literal bracket.
- Every other character is literal, including regular-expression
  metacharacters — `a+b` matches only `a+b`, and `a.b` does not match `axb`.
- The match is anchored at both ends: `abc` does not match `xabcx`.

Add **`matchesAny(patterns, path)`**.

- A pattern starting with `!` is an exclusion; the rest of it is an ordinary
  glob.
- The path matches when at least one non-excluding pattern matches it and no
  excluding pattern does.
- Order does not matter: an exclusion always wins, wherever it appears.
- A list containing only exclusions matches nothing, and so does an empty list.

Do not change the shape of the existing export or the module's public names.
