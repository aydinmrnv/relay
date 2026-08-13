`src/query.js` splits on `&` and `=` and stops there. Anything encoded, repeated
or empty comes out wrong. Finish it.

**`parseQuery(input)`** returns a plain object of strings and arrays of strings.

- A leading `?` or `#` is stripped. An empty input gives `{}`.
- Pairs are split on `&`; empty pairs (`a=1&&b=2`) are skipped, as are pairs
  with an empty key (`=1`).
- Keys *and* values are percent-decoded, and `+` decodes to a space. `%2B`
  decodes to `+`, so the `+` substitution happens before percent-decoding.
- A malformed escape such as `%zz` is left exactly as it is rather than throwing.
- A pair with no `=` gives that key the value `''`.
- A key that appears more than once gives an array of its values, in the order
  they appeared.
- A key written with a `[]` suffix always gives an array, even with a single
  value. The `[]` is not part of the key.
- The keys `__proto__`, `constructor` and `prototype` are dropped rather than
  assigned, and the returned object is an ordinary object literal — its
  prototype is `Object.prototype`.

**`formatQuery(params)`** is the exact inverse.

- Keys are emitted in the object's own order.
- An array value emits one `key[]=value` pair per element, in order.
- A value of `undefined` is skipped entirely; `null` emits `key=`.
- Keys and values are encoded with `encodeURIComponent`. The `[]` marker itself
  is not encoded.
- An object with nothing to emit gives `''`.

`parseQuery(formatQuery(parseQuery(text)))` must deep-equal `parseQuery(text)`
for any input.

Do not change the shape of the exports or the module's public names.
