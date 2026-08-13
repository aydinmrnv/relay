`src/config.js` reads settings out of the environment and hands back whatever
string it found. `PORT` arrives as `'8080'`, `DEBUG` as `'false'` — which is
truthy — and a missing required variable is discovered at the point something
tries to use it, one variable at a time, across three deploys.

Give it types, validation, and a single report.

**`loadConfig(schema, env = process.env)`**

A schema is an object of `key → { env, type, default, required, values }`.

*Reading.* The raw value is `env[spec.env]`. A string value is trimmed, and a
value that is empty after trimming counts as **absent**.

*Absent values.*

- With a `default`, the default is used **as it is** — not coerced, not checked
  against `values`.
- Otherwise, with `required: true`, that is a problem.
- Otherwise the key is present in the result with the value `undefined`.

*Types.* `type` defaults to `'string'`.

| type | |
|---|---|
| `string` | the trimmed value |
| `number` | `Number(value)`, which must be finite |
| `integer` | as `number`, and must be a whole number |
| `boolean` | `1`, `true`, `yes`, `on` are true; `0`, `false`, `no`, `off` are false; case-insensitive |
| `list` | split on `,`, each part trimmed, empty parts dropped |

*`values`.* When present, the coerced value must be one of them, compared with
`===`. For a `list`, every element must be.

*Problems.* Every problem is collected — a deploy should learn about all of them
at once — and if there are any, `loadConfig` throws a **`ConfigError`** with:

- `problems`: the messages, in schema key order,
- `message`: `invalid configuration:` followed by one `\n  - <problem>` per problem,
- `name`: `ConfigError`.

The messages, exactly:

```
<key>: <ENV> is required
<key>: <ENV> must be a number, got "<value>"
<key>: <ENV> must be an integer, got "<value>"
<key>: <ENV> must be a boolean, got "<value>"
<key>: <ENV> must be one of <a, b, c>, got "<value>"
<key>: unknown type "<type>"
```

For a failing `list`, `<value>` is the offending elements joined with `, `.

Variables in `env` that the schema does not name are ignored.

`ConfigError` is exported alongside `loadConfig`.
