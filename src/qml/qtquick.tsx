// The QtQuick module: QML's core types over react-x11's intrinsic
// elements. The mapping table lives in docs/components/qml.md. The short
// version: Item/Rectangle are `<box>` with absolute geometry driven by the
// slot graph, Text is `<text>` with implicit size measured through the
// same ntk font stack the renderer lays out with, and every kind of motion
// (`Behavior`, state `Transition`s, looping animations) lowers onto the
// renderer's own `transition`/`animation` style engines — the renderer
// animates; the property jumps (the documented divergence).

import { useEffect } from 'react';
import type { ReactElement } from 'react';

import {
  Qt,
  QmlInstance,
  registerQmlModule,
  type QmlTypeDef,
  type ValueSourceHookup,
} from './objects.js';
import { renderQmlChildren } from './react.js';
import {
  anchorProperties,
  applyMotion,
  captureNode,
  geometryStyle,
  hostNode,
  initItem,
  num,
  qmlColor,
  str,
  type MotionState,
} from './view-utils.js';
import {
  applyFontStyle,
  interactionTypes,
  keyFocusProps,
} from './interaction.js';
import { containerTypes } from './containers.js';
import { modelTypes } from './models.js';
import { stateTypes } from './states.js';
import { cancel, schedule, warn } from './globals.js';

// Qt namespace constants used from expressions (`Qt.LeftButton`,
// `mouse.modifiers & Qt.ShiftModifier`, `Qt.AlignHCenter`).
Object.assign(Qt, {
  LeftButton: 1,
  RightButton: 2,
  MiddleButton: 4,
  ShiftModifier: 0x02000000,
  ControlModifier: 0x04000000,
  AltModifier: 0x08000000,
  MetaModifier: 0x10000000,
  AlignLeft: 1,
  AlignRight: 2,
  AlignHCenter: 4,
  AlignTop: 32,
  AlignBottom: 64,
  AlignVCenter: 128,
});

// --- views -----------------------------------------------------------------

function ItemView({ inst }: { inst: QmlInstance }): ReactElement {
  const style = geometryStyle(inst);
  applyMotion(inst, style);
  return (
    <box ref={captureNode(inst)} style={style} {...keyFocusProps(inst)}>
      {renderQmlChildren(inst)}
    </box>
  );
}

function RectangleView({ inst }: { inst: QmlInstance }): ReactElement {
  const style = geometryStyle(inst);
  style.backgroundColor = qmlColor(inst.slot('color').peek());
  const radius = num(inst.slot('radius').peek());
  if (radius) style.borderRadius = radius;
  const bw = num(inst.slot('border.width').peek());
  if (bw) {
    style.borderWidth = bw;
    style.borderColor = qmlColor(inst.slot('border.color').peek());
  }
  applyMotion(inst, style);
  return (
    <box ref={captureNode(inst)} style={style} {...keyFocusProps(inst)}>
      {renderQmlChildren(inst)}
    </box>
  );
}

function TextView({ inst }: { inst: QmlInstance }): ReactElement {
  const style = geometryStyle(inst, { contentSized: true });
  applyFontStyle(inst, style);
  const wrap = num(inst.slot('wrapMode').peek());
  style.textWrap = wrap ? 'wrap' : 'nowrap';
  const elide = num(inst.slot('elide').peek());
  if (elide === 1 || elide === 2) {
    style.textOverflow = 'ellipsis';
    style.textWrap = 'nowrap';
  }
  const halign = num(inst.slot('horizontalAlignment').peek());
  if (halign === 1) style.textAlign = 'left';
  else if (halign === 2) style.textAlign = 'right';
  else if (halign === 4) style.textAlign = 'center';
  applyMotion(inst, style);
  const text = str(inst.slot('text').peek());

  // Implicit size, measured by the engine that will draw it. `assign`
  // (never `set`) so this is not mistaken for interactive state.
  useEffect(() => {
    const node = hostNode(inst) as {
      app?: {
        fonts?: {
          layout(t: string, s: unknown): { width: number; height: number };
        };
      };
      resolvedTextStyle?(): unknown;
    } | null;
    if (!node?.app?.fonts || !node.resolvedTextStyle) return;
    try {
      const layout = node.app.fonts.layout(text, node.resolvedTextStyle());
      inst.slots.get('implicitWidth')?.assign(Math.ceil(layout.width));
      inst.slots.get('implicitHeight')?.assign(Math.ceil(layout.height));
    } catch {
      // No fonts loaded (headless without the fonts option): leave 0.
    }
  });

  return (
    <text ref={captureNode(inst)} style={style} {...keyFocusProps(inst)}>
      {text}
    </text>
  );
}

