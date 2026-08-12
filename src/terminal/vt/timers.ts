// Timers, reached through `globalThis` — `types: []` in the build means a
// runtime-provided global is typed structurally rather than inherited from
// `@types/node` (AGENTS.md, "Two tsconfigs").
//
// A copy of `../../embed/timers.ts` with the interval half added, and
// deliberately a copy for the reason that file gives: a module reaching into
// another module's private file makes the two one unit for a bundler. Thirty
// lines is the cheaper side of the trade.
interface TimerGlobals {
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(id: unknown): void;
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

/** Off the current stack — how paint tells React that the grid resized. */
export function microtask(fn: () => void): void {
  if (g.queueMicrotask) g.queueMicrotask(fn);
  else void Promise.resolve().then(fn);
}
