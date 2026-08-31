// States, PropertyChanges, Transition — and the two elements that share
// their machinery, `Binding` and `Connections`.
//
// A state is an *override layer* on the target slots (slots.ts): entering
// pushes, leaving pops, and the document's own bindings keep evaluating
// underneath, so exit is exact with no bookkeeping. A `PropertyChanges`
// binding stays live while its state is active: the pushed override is a
// forwarding binding onto the PropertyChanges instance's own slot, whose
// document-scoped binding keeps re-evaluating — dependency tracking chains
// through.
//
// A `Transition`'s animations lower onto the style `transition` engine the
// way `Behavior` does: the switch commits new values with per-property
// durations, and the renderer eases. The divergence (properties jump,
// pixels ease) is the documented one.

import {
  QmlInstance,
  instanceOf,
  instantiateTemplate,
  makeHandlerFor,
  type QmlTypeDef,
  type TemplateRef,
} from './objects.js';
import { Slot, flushBindings } from './slots.js';
import { warn } from './globals.js';

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

const RESERVED_PC = new Set(['target', 'explicit', 'restoreEntryValues']);

interface StateEngine {
  token: object;
  stateInsts: QmlInstance[];
  transInsts: QmlInstance[];
  targets: Set<QmlInstance>;
  applied: Slot[];
  current: string;
}

/** Wire `states:`/`transitions:` on an Item, when the document has them. */
export function setupStates(inst: QmlInstance): void {
  const stateTpls = inst.state['templates:states'] as TemplateRef[] | undefined;
  if (!stateTpls?.length) return;
  const transTpls =
    (inst.state['templates:transitions'] as TemplateRef[] | undefined) ?? [];

  const engine: StateEngine = {
    token: {},
    stateInsts: stateTpls.map((tpl) => instantiateTemplate(tpl, inst).inst),
    transInsts: transTpls.map((tpl) => instantiateTemplate(tpl, inst).inst),
    targets: new Set([inst]),
    applied: [],
    current: '',
  };
  inst.state.stateEngine = engine;
  inst.onDestruction.push(() => {
    for (const s of engine.stateInsts) s.destroy();
    for (const t of engine.transInsts) t.destroy();
  });

  for (const st of engine.stateInsts) {
    for (const pc of propertyChangesOf(st)) {
      const target = instanceOf(pc.slot('target').peek());
      if (target) engine.targets.add(target);
    }
  }

  const stateSlot = inst.slot('state');
  const switchTo = (): void => {
    const to = String(stateSlot.peek() ?? '');
    if (to === engine.current) return;
    installTransitionDurations(engine, engine.current, to);
    for (const s of engine.applied) s.popOverride(engine.token);
    engine.applied = [];
    const st = engine.stateInsts.find(
      (s) => String(s.slot('name').peek() ?? '') === to,
    );
    if (to && !st) {
      warnOnce(
        `qml-state-${to}`,
        `QML: state '${to}' matches no State in the states list`,
      );
    }
    engine.current = to;
    if (st) {
      for (const pc of propertyChangesOf(st)) {
        const target = instanceOf(pc.slot('target').peek());
        if (!target) {
          warnOnce(
            'qml-pc-target',
            'QML: PropertyChanges without a resolvable `target` is ignored',
          );
          continue;
        }
        for (const [propName, pcSlot] of pc.slots) {
          if (RESERVED_PC.has(propName)) continue;
          const targetSlot = target.slots.get(propName);
          if (!targetSlot) {
            warnOnce(
              `qml-pc-${propName}`,
              `QML: PropertyChanges names '${propName}', which ${target.typeInfo.name} does not have`,
            );
            continue;
          }
          targetSlot.pushOverride(engine.token, {
            binding: () => pcSlot.get(),
          });
          engine.applied.push(targetSlot);
        }
      }
    }
    flushBindings();
  };
  stateSlot.watch(switchTo);

  // `when` clauses: a state that turns itself on and off.
  for (const st of engine.stateInsts) {
    const whenSlot = st.slots.get('when');
    if (!whenSlot || (!whenSlot.hasBinding() && whenSlot.peek() === undefined))
      continue;
    const name = String(st.slot('name').peek() ?? '');
    const check = (): void => {
      const active = whenSlot.peek() === true;
      const current = String(stateSlot.peek() ?? '');
      if (active && current !== name) stateSlot.assign(name);
      else if (!active && current === name) stateSlot.assign('');
    };
    whenSlot.watch(check);
    check();
  }
}

function propertyChangesOf(state: QmlInstance): QmlInstance[] {
  return state.children.filter((c) => c.typeInfo.name === 'PropertyChanges');
}

/** Pick the matching Transition and hand its per-property durations to
 * every state target; their views merge them into `style.transition`. */
