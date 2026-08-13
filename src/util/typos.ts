/**
 * Typos, on purpose.
 *
 * `relay run <issue> --tuff` asks for a run whose written output reads like a
 * person typing at speed rather than a machine emitting prose: the pull request,
 * the commit messages, and the comments the agents leave in the code all carry
 * the ordinary mistakes a human leaves behind.
 *
 * The rule that makes that safe is that a typo is only ever allowed in prose.
 * Anything a machine reads back — a path, a URL, a fenced block, an inline code
 * span, a trailer key, `Closes #142` — is left byte-for-byte alone, because a
 * mistyped issue reference does not look human, it looks broken.
 *
 * The transform is deterministic: the same text and seed produce the same
 * typos every time, so re-running delivery for a run does not quietly rewrite
 * the pull request it already opened.
 */

/** Misspellings people actually make, which read better than a random slip. */
const MISSPELLINGS: Record<string, string> = {
  the: 'teh',
  and: 'adn',
  that: 'taht',
  this: 'tihs',
  they: 'tehy',
  their: 'thier',
  there: 'ther',
  with: 'wiht',
  which: 'whcih',
  would: 'woudl',
  should: 'shoud',
  about: 'abuot',
  because: 'becuase',
  before: 'befoer',
  receive: 'recieve',
  separate: 'seperate',
  definitely: 'definately',
  necessary: 'neccessary',
  occurred: 'occured',
  existing: 'exisiting',
  against: 'agaisnt',
  review: 'reivew',
  reviewed: 'reveiwed',
  reviewer: 'reivewer',
  tests: 'tets',
  test: 'tets',
  function: 'funtion',
  functions: 'funtions',
  return: 'retrun',
  returns: 'retruns',
  through: 'throught',
  implementation: 'implementaiton',
  implemented: 'implmented',
  changes: 'chagnes',
  change: 'chagne',
  branch: 'brnach',
  commit: 'comit',
  tough: 'tuff',
};

/**
 * Words a typo would break rather than humanize: GitHub's own keywords, the
 * names of the tools involved, and anything that is really an identifier.
 */
const KEEP = new Set([
  'close',
  'closed',
  'closes',
  'fix',
  'fixed',
  'fixes',
  'resolve',
  'resolved',
  'resolves',
  'refs',
  'relay',
  'github',
  'claude',
  'codex',
  'http',
  'https',
  'true',
  'false',
  'null',
]);

/** Keys next to each other, for the slip of hitting the wrong one. */
const NEIGHBOURS: Record<string, string> = {
  a: 's',
  b: 'v',
  c: 'x',
  d: 's',
  e: 'r',
  f: 'g',
  g: 'f',
  h: 'j',
  i: 'o',
  j: 'k',
  k: 'l',
  l: 'k',
  m: 'n',
  n: 'm',
  o: 'i',
  p: 'o',
  r: 't',
  s: 'a',
  t: 'r',
  u: 'i',
  v: 'b',
  w: 'e',
  y: 'u',
};

/** A word, with whatever punctuation it is wearing. */
const ATOM = /^([^A-Za-z]*)([A-Za-z]+)([^A-Za-z]*)$/;

export interface TypoOptions {
  /** Makes the same text mistype the same way every time. */
  seed?: string;
  /** Roughly one eligible word in this many is mistyped. Minimum 2. */
  rate?: number;
}

/**
 * Rewrites the prose in `text` with human typos, leaving every machine-read
 * part of it untouched.
 */
export function typoize(text: string, options: TypoOptions = {}): string {
  const rate = Math.max(2, Math.trunc(options.rate ?? 9));
  const seed = options.seed ?? '';

  let fenced = false;
  let eligible = 0;

  const rewriteWord = (core: string): string => {
    // The counter advances for every candidate, not only the ones that change,
    // so density stays even across a long body instead of clustering.
    const position = eligible++;
    const roll = hash(`${seed}:${position}:${core.toLowerCase()}`);
    if (roll % rate !== 0) return core;
    return mistype(core, roll);
  };

  const rewriteLine = (line: string): string => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    // A fenced block, an indented code block, and a trailer line are all read
    // by something other than a person.
    if (fenced || /^ {4,}\S/.test(line) || /^[A-Za-z][A-Za-z-]*:\s/.test(line)) return line;

    // Odd segments are inline code spans: `--tuff` must survive as `--tuff`.
    return line
      .split('`')
      .map((segment, index) => (index % 2 === 1 ? segment : rewriteSegment(segment, rewriteWord)))
      .join('`');
  };

  return text.split('\n').map(rewriteLine).join('\n');
}

function rewriteSegment(segment: string, rewriteWord: (core: string) => string): string {
  return segment
    .split(/(\s+)/)
    .map((atom) => {
      if (atom.length === 0 || /^\s+$/.test(atom)) return atom;

      const parts = ATOM.exec(atom);
      // Anything with letters welded to punctuation — `src/app.ts`, `#142`,
      // `relay/142-aaa111`, a URL — fails this and is left alone.
      if (parts === null) return atom;

      const [, prefix = '', core = '', suffix = ''] = parts;
      if (!isProse(core)) return atom;

      return `${prefix}${preserveCase(core, rewriteWord(core.toLowerCase()))}${suffix}`;
    })
    .join('');
}

/**
 * Whether a word is prose rather than an identifier. Anything with an interior
 * capital (`runId`, `BLOCKING`) is something the code or the protocol named, and
 * a name that no longer matches is a bug rather than a typo.
 */
function isProse(core: string): boolean {
  if (core.length < 4) return false;
  if (core.slice(1) !== core.slice(1).toLowerCase()) return false;
  return !KEEP.has(core.toLowerCase());
}

/** One mistake, chosen from the hash so the same word slips the same way. */
function mistype(core: string, roll: number): string {
  const known = MISSPELLINGS[core];
  if (known !== undefined) return known;

  // The first letter is left alone: people fumble the middle of a word far more
  // often than its start, and the result stays readable.
  const at = 1 + (roll % (core.length - 2));
  const letter = core[at] ?? '';

  switch (roll % 4) {
    case 0: {
      // Transposed pair, the commonest slip there is.
      const next = core[at + 1] ?? '';
      return `${core.slice(0, at)}${next}${letter}${core.slice(at + 2)}`;
    }
    case 1:
      return `${core.slice(0, at)}${core.slice(at + 1)}`;
    case 2:
      return `${core.slice(0, at)}${letter}${core.slice(at)}`;
    default:
      return `${core.slice(0, at)}${NEIGHBOURS[letter] ?? letter}${core.slice(at + 1)}`;
  }
}

/** Keeps `Implemented` capitalized after it becomes `Implmented`. */
function preserveCase(original: string, rewritten: string): string {
  if (original[0] === original[0]?.toLowerCase()) return rewritten;
  return `${rewritten.charAt(0).toUpperCase()}${rewritten.slice(1)}`;
}

/** FNV-1a. Deterministic, dependency-free, and good enough to pick a typo. */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}
