// Timers, reached through `globalThis`. The build compiles `src/` with
// `types: []` on purpose — a Node global that wanders in must fail the
// build rather than become an implicit `@types/node` dependency (AGENTS.md)
// — so the runtime-provided timers are typed here, structurally, once.
interface TimerGlobals {
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(id: unknown): void;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
  queueMicrotask?(fn: () => void): void;
}

const g = globalThis as TimerGlobals;

export type TimerId = unknown;

export function startInterval(fn: () => void, ms: number): TimerId {
  return g.setInterval?.(fn, ms) ?? null;
}

export function stopInterval(id: TimerId): void {
  if (id != null) g.clearInterval?.(id);
}

export function startTimeout(fn: () => void, ms: number): TimerId {
  return g.setTimeout?.(fn, ms) ?? null;
}

export function stopTimeout(id: TimerId): void {
  if (id != null) g.clearTimeout?.(id);
}

export function microtask(fn: () => void): void {
  if (g.queueMicrotask) g.queueMicrotask(fn);
  else void Promise.resolve().then(fn);
}