function installTransitionDurations(
  engine: StateEngine,
  from: string,
  to: string,
): void {
  const matches = (v: unknown, name: string): boolean => {
    const s = String(v ?? '');
    return s === '' || s === '*' || s.split(',').some((p) => p.trim() === name);
  };
  const t = engine.transInsts.find(
    (tr) =>
      matches(tr.slot('from').peek(), from) &&
      matches(tr.slot('to').peek(), to),
  );
  const durations: Record<string, number> = {};
  if (t) {
    for (const anim of t.children) {
      if (!anim.slots.has('duration')) continue;
      const props = String(
        anim.slots.get('properties')?.peek() ||
          anim.slots.get('property')?.peek() ||
          '',
      )
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const d = num(anim.slot('duration').peek()) || 250;
      for (const p of props) durations[p] = d;
    }
  }
  for (const target of engine.targets) {
    target.state.stateTransitions = durations;
    target._changed();
  }
}

const warnedOnce = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  warn(message);
}

// --- the type definitions --------------------------------------------------

export const stateTypes: Record<string, QmlTypeDef> = {
  State: {
    nonVisual: true,
    properties: { name: { default: '' }, when: { default: undefined } },
  },
  PropertyChanges: {
    nonVisual: true,
    dynamicProperties: true,
    properties: {
      target: { default: undefined },
      explicit: { default: false },
      restoreEntryValues: { default: true },
    },
  },
  Transition: {
    nonVisual: true,
    properties: {
      from: { default: '' },
      to: { default: '' },
      reversible: { default: false },
    },
  },

  /**
   * `Binding { target: obj; property: "width"; value: expr; when: cond }` —
   * an override pushed while `when` holds, popped when it stops; the
   * target's own binding survives underneath.
   */
  Binding: {
    nonVisual: true,
    properties: {
      target: { default: undefined },
      property: { default: '' },
      value: { default: undefined },
      when: { default: true },
    },
    init(bi) {
      let current: Slot | null = null;
      const sync = (): void => {
        if (current) {
          current.popOverride(bi);
          current = null;
        }
        if (bi.destroyed) return;
        if (bi.slot('when').peek() === false) {
          flushBindings();
          return;
        }
        const target = instanceOf(bi.slot('target').peek());
        const prop = String(bi.slot('property').peek() ?? '');
        const targetSlot = target?.slots.get(prop);
        if (!target || !prop) return;
        if (!targetSlot) {
          warnOnce(
            `qml-binding-${prop}`,
            `QML: Binding names '${prop}', which ${target.typeInfo.name} does not have`,
          );
          return;
        }
        targetSlot.pushOverride(bi, { binding: () => bi.slot('value').get() });
        current = targetSlot;
        flushBindings();
      };
      bi.slot('when').watch(sync);
      bi.slot('target').watch(sync);
      bi.slot('property').watch(sync);
      bi.state.syncBinding = sync;
      sync();
    },
    dispose(bi) {
      (bi.state.syncBinding as (() => void) | undefined)?.();
    },
  },

  /**
   * `Connections { target: id; function onClicked(mouse) { … } }` — both
   * the function form and the old `onClicked:` handler form; handlers are
   * compiled in the Connections scope and subscribed to the target.
   */
  Connections: {
    nonVisual: true,
    deferHandlers: true,
    properties: {
      target: { default: undefined },
      enabled: { default: true },
      ignoreUnknownSignals: { default: false },
    },
    init(ci) {
      let offs: Array<() => void> = [];
      const wire = (): void => {
        for (const off of offs) off();
        offs = [];
        if (ci.destroyed || ci.slot('enabled').peek() === false) return;
        const target = instanceOf(ci.slot('target').peek());
        if (!target) return;
        const quiet = ci.slot('ignoreUnknownSignals').peek() === true;
        const wireOne = (
          name: string,
          fn: (...args: unknown[]) => unknown,
        ): void => {
          const base = name[2].toLowerCase() + name.slice(3);
          if (!target.signalParams.has(base)) {
            if (!quiet)
              warnOnce(
                `qml-connections-${base}`,
                `QML: Connections: ${target.typeInfo.name} has no signal '${base}'`,
              );
            return;
          }
          offs.push(target.onSignal(base, fn));
        };
        for (const { name, value } of ci.deferredHandlers) {
          const base = name[2].toLowerCase() + name.slice(3);
          const params = target.signalParams.get(base) ?? [];
          wireOne(name, makeHandlerFor(ci, value, params));
        }
        for (const [name, method] of ci.methods) {
          if (/^on[A-Z]/.test(name)) wireOne(name, method);
        }
      };
      ci.slot('target').watch(wire);
      ci.slot('enabled').watch(wire);
      ci.state.unwire = () => {
        for (const off of offs) off();
        offs = [];
      };
      wire();
    },
    dispose(ci) {
      (ci.state.unwire as (() => void) | undefined)?.();
    },
  },
};
