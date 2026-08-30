// Helpers every QtQuick view shares: colour conversion, the geometry →
// style mapping, and the motion merge (Behavior / state transitions /
// looping animations lowered onto react-x11's own `transition` and
// `animation` style engines).

import type { Style } from 'react-x11/style';
import type { DrawnNode } from 'react-x11';
import { QmlInstance } from './objects.js';
import { geometryStyle } from './react.js';
import { setupStates } from './states.js';

export const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

export const str = (v: unknown): string => (v == null ? '' : String(v));

/** QML hex colours put alpha FIRST (#AARRGGBB); CSS puts it last. */
export function qmlColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return v == null ? undefined : String(v);
  if (v[0] === '#' && v.length === 9) return `#${v.slice(3)}${v.slice(1, 3)}`;
  if (v[0] === '#' && v.length === 5) return `#${v.slice(2)}${v.slice(1, 2)}`;
  return v;
}

/** QML property name → the style key the renderer animates. */
export const STYLE_KEY: Record<string, string> = {
  x: 'left',
  y: 'top',
  width: 'width',
  height: 'height',
  color: 'backgroundColor',
  radius: 'borderRadius',
};

export interface MotionState {
  /** `Behavior on x` instances, by property name. */
  behaviors?: Record<string, QmlInstance>;
  /** Durations installed by the active state `Transition`. */
  stateTransitions?: Record<string, number>;
  /** `NumberAnimation on x { loops: Animation.Infinite }` lowerings. */
  loopAnims?: Record<string, { from: unknown; to: unknown; duration: number }>;
}

/**
 * Merge the instance's motion sources into the style. The renderer
 * animates; the property jumps — the declared divergence from
 * docs/components/qml.md ("Behavior").
 */
export function applyMotion(inst: QmlInstance, style: Style): void {
  const motion = inst.state as MotionState;
  let transition: Record<string, number> | undefined;
  if (motion.behaviors) {
    for (const [prop, beh] of Object.entries(motion.behaviors)) {
      if (beh.slots.get('enabled')?.peek() === false) continue;
      const key = STYLE_KEY[prop];
      if (!key) continue;
      // A Behavior takes its duration from its animation child; a bare
      // `NumberAnimation on x` carries its own.
      const anim = beh.children.find((c) => c.slots.has('duration'));
      const duration =
        num(anim?.slot('duration').peek()) ||
        num(beh.slots.get('duration')?.peek()) ||
        250;
      (transition ??= {})[key] = duration;
    }
  }
  if (motion.stateTransitions) {
    for (const [prop, duration] of Object.entries(motion.stateTransitions)) {
      const key = STYLE_KEY[prop];
      if (key) (transition ??= {})[key] = duration;
    }
  }
  if (transition) style.transition = transition;
  if (motion.loopAnims) {
    const animation: NonNullable<Style['animation']> = {};
    for (const [prop, spec] of Object.entries(motion.loopAnims)) {
      const key = STYLE_KEY[prop];
      if (!key) continue;
      (animation as Record<string, unknown>)[key] = {
        from: prop === 'color' ? qmlColor(spec.from) : spec.from,
        to: prop === 'color' ? qmlColor(spec.to) : spec.to,
        duration: spec.duration,
      };
    }
    style.animation = animation;
  }
}

/** Ref callback capturing the host node for coordinate re-basing, text
 * measurement and `forceActiveFocus()`. */
export function captureNode(
  inst: QmlInstance,
): (node: DrawnNode | null) => void {
  let fn = inst.state.__captureNode as
    ((node: DrawnNode | null) => void) | undefined;
  if (!fn) {
    fn = (node) => {
      inst.state.node = node;
    };
    inst.state.__captureNode = fn;
  }
  return fn;
}

export const hostNode = (inst: QmlInstance): DrawnNode | null =>
  (inst.state.node as DrawnNode | null) ?? null;

/** The `anchors.*` slot set every Item carries. */
export const anchorProperties: Record<string, { default?: unknown }> = {};
for (const n of [
  'fill',
  'centerIn',
  'left',
  'right',
  'top',
  'bottom',
  'horizontalCenter',
  'verticalCenter',
  'margins',
  'leftMargin',
  'rightMargin',
  'topMargin',
  'bottomMargin',
]) {
  anchorProperties[`anchors.${n}`] = { default: undefined };
}

/** Item's own init: focus plumbing and the state engine. A type that
 * declares its own `init` replaces this (registry semantics), so it calls
 * `initItem(inst)` first — Row, Flickable and Loader all do. */
export function initItem(inst: QmlInstance): void {
  inst.methods.set('forceActiveFocus', () => {
    const node = hostNode(inst) as { focus?(): unknown } | null;
    node?.focus?.();
    return undefined;
  });
  setupStates(inst);
}

export { geometryStyle };
