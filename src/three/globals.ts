// Host globals, reached through `globalThis` — the build compiles `src/`
// with `types: []` on purpose, so a Node global that wanders in fails the
// build rather than becoming an implicit `@types/node` dependency
// (AGENTS.md). Same shape as `../internal/timers.ts`.
interface HostGlobals {
  console?: { warn(...args: unknown[]): void };
  performance?: { now(): number };
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
  queueMicrotask?(fn: () => void): void;
}

const g = globalThis as HostGlobals;

export function warn(message: string): void {
  g.console?.warn(message);
}

/** Milliseconds, monotonic where the host has a monotonic clock. */
export function now(): number {
  return g.performance?.now() ?? Date.now();
}

export const scheduleTimeout = (fn: () => void, ms: number): unknown =>
  g.setTimeout ? g.setTimeout(fn, ms) : null;

export const cancelTimeout = (id: unknown): void => {
  if (id !== null) g.clearTimeout?.(id);
};

export const scheduleMicrotask = (fn: () => void): void => {
  if (g.queueMicrotask) g.queueMicrotask(fn);
  else Promise.resolve().then(fn);
};
