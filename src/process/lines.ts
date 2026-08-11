/**
 * Incremental line splitter for streaming stdout/stderr. Chunk boundaries do
 * not respect line boundaries, so anything parsing JSONL must buffer partials.
 */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line.length > 0) onLine(line);
        index = buffer.indexOf('\n');
      }
    },
    flush(): void {
      const rest = buffer.replace(/\r$/, '');
      buffer = '';
      if (rest.length > 0) onLine(rest);
    },
  };
}

/**
 * Parses a JSONL line, returning `undefined` for anything that is not an
 * object. CLIs interleave human-readable banners with their JSON stream, so a
 * non-parsing line is expected traffic rather than an error.
 */
export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