const warnedFillMode = { done: false };
function ImageView({ inst }: { inst: QmlInstance }): ReactElement {
  const style = geometryStyle(inst);
  applyMotion(inst, style);
  const source = str(inst.slot('source').peek());
  if (num(inst.slot('fillMode').peek()) !== 0 && !warnedFillMode.done) {
    warnedFillMode.done = true;
    warn(
      'QML: Image.fillMode other than Stretch needs a fit mode in core ' +
        '<image>; the image is stretched.',
    );
  }
  if (!source) return <box style={style}>{renderQmlChildren(inst)}</box>;
  return (
    <image src={source} style={style}>
      {renderQmlChildren(inst)}
    </image>
  );
}

// --- animation sources -----------------------------------------------------

function behaviorHookup(beh: QmlInstance, hookup: ValueSourceHookup): void {
  const { targetSlot, target } = hookup;
  const motion = target.state as MotionState;
  (motion.behaviors ??= {})[targetSlot.name] = beh;
  target._changed();
}

function numberAnimationHookup(
  anim: QmlInstance,
  hookup: ValueSourceHookup,
): void {
  const { targetSlot, target } = hookup;
  const prop = targetSlot.name;
  const motion = target.state as MotionState;
  const sync = (): void => {
    const loops = num(anim.slot('loops').peek());
    const running = anim.slot('running').peek();
    const from = anim.slot('from').peek();
    const to = anim.slot('to').peek();
    const duration = num(anim.slot('duration').peek()) || 250;
    if (
      loops === -1 &&
      from !== undefined &&
      to !== undefined &&
      running !== false
    ) {
      // `loops: Animation.Infinite` — the style `animation` engine's case.
      (motion.loopAnims ??= {})[prop] = { from, to, duration };
      target._changed();
      return;
    }
    if (motion.loopAnims?.[prop]) {
      delete motion.loopAnims[prop];
      target._changed();
    }
    // A property value source auto-runs unless told `running: false` —
    // Qt's rule for `NumberAnimation on x`.
    if (running === true || (running === undefined && to !== undefined)) {
      // One crossing: commit `to`; the renderer eases from where it is
      // (`from` is visual-only here — the documented divergence).
      (motion.behaviors ??= {})[prop] = anim;
      target._changed();
      if (to !== undefined) targetSlot.assign(to);
      cancel(anim.state.stopId);
      anim.state.stopId = schedule(() => {
        anim.slot('running').assign(false);
      }, duration);
    } else {
      cancel(anim.state.stopId);
      if (motion.behaviors?.[prop] === anim) {
        delete motion.behaviors[prop];
        target._changed();
      }
    }
  };
  anim.slot('running').watch(sync);
  sync();
}

// --- Timer -----------------------------------------------------------------

function timerSync(inst: QmlInstance): void {
  cancel(inst.state.timeout);
  inst.state.timeout = null;
  if (inst.destroyed || inst.slot('running').peek() !== true) return;
  const tick = (): void => {
    inst.state.timeout = schedule(
      () => {
        if (inst.destroyed) return;
        if (inst.slot('repeat').peek() && inst.slot('running').peek()) tick();
        else inst.slot('running').assign(false);
        inst.emit('triggered');
      },
      num(inst.slot('interval').peek()),
    );
  };
  tick();
}

// --- registration ----------------------------------------------------------

const TEXT_ENUMS = {
  // Qt's actual values, so ported documents keep meaning.
  NoWrap: 0,
  WordWrap: 1,
  WrapAnywhere: 3,
  Wrap: 4,
  ElideLeft: 0,
  ElideRight: 1,
  ElideMiddle: 2,
  ElideNone: 3,
  AlignLeft: 1,
  AlignRight: 2,
  AlignHCenter: 4,
  AlignJustify: 8,
  AlignTop: 32,
  AlignBottom: 64,
  AlignVCenter: 128,
};

