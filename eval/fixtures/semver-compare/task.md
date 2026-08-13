`src/semver.js` sorts released versions correctly and everything else wrongly.

The release channel picks the newest version by sorting with `compare`, and it
has twice now offered `1.0.0-alpha` as newer than `1.0.0`, and `1.0.0-9` as
newer than `1.0.0-10`.

Make `compare` implement the precedence rules from Semantic Versioning 2.0.0:

1. Major, minor and patch are compared numerically, in that order.
2. A version *with* a prerelease has lower precedence than the same version
   without one. `1.0.0-alpha` comes before `1.0.0`.
3. Two prereleases are compared identifier by identifier, splitting on `.`:
   - identifiers made only of digits are compared numerically,
   - identifiers with any letter or hyphen are compared as ASCII strings,
   - a numeric identifier always has lower precedence than a non-numeric one,
   - if all shared identifiers are equal, the version with *more* identifiers
     has higher precedence.
4. Build metadata — anything after `+` — is ignored entirely for precedence.
   `1.0.0+build.1` and `1.0.0+build.2` are equal.

`compare(a, b)` returns a negative number, zero, or a positive number, so it can
be passed straight to `Array.prototype.sort` — which is what `sort` does. `sort`
must not mutate its argument.

`parse` is already correct and rejects anything that is not a valid version.
Do not change the shape of the exports or the module's public names.
