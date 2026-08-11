/**
 * Agents exchange engineering artifacts, not chat. Each artifact is wrapped in
 * an explicit delimiter so Relay can extract it deterministically:
 *
 *   ===RELAY:BEGIN PLAN===
 *   ...markdown...
 *   ===RELAY:END PLAN===
 *
 * Delimiters beat JSON-escaping a whole markdown document (models reliably
 * break long escaped strings) and beat prose parsing (which guesses). Small
 * structured payloads — reviews, finding responses — are JSON *inside* a
 * section, so they get both robustness and schema validation.
 */
export const SECTION_NAMES = ['PLAN', 'REVIEW', 'RESPONSES', 'NOTES', 'SUMMARY'] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export function beginMarker(name: SectionName): string {
  return `===RELAY:BEGIN ${name}===`;
}

export function endMarker(name: SectionName): string {
  return `===RELAY:END ${name}===`;
}

/** The instruction block appended to prompts that require a section. */
export function sectionInstruction(name: SectionName, description: string): string {
  return [
    `Emit your ${name.toLowerCase()} inside these exact markers, with nothing else between them:`,
    '',
    beginMarker(name),
    description,
    endMarker(name),
  ].join('\n');
}

/**
 * Extracts a delimited section, degrading gracefully:
 *   1. exact begin/end markers
 *   2. begin marker with a missing end marker (agent truncated the closer)
 *   3. undefined — the caller decides whether to retry or fall back
 */
export function extractSection(text: string, name: SectionName): string | undefined {
  const begin = beginMarker(name);
  const end = endMarker(name);

  const startIndex = text.indexOf(begin);
  if (startIndex === -1) return undefined;

  const contentStart = startIndex + begin.length;
  const endIndex = text.indexOf(end, contentStart);

  const body = endIndex === -1 ? text.slice(contentStart) : text.slice(contentStart, endIndex);
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Pulls a JSON object out of agent output. Tries, in order: a delimited
 * section, a fenced ```json block, then the outermost balanced braces.
 * Agent output is untrusted, so every path ends in a real JSON.parse.
 */
export function extractJson(text: string, name?: SectionName): unknown {
  const candidates: string[] = [];

  if (name !== undefined) {
    const section = extractSection(text, name);
    if (section !== undefined) candidates.push(section);
  }

  for (const match of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
    const block = match[1];
    if (block !== undefined) candidates.push(block);
  }

  candidates.push(text);

  for (const candidate of candidates) {
    const parsed = parseJsonLoose(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseJsonLoose(candidate: string): unknown {
  const trimmed = stripFences(candidate).trim();
  if (trimmed.length === 0) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace matching
  }

  const start = trimmed.indexOf('{');
  if (start === -1) return undefined;

  // Scan for the matching close brace, ignoring braces inside strings.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function stripFences(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '');
}