const coreTypes: Record<string, QmlTypeDef> = {
  QtObject: { nonVisual: true, properties: {} },

  Item: {
    view: ItemView,
    init: initItem,
    properties: {
      x: { default: 0 },
      y: { default: 0 },
      width: { default: 0 },
      height: { default: 0 },
      implicitWidth: { default: 0 },
      implicitHeight: { default: 0 },
      visible: { default: true },
      enabled: { default: true },
      clip: { default: false },
      z: { default: 0 },
      opacity: { default: 1 },
      rotation: { default: 0 },
      scale: { default: 1 },
      focus: { default: false },
      activeFocus: { default: false },
      state: { default: '' },
      // Object arrays land as templates; these slots catch the empty and
      // dynamic forms (`states: []`) without a diagnostic.
      states: { default: undefined },
      transitions: { default: undefined },
      ...anchorProperties,
    },
  },

  Rectangle: {
    extends: 'Item',
    view: RectangleView,
    properties: {
      color: { default: 'white' },
      radius: { default: 0 },
      'border.width': { default: 0 },
      'border.color': { default: 'black' },
    },
  },

  Text: {
    extends: 'Item',
    view: TextView,
    properties: {
      text: { default: '' },
      color: { default: 'black' },
      wrapMode: { default: 0 },
      elide: { default: 3 }, // Qt.ElideNone
      horizontalAlignment: { default: 0 },
      verticalAlignment: { default: 0 },
      'font.pixelSize': { default: 0 },
      'font.pointSize': { default: 0 },
      'font.family': { default: '' },
      'font.bold': { default: false },
      'font.italic': { default: false },
      'font.weight': { default: 0 },
    },
    enums: TEXT_ENUMS,
  },

  Image: {
    extends: 'Item',
    view: ImageView,
    properties: { source: { default: '' }, fillMode: { default: 0 } },
    enums: {
      Stretch: 0,
      PreserveAspectFit: 1,
      PreserveAspectCrop: 2,
      Tile: 3,
    },
  },

  Timer: {
    nonVisual: true,
    properties: {
      interval: { default: 1000 },
      running: { default: false },
      repeat: { default: false },
    },
    signals: { triggered: [] },
    init(inst) {
      inst.methods.set('start', () => inst.slot('running').assign(true));
      inst.methods.set('stop', () => inst.slot('running').assign(false));
      inst.methods.set('restart', () => {
        inst.slot('running').assign(false);
        inst.slot('running').assign(true);
      });
      inst.slot('running').watch(() => timerSync(inst));
      inst.slot('interval').watch(() => timerSync(inst));
      timerSync(inst);
    },
    dispose(inst) {
      cancel(inst.state.timeout);
    },
  },

  Behavior: {
    nonVisual: true,
    properties: { enabled: { default: true } },
    init(inst, hookup) {
      if (hookup) behaviorHookup(inst, hookup);
    },
  },

  /** The `Animation.Infinite` namespace. */
  Animation: { nonVisual: true, enums: { Infinite: -1 } },

  NumberAnimation: {
    nonVisual: true,
    properties: {
      duration: { default: 250 },
      from: { default: undefined },
      to: { default: undefined },
      loops: { default: 1 },
      // Undefined so a value source can tell "never said" (auto-runs, as
      // in Qt) from an explicit `running: false`.
      running: { default: undefined },
      properties: { default: '' }, // Transition's per-property list
      property: { default: '' },
    },
    init(inst, hookup) {
      if (hookup) numberAnimationHookup(inst, hookup);
    },
    dispose(inst) {
      cancel(inst.state.stopId);
    },
  },
  ColorAnimation: { extends: 'NumberAnimation', nonVisual: true },
  PropertyAnimation: { extends: 'NumberAnimation', nonVisual: true },
};

let registered = false;

/** Populate the QtQuick registry — the family's one import-time side
 * effect, called from `src/qml/index.ts` at module scope the way a
 * component's `registerElement` is. */
export function registerQtQuick(): void {
  if (registered) return;
  registered = true;
  registerQmlModule('QtQuick', {
    version: '2.0',
    types: {
      ...coreTypes,
      ...stateTypes,
      ...modelTypes,
      ...containerTypes,
      ...interactionTypes,
    },
  });
}

export { qmlColor };
