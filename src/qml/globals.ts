// Host globals, reached structurally through `globalThis`. The build
// compiles `src/` with `types: []` on purpose — a Node global that wanders
// in must fail the build rather than become an implicit `@types/node`
// dependency (AGENTS.md) — so the few platform facilities the QML runtime
// needs are typed here, the way `charts/timers.ts` and `three/globals.ts`
// do it.

interface HostGlobals {
  queueMicrotask?(fn: () => void): void;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
  console?: { warn(...args: unknown[]): void };
}

const g = globalThis as HostGlobals;

export function microtask(fn: () => void): void {
  if (g.queueMicrotask) g.queueMicrotask(fn);
  else void Promise.resolve().then(fn);
}

/** `Timer { interval: … }` — null when the host has no timer at all. */
export function schedule(fn: () => void, ms: number): unknown {
  return g.setTimeout ? g.setTimeout(fn, ms) : null;
}

export function cancel(id: unknown): void {
  if (id != null) g.clearTimeout?.(id);
}

export function warn(...args: unknown[]): void {
  g.console?.warn(...args);
}
