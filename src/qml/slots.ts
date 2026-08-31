// The reactive core: slots, dependency tracking, batched invalidation.
//
// One Slot per QML property. A slot holds a *base* layer — a plain value or
// a binding (a compiled function re-run when anything it read changes) —
// and, above it, a stack of *override* layers. Overrides are how `states`
// (`PropertyChanges`) and the `Binding` element sit on top of a document's
// own bindings without destroying them: push on entry, pop on exit, and the
// base — still tracked while covered — is current the moment it shows again.
//
// Assignment replaces the active layer's binding with the value — QML's
// binding-breaking semantics, load-bearing for fidelity and pinned in
// test/qml.test.ts.
//
// Granularity is the point of this file: a property change re-renders only
// the React component wrapping that one QML object (each subscribes to its
// object via useSyncExternalStore). React reconciliation is reserved for
// structural change; scalar traffic — animation, dragging — stays in the
// graph.

import { microtask } from './globals.js';

export type BindingFn = () => unknown;

export interface SlotOwner {
  _changed?(slot: Slot): void;
}

interface Layer {
  binding: BindingFn | null;
  value: unknown;
  deps: Set<Slot> | null;
  /** Which state/Binding pushed this override; how it is popped. */
  owner: unknown;
}

let activeDeps: Set<Slot> | null = null; // collected during a binding eval
let flushQueue: Set<Slot> | null = null;
let flushScheduled = false;
const pendingNotify = new Set<() => void>();

export function trackedEval<T>(fn: () => T): { value: T; deps: Set<Slot> } {
  const prev = activeDeps;
  activeDeps = new Set();
  try {
    const value = fn();
    return { value, deps: activeDeps };
  } finally {
    activeDeps = prev;
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  microtask(flushBindings);
}

export function flushBindings(): void {
  flushScheduled = false;
  // Re-evaluate dirty bindings, then run watchers — and keep going while
  // either creates more work, so a watcher that assigns (a `when` clause
  // switching states, a positioner re-pinning) settles in this flush
  // rather than a later microtask.
  for (let guard = 0; ; guard++) {
    if (guard > 200) throw new Error('QML binding loop did not settle');
    if (flushQueue && flushQueue.size) {
      const batch = flushQueue;
      flushQueue = null;
      for (const slot of batch) slot._reevaluate();
      continue;
    }
    if (pendingNotify.size) {
      const toNotify = [...pendingNotify];
      pendingNotify.clear();
      for (const fn of toNotify) fn();
      continue;
    }
    return;
  }
}

export class Slot {
  owner: SlotOwner | null;
  name: string;
  /** The current effective value — the top layer's answer, cached. */
  value: unknown;
  private base: Layer;
  private overrides: Layer[] = [];
  subscribers: Set<Slot> | null = null; // slots whose bindings read this one
  watchers: Set<() => void> | null = null; // onXChanged, React, positioners
  /** True while the implicit `width ← implicitWidth` default binding holds
   * (Qt's `widthValid`): the renderer may size the element by content. */
  isDefault = false;
  /** True once assigned at runtime — interactive state, carried across
   * hot reloads. */
  userSet = false;
  lastError: unknown = null;

  constructor(owner: SlotOwner | null, name: string, value: unknown) {
    this.owner = owner;
    this.name = name;
    this.value = value;
    this.base = { binding: null, value, deps: null, owner: null };
  }

  get(): unknown {
    if (activeDeps) activeDeps.add(this);
    return this.value;
  }

  peek(): unknown {
    return this.value;
  }

  hasBinding(): boolean {
    return this.base.binding !== null;
  }

  private active(): Layer {
    return this.overrides.length
      ? this.overrides[this.overrides.length - 1]
      : this.base;
  }

  /** Imperative assignment: breaks the active layer's binding. */
  set(value: unknown): void {
    this.userSet = true;
    this.assign(value);
  }

  /** Activation-time write (literals, model context): breaks the binding
   * but is not user state — hot-reload migration must not preserve it. */
  assign(value: unknown): void {
    const layer = this.active();
    this._dropLayerBinding(layer);
    if (layer === this.base) this.isDefault = false;
    layer.value = value;
    this._settle();
  }

  setBinding(fn: BindingFn, { isDefault = false } = {}): void {
    this._dropLayerBinding(this.base);
    this.isDefault = isDefault;
    this.base.binding = fn;
    this._evaluateLayer(this.base);
    this._settle();
  }

  /**
   * States and the `Binding` element: sit a value or binding above the
   * base. The base keeps evaluating underneath, so popping is instant and
   * exact. `owner` is the pop token.
   */
  pushOverride(
    owner: unknown,
    init: { binding?: BindingFn; value?: unknown },
  ): void {
    const layer: Layer = {
      binding: init.binding ?? null,
      value: init.value,
      deps: null,
      owner,
    };
    this.overrides.push(layer);
    if (layer.binding) this._evaluateLayer(layer);
    this._settle();
  }

  popOverride(owner: unknown): void {
    for (let i = this.overrides.length - 1; i >= 0; i--) {
      if (this.overrides[i].owner === owner) {
        this._dropLayerBinding(this.overrides[i]);
        this.overrides.splice(i, 1);
      }
    }
    this._settle();
  }

  private _dropLayerBinding(layer: Layer): void {
    if (layer.deps) {
      for (const dep of layer.deps) dep.subscribers?.delete(this);
      layer.deps = null;
    }
    layer.binding = null;
  }

  private _evaluateLayer(layer: Layer): void {
    if (!layer.binding) return;
    const { value, deps } = trackedEval(layer.binding);
    if (layer.deps) for (const dep of layer.deps) dep.subscribers?.delete(this);
    layer.deps = deps;
    for (const dep of deps) (dep.subscribers ??= new Set()).add(this);
    layer.value = value;
  }

  /** A dependency changed: re-evaluate every bound layer, then settle. */
  _reevaluate(): void {
    if (this.base.binding) this._evaluateLayer(this.base);
    for (const layer of this.overrides) {
      if (layer.binding) this._evaluateLayer(layer);
    }
    this._settle();
  }

  private _settle(): void {
    const effective = this.active().value;
    if (Object.is(effective, this.value)) return;
    this.value = effective;
    if (this.subscribers) {
      flushQueue ??= new Set();
      for (const sub of this.subscribers) flushQueue.add(sub);
      scheduleFlush();
    }
    if (this.watchers) {
      for (const w of this.watchers) pendingNotify.add(w);
      scheduleFlush();
    }
    this.owner?._changed?.(this);
  }

  /**
   * Layout read-back: reflect an externally computed value — yoga's answer
   * for a Layout-managed item — into the slot without disturbing its
   * binding, default or user flags. A later binding evaluation may
   * overwrite it; the next layout pass reflects again. Expressions reading
   * the slot see the laid-out number either way.
   */
  reflect(value: unknown): void {
    const layer = this.overrides.length
      ? this.overrides[this.overrides.length - 1]
      : this.base;
    if (Object.is(layer.value, value) && Object.is(this.value, value)) return;
    layer.value = value;
    this._settle();
  }

  watch(fn: () => void): () => void {
    (this.watchers ??= new Set()).add(fn);
    return () => this.watchers?.delete(fn);
  }

  destroy(): void {
    this._dropLayerBinding(this.base);
    for (const layer of this.overrides) this._dropLayerBinding(layer);
    this.overrides.length = 0;
    this.watchers = null;
    this.subscribers = null;
  }
}
