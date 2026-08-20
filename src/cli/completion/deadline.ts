export function withDeadline(ms = 300): {
  signal: AbortSignal;
  remaining(): number;
  dispose(): void;
} {
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref();
  return {
    signal: controller.signal,
    remaining: () => Math.max(1, ms - (Date.now() - started)),
    dispose: () => clearTimeout(timer),
  };
}
