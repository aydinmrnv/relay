/** Checks a user record before it is written. */

const ROLES = ['admin', 'editor', 'viewer'];

export function validate(user) {
  const problems = [];

  if (typeof user.name !== 'string' || user.name.trim().length === 0) {
    problems.push({ field: 'name', code: 'required', message: 'name is required' });
  } else if (user.name.trim().length > 40) {
    problems.push({ field: 'name', code: 'too_long', message: 'name must be 40 characters or fewer' });
  }

  if (typeof user.email !== 'string' || !user.email.includes('@')) {
    problems.push({ field: 'email', code: 'invalid', message: 'email must contain @' });
  }

  if (user.age !== undefined) {
    if (!Number.isInteger(user.age)) {
      problems.push({ field: 'age', code: 'not_an_integer', message: 'age must be a whole number' });
    } else if (user.age < 13) {
      problems.push({ field: 'age', code: 'too_young', message: 'age must be at least 13' });
    } else if (user.age > 130) {
      problems.push({ field: 'age', code: 'too_old', message: 'age must be at most 130' });
    }
  }

  if (user.role !== undefined && !ROLES.includes(user.role)) {
    problems.push({ field: 'role', code: 'unknown', message: 'role must be admin, editor or viewer' });
  }

  return problems;
}
