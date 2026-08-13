// Runtime globals reached through `globalThis` — `types: []` in the build
// means a runtime-provided global is typed structurally rather than
// inherited from `@types/node` (AGENTS.md, "Two tsconfigs"). A copy of
// `../embed/timers.ts`'s microtask half plus a monotonic clock, and
// deliberately a copy: importing another component's private module makes
// the two one bundle unit.
interface ChartGlobals {
  queueMicrotask?(fn: () => void): void;
  performance?: { now(): number };
}

const g = globalThis as ChartGlobals;

/** Off the current stack — how paint reports stats without re-entering
 * React from inside a frame. */
export function microtask(fn: () => void): void {
  if (g.queueMicrotask) g.queueMicrotask(fn);
  else void Promise.resolve().then(fn);
}

/** Milliseconds, monotonic where the runtime has it. */
export function now(): number {
  return g.performance ? g.performance.now() : Date.now();
}
