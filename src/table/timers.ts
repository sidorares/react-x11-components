// "Run this once layout has happened", reached through `globalThis`.
//
// **Vendored from `../tree/timers.ts`** — a component must not import
// another component, and the shared-module promotion is scheduled rather
// than done (docs/prd-table.md, M2). Delete both copies when it lands.
//
// The build compiles `src/` with `types: []` on purpose — a Node global that
// wanders in must fail the build rather than become an implicit
// `@types/node` dependency (AGENTS.md) — so the one timer this component
// needs is typed here, structurally, the way `../code-language/timers.ts`
// does it.
//
// **Why a tick and not an effect.** react-x11 lays out on a frame flush, not
// in the commit, so a `useLayoutEffect` or a `useEffect` reads the geometry of
// the *previous* pass: on the render that created a row, `node.abs.height` is
// still 0. A macrotask scheduled from an effect lands after the flush, which
// is the first moment a row can be asked how tall it turned out to be.
interface Deferred {
  setImmediate?(fn: () => void): unknown;
  clearImmediate?(id: unknown): void;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
}

const g = globalThis as Deferred;

export type LayoutTick = { immediate: boolean; id: unknown } | null;

/** Run `fn` after the layout pass this commit will cause. */
export function afterLayout(fn: () => void): LayoutTick {
  // `setImmediate` is the check-phase callback, which runs after the frame
  // work node has already queued. `setTimeout(0)` is the fallback for a host
  // that has no `setImmediate` — a browser-shaped global object, or a
  // stripped-down runtime — and lands in the same place for this purpose.
  if (g.setImmediate) return { immediate: true, id: g.setImmediate(fn) };
  if (g.setTimeout) return { immediate: false, id: g.setTimeout(fn, 0) };
  return null;
}

export function cancelAfterLayout(tick: LayoutTick): void {
  if (!tick) return;
  if (tick.immediate) g.clearImmediate?.(tick.id);
  else g.clearTimeout?.(tick.id);
}
