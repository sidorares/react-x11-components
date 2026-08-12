// Timers, reached through `globalThis` — the build compiles `src/` with
// `types: []`, so a runtime-provided global has to be typed structurally
// rather than inherited from `@types/node` (AGENTS.md, "Two tsconfigs").
//
// A near-copy of `../embed/timers.ts`, and deliberately a copy: this
// component importing another module's private file would make the two one
// unit for a bundler, which is the same rule that stops one component
// importing another.
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
