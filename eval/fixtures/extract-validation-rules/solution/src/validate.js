/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

const ROLES = ['admin', 'editor', 'viewer'];

const always = () => true;
const hasName = (user) => typeof user.name === 'string';
const hasAge = (user) => user.age !== undefined;
const isInteger = (user) => Number.isInteger(user.age);

export const RULES = [
  {
    field: 'name',
    code: 'required',
    message: 'name is required',
    applies: always,
    test: (user) => hasName(user) && user.name.trim().length > 0,
  },
  {
    field: 'name',
    code: 'too_long',
    message: 'name must be 40 characters or fewer',
    applies: hasName,
    test: (user) => user.name.trim().length <= 40,
  },
  {
    field: 'email',
    code: 'invalid',
    message: 'email must contain @',
    applies: always,
    test: (user) => typeof user.email === 'string' && user.email.includes('@'),
  },
  {
    field: 'age',
    code: 'not_an_integer',
    message: 'age must be a whole number',
    applies: hasAge,
    test: isInteger,
  },
  {
    field: 'age',
    code: 'too_young',
    message: 'age must be at least 13',
    applies: hasAge,
    test: (user) => isInteger(user) && user.age >= 13,
  },
  {
    field: 'age',
    code: 'too_old',
    message: 'age must be at most 130',
    applies: hasAge,
    test: (user) => isInteger(user) && user.age <= 130,
  },
  {
    field: 'role',
    code: 'unknown',
    message: 'role must be admin, editor or viewer',
    applies: (user) => user.role !== undefined,
    test: (user) => ROLES.includes(user.role),
  },
];

export function validate(user) {
  const problems = [];
  const reported = new Set();

  for (const rule of RULES) {
    // One problem per field: the first failing rule is the useful one, and
    // the later ones are usually consequences of it.
    if (reported.has(rule.field)) continue;
    if (!rule.applies(user) || rule.test(user)) continue;

    reported.add(rule.field);
    problems.push({ field: rule.field, code: rule.code, message: rule.message });
  }

  return problems;
}
