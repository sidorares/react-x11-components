// Timers, reached through `globalThis` — the build compiles `src/` with
// `types: []`, so a runtime-provided global has to be typed structurally
// rather than inherited from `@types/node` (AGENTS.md, "Two tsconfigs").
//
// A near-copy of `../code-language/timers.ts`, and deliberately a copy: a
// shared module reaching into another shared module's private file would make
// the two one unit for a bundler, which is the same rule that stops one
// component importing another. Thirty lines is the cheaper side of that
// trade.
interface TimerGlobals {
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
}

const g = globalThis as TimerGlobals;

export type TimerId = unknown;

export function startTimeout(fn: () => void, ms: number): TimerId {
  return g.setTimeout?.(fn, ms) ?? null;
}

export function stopTimeout(id: TimerId): void {
  if (id != null) g.clearTimeout?.(id);
}

/** `await delay(50)` — the polling half of `connectWhenReady`. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (!startTimeout(() => resolve(), ms)) resolve();
  });
}
