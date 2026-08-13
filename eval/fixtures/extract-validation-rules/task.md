`src/validate.js` is one function of nested `if`/`else if`. Every new field adds
another branch, and no rule can be tested, reused or reordered on its own.

Restructure it as a table of rules. **The set of problems it produces must not
change** — this is a refactor, and the acceptance suite is the behaviour it has
to preserve.

Export `RULES`: an ordered array where each entry is

```js
{ field: string, code: string, message: string, applies(user): boolean, test(user): boolean }
```

- `applies(user)` — whether this rule has anything to say about this user.
  Optional fields are absent for most users, and a rule that does not apply is
  not a rule that passes.
- `test(user)` — `true` when the user **satisfies** the rule.
- Each rule must be callable on its own: `RULES[0].test({ name: 'x' })` works
  without anything else having run first.

`validate(user)` then walks `RULES` in order and returns
`{ field, code, message }` for each rule that applies and fails, **at most one
per field** — once a field has a problem, later rules for that field are
skipped, which is what the `else if` chain does today.

The rules, in order, with the exact codes and messages they already produce:

| field | code | when it fails | message |
|---|---|---|---|
| `name` | `required` | not a string, or blank once trimmed | `name is required` |
| `name` | `too_long` | more than 40 characters once trimmed | `name must be 40 characters or fewer` |
| `email` | `invalid` | not a string, or contains no `@` | `email must contain @` |
| `age` | `not_an_integer` | present and not an integer | `age must be a whole number` |
| `age` | `too_young` | present and below 13 | `age must be at least 13` |
| `age` | `too_old` | present and above 130 | `age must be at most 130` |
| `role` | `unknown` | present and not `admin`, `editor` or `viewer` | `role must be admin, editor or viewer` |

`age` and `role` are optional: absent means valid. Unknown extra fields are
ignored. A valid user gives `[]`.
