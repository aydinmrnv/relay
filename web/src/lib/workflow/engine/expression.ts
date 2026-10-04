/**
 * What a Condition and a Filter decide, for a test run and a real one alike.
 *
 * This file is shared. The studio keeps a byte-for-byte copy at
 * `web/src/lib/workflow/engine/expression.ts` (`npm run sync:studio` writes
 * it, and a test in each package fails when the two differ), so a test run
 * can never take a branch a real run would not. It imports nothing, on
 * purpose: it has to load in a browser and under Node 22.6 unchanged.
 */

/** `{{a.b.c}}` in a context: the value at that path, or undefined. */
export function lookup(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * `{{a.b.c}}` substitution. Arrays join with ", ", objects become JSON, and an
 * unknown path renders as an empty string rather than leaking the braces.
 */
export function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}/g, (_match, path: string) => {
    const value = lookup(context, path);
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map(String).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/** The operators a Condition node offers. */
export type ConditionOp = 'contains' | 'equals' | 'not-equals' | 'gt' | 'lt' | 'matches';

/** A Condition node: the rendered field against the value somebody typed. */
export function evaluateCondition(left: string, op: string, right: string): boolean {
  // A field with no value satisfies nothing: `Number('')` is 0, which would make "under 3" true of every ticket.
  if (left.trim().length === 0) return op === 'not-equals' && right.trim().length > 0;
  const l = left.toLowerCase();
  const r = right.toLowerCase();
  switch (op) {
    case 'contains':
      return l.includes(r);
    case 'equals':
      return l === r;
    case 'not-equals':
      return l !== r;
    case 'gt':
      return Number(left) > Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'matches':
      try {
        return new RegExp(right, 'i').test(left);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* Filter expressions                                                  */
/* ------------------------------------------------------------------ */

/**
 * A Filter's expression: `issue.estimate <= 3`, `issue.labels contains "bug"
 * && !(issue.title matches "^wip")`.
 *
 * A small language rather than JavaScript, because the text comes from a
 * canvas anybody with the share link can remix, and it runs on a machine that
 * holds sign-ins. There is nothing here to call: paths read the run's
 * context, literals are numbers, quoted strings, `true`, `false` and `null`,
 * and the operators are `==  !=  <  <=  >  >=  contains  matches  in`, with
 * `!`, `&&`, `||` and parentheses. A path with no value is `null`, and a
 * comparison against `null` is false rather than an error, so a missing field
 * closes the filter instead of opening it.
 */
export type FilterResult = { ok: true; value: boolean } | { ok: false; error: string };

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'end' };

const WORD_OPERATORS = new Set(['contains', 'matches', 'in']);
const SYMBOL_OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '!', '(', ')', '[', ']', ','];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at]!;
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = at + 1;
      let text = '';
      while (end < source.length && source[end] !== char) {
        if (source[end] === '\\' && end + 1 < source.length) end += 1;
        text += source[end];
        end += 1;
      }
      if (end >= source.length) throw new Error(`a string that starts at character ${at + 1} is never closed`);
      tokens.push({ kind: 'string', value: text });
      at = end + 1;
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?/.exec(source.slice(at));
    // A minus sign is part of a number only where a value may start.
    const previous = tokens.at(-1);
    const valueMayStart = previous === undefined || (previous.kind === 'op' && previous.value !== ')' && previous.value !== ']');
    if (number !== null && (char !== '-' || valueMayStart)) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      at += number[0].length;
      continue;
    }
    const symbol = SYMBOL_OPERATORS.find((candidate) => source.startsWith(candidate, at));
    if (symbol !== undefined) {
      tokens.push({ kind: 'op', value: symbol });
      at += symbol.length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*/.exec(source.slice(at));
    if (word !== null) {
      const text = word[0];
      if (WORD_OPERATORS.has(text)) tokens.push({ kind: 'op', value: text });
      else if (text === 'and') tokens.push({ kind: 'op', value: '&&' });
      else if (text === 'or') tokens.push({ kind: 'op', value: '||' });
      else if (text === 'not') tokens.push({ kind: 'op', value: '!' });
      else tokens.push({ kind: 'path', value: text });
      at += text.length;
      continue;
    }
    throw new Error(`“${char}” at character ${at + 1} is not something an expression can contain`);
  }
  tokens.push({ kind: 'end' });
  return tokens;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0 && value.trim().toLowerCase() !== 'false';
  return Boolean(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim().length > 0) {
    // "$2.14" is how a run states its cost; the number is what a filter means.
    const parsed = Number(value.trim().replace(/^\$/, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function same(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return (left ?? null) === (right ?? null);
  if (typeof left === 'boolean' || typeof right === 'boolean') return truthy(left) === truthy(right);
  const l = asNumber(left);
  const r = asNumber(right);
  if (l !== null && r !== null) return l === r;
  return String(left).trim().toLowerCase() === String(right).trim().toLowerCase();
}

function compare(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case '==':
      return same(left, right);
    case '!=':
      return !same(left, right);
    case 'contains': {
      if (left === null || left === undefined || right === null || right === undefined) return false;
      if (Array.isArray(left)) return left.some((item) => same(item, right));
      return String(left).toLowerCase().includes(String(right).toLowerCase());
    }
    case 'in': {
      if (left === null || left === undefined) return false;
      if (Array.isArray(right)) return right.some((item) => same(item, left));
      return right !== null && right !== undefined && String(right).toLowerCase().includes(String(left).toLowerCase());
    }
    case 'matches': {
      if (left === null || left === undefined) return false;
      const text = Array.isArray(left) ? left.map(String).join(', ') : String(left);
      return new RegExp(String(right ?? ''), 'i').test(text);
    }
    default: {
      // An ordering needs two numbers. Anything else is not "less than" anything.
      const l = asNumber(left);
      const r = asNumber(right);
      if (l === null || r === null) return false;
      return op === '<' ? l < r : op === '<=' ? l <= r : op === '>' ? l > r : l >= r;
    }
  }
}

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=', 'contains', 'matches', 'in']);

export function evaluateFilter(expression: string, context: Record<string, unknown>): FilterResult {
  const source = expression.trim();
  // An empty expression filters nothing, which is what an untouched node should do.
  if (source.length === 0) return { ok: true, value: true };

  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let at = 0;
  const peek = (): Token => tokens[at]!;
  const take = (): Token => tokens[at++]!;
  const isOp = (value: string): boolean => {
    const token = peek();
    return token.kind === 'op' && token.value === value;
  };

  const value = (): unknown => {
    const token = take();
    switch (token.kind) {
      case 'number':
      case 'string':
        return token.value;
      case 'path':
        if (token.value === 'true') return true;
        if (token.value === 'false') return false;
        if (token.value === 'null') return null;
        return lookup(context, token.value) ?? null;
      case 'op':
        if (token.value === '(') {
          const inner = or();
          if (!isOp(')')) throw new Error('a “(” is never closed');
          take();
          return inner;
        }
        if (token.value === '[') {
          const items: unknown[] = [];
          while (!isOp(']')) {
            items.push(value());
            if (isOp(',')) take();
            else if (!isOp(']')) throw new Error('a list needs “,” between its items and “]” at its end');
          }
          take();
          return items;
        }
        throw new Error(`“${token.value}” is where a value should be`);
      case 'end':
        throw new Error('the expression ends where a value should be');
    }
  };
  const comparison = (): unknown => {
    const left = value();
    const token = peek();
    if (token.kind !== 'op' || !COMPARISONS.has(token.value)) return left;
    take();
    return compare(token.value, left, value());
  };
  const not = (): unknown => {
    if (!isOp('!')) return comparison();
    take();
    return !truthy(not());
  };
  const and = (): unknown => {
    let left = not();
    while (isOp('&&')) {
      take();
      const right = not();
      left = truthy(left) && truthy(right);
    }
    return left;
  };
  const or = (): unknown => {
    let left = and();
    while (isOp('||')) {
      take();
      const right = and();
      left = truthy(left) || truthy(right);
    }
    return left;
  };

  try {
    const result = or();
    const rest = peek();
    if (rest.kind !== 'end') throw new Error(`“${rest.kind === 'op' || rest.kind === 'path' ? rest.value : String(rest.value)}” is left over after the expression ends`);
    return { ok: true, value: truthy(result) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
