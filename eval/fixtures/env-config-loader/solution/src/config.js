/**
 * Reference solution. Never copied into a run — `relay eval --check-fixtures`
 * applies it to prove the hidden suite can be satisfied.
 */

export class ConfigError extends Error {
  constructor(problems) {
    super(['invalid configuration:', ...problems.map((problem) => `  - ${problem}`)].join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const BOOLEANS = new Map([
  ['1', true],
  ['true', true],
  ['yes', true],
  ['on', true],
  ['0', false],
  ['false', false],
  ['no', false],
  ['off', false],
]);

export function loadConfig(schema, env = process.env) {
  const result = {};
  // Collected rather than thrown one at a time: a deploy should learn about
  // every missing variable in one go, not across three attempts.
  const problems = [];

  for (const [key, spec] of Object.entries(schema)) {
    const raw = env[spec.env];
    const text = typeof raw === 'string' ? raw.trim() : undefined;

    if (text === undefined || text.length === 0) {
      if (spec.default !== undefined) result[key] = spec.default;
      else if (spec.required === true) problems.push(`${key}: ${spec.env} is required`);
      else result[key] = undefined;
      continue;
    }

    const type = spec.type ?? 'string';
    let value;

    if (type === 'string') {
      value = text;
    } else if (type === 'number' || type === 'integer') {
      const parsed = Number(text);
      const ok = type === 'integer' ? Number.isInteger(parsed) : Number.isFinite(parsed);
      if (!ok) {
        problems.push(`${key}: ${spec.env} must be ${type === 'integer' ? 'an integer' : 'a number'}, got "${text}"`);
        continue;
      }
      value = parsed;
    } else if (type === 'boolean') {
      const parsed = BOOLEANS.get(text.toLowerCase());
      if (parsed === undefined) {
        problems.push(`${key}: ${spec.env} must be a boolean, got "${text}"`);
        continue;
      }
      value = parsed;
    } else if (type === 'list') {
      value = text
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    } else {
      problems.push(`${key}: unknown type "${type}"`);
      continue;
    }

    if (spec.values !== undefined) {
      const candidates = Array.isArray(value) ? value : [value];
      const rejected = candidates.filter((candidate) => !spec.values.includes(candidate));
      if (rejected.length > 0) {
        problems.push(`${key}: ${spec.env} must be one of ${spec.values.join(', ')}, got "${rejected.join(', ')}"`);
        continue;
      }
    }

    result[key] = value;
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return result;
}
