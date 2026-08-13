`src/merge.js` layers user configuration over defaults. It has three problems,
and one of them is a security bug.

1. **The result shares structure with its inputs.** A nested object that exists
   only in `base` is copied by reference, so mutating the merged config reaches
   back into the defaults object every later merge starts from.
2. **`undefined` overwrites.** A key present in the override with the value
   `undefined` currently erases the default. "Absent" and "explicitly nothing"
   are different, and only `null` should mean the second one.
3. **`__proto__` is copied.** Configuration arrives via `JSON.parse`, and
   `JSON.parse('{"__proto__": {...}}')` produces a real own property. Assigning
   it changes the prototype of the object being built.

Make `deepMerge(base, override)` obey this contract:

- It returns a new object. Neither argument is mutated, and the result shares no
  plain object and no array with either of them — mutating anything reachable
  from the result must not be observable from `base` or `override`.
- Plain objects (and only plain objects, as `isPlainObject` already decides)
  merge recursively. Everything else replaces wholesale.
- Arrays replace rather than concatenate, and are copied rather than aliased.
- Values that are neither plain objects nor arrays — `Date`, class instances,
  functions, primitives — are carried across by reference. Cloning those is a
  different job and not this one.
- An override value of `undefined` is ignored. `null` replaces.
- The keys `__proto__`, `constructor` and `prototype` are never copied, at any
  depth, from either side.
- Key order is the `base` keys in their original order, then any keys the
  override introduces, in its order.

`isPlainObject` is already correct.
Do not change the shape of the exports or the module's public names.
