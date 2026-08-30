// Pointer and keyboard: MouseArea, the `Keys` attached handlers, `focus`/
// `activeFocus`, and the two text editors over core's `<textinput>` /
// `<textarea>`.

import { useEffect } from 'react';
import type { ReactElement } from 'react';
import type { Style } from 'react-x11/style';
import {
  XK_BACKSPACE,
  XK_DELETE,
  XK_DOWN,
  XK_ESCAPE,
  XK_KP_ENTER,
  XK_LEFT,
  XK_RETURN,
  XK_RIGHT,
  XK_SPACE,
  XK_TAB,
  XK_UP,
} from 'react-x11/keysyms';

import { QmlInstance, type QmlTypeDef } from './objects.js';
import { renderQmlChildren, geometryStyle } from './react.js';
import {
  applyMotion,
  captureNode,
  hostNode,
  num,
  qmlColor,
  str,
} from './view-utils.js';

// --- Keys + focus ----------------------------------------------------------

interface KeyEventLike {
  keysym?: number;
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  stopPropagation?(): void;
}

interface PointerEventLike {
  x: number;
  y: number;
  button?: number;
  detail?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  stopPropagation?(): void;
}

interface WheelEventLike extends PointerEventLike {
  deltaX?: number;
  deltaY?: number;
}

// Qt's modifier flags, so `mouse.modifiers & Qt.ShiftModifier` reads as
// ported code expects.
const SHIFT = 0x02000000;
const CTRL = 0x04000000;
const ALT = 0x08000000;
const META = 0x10000000;

const modifiersOf = (e: {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): number =>
  (e.shiftKey ? SHIFT : 0) |
  (e.ctrlKey ? CTRL : 0) |
  (e.altKey ? ALT : 0) |
  (e.metaKey ? META : 0);

const NAMED_KEYS: Record<number, string> = {
  [XK_RETURN]: 'Return',
  [XK_KP_ENTER]: 'Enter',
  [XK_ESCAPE]: 'Escape',
  [XK_UP]: 'Up',
  [XK_DOWN]: 'Down',
  [XK_LEFT]: 'Left',
  [XK_RIGHT]: 'Right',
  [XK_TAB]: 'Tab',
  [XK_SPACE]: 'Space',
  [XK_DELETE]: 'Delete',
  [XK_BACKSPACE]: 'Back',
};

function dispatchKeys(inst: QmlInstance, e: KeyEventLike): void {
  const ev = {
    key: e.keysym ?? 0,
    text: e.key ?? '',
    modifiers: modifiersOf(e),
    accepted: false,
  };
  const named = NAMED_KEYS[ev.key];
  if (named) inst.attachedHandlers.get(`Keys.on${named}Pressed`)?.(ev);
  if (!ev.accepted) inst.attachedHandlers.get('Keys.onPressed')?.(ev);
  if (ev.accepted) e.stopPropagation?.();
}

/**
 * The focus/keyboard props an Item earns from `focus: true`, `Keys.*`
 * handlers, or being told to be focusable. `activeFocus` follows the real
 * focus events.
 */
export function keyFocusProps(inst: QmlInstance): Record<string, unknown> {
  const wantsFocus = inst.slots.get('focus')?.peek() === true;
  let hasKeys = false;
  for (const k of inst.attachedHandlers.keys()) {
    if (k.startsWith('Keys.')) {
      hasKeys = true;
      break;
    }
  }
  if (!wantsFocus && !hasKeys) return {};
  const props: Record<string, unknown> = {
    focusable: true,
    onFocus: () => inst.slots.get('activeFocus')?.assign(true),
    onBlur: () => inst.slots.get('activeFocus')?.assign(false),
  };
  if (wantsFocus) props.autoFocus = true;
  if (hasKeys) props.onKeyDown = (e: KeyEventLike) => dispatchKeys(inst, e);
  return props;
}

// --- MouseArea -------------------------------------------------------------

function MouseAreaView({ inst }: { inst: QmlInstance }): ReactElement {
  const enabled = inst.slot('enabled').peek() !== false;
  const hoverEnabled = inst.slot('hoverEnabled').peek() === true;
  const style = geometryStyle(inst);
  applyMotion(inst, style);

  const mouse = (e: PointerEventLike) => {
    const abs = hostNode(inst)?.abs;
    return {
      x: e.x - (abs?.x ?? 0),
      y: e.y - (abs?.y ?? 0),
      button: e.button,
      modifiers: modifiersOf(e),
      accepted: true,
    };
  };

  const handlers: Record<string, unknown> = {};
  if (enabled) {
    handlers.onClick = (e: PointerEventLike) => {
      e.stopPropagation?.();
      inst.emit('clicked', mouse(e));
      if (e.detail === 2) inst.emit('doubleClicked', mouse(e));
    };
    handlers.onMouseDown = (e: PointerEventLike) => {
      e.stopPropagation?.();
      inst.slot('pressed').assign(true);
      inst.emit('pressed', mouse(e));
    };
    handlers.onMouseUp = (e: PointerEventLike) => {
      e.stopPropagation?.();
      inst.slot('pressed').assign(false);
      inst.emit('released', mouse(e));
    };
    handlers.onMouseMove = (e: PointerEventLike) => {
      inst.emit('positionChanged', mouse(e));
    };
    handlers.onWheel = (e: WheelEventLike) => {
      inst.emit('wheel', {
        ...mouse(e),
        angleDelta: { x: e.deltaX ?? 0, y: e.deltaY ?? 0 },
      });
    };
    if (hoverEnabled) {
      handlers.onMouseEnter = () => {
        inst.slot('containsMouse').assign(true);
        inst.emit('entered');
      };
      handlers.onMouseLeave = () => {
        inst.slot('containsMouse').assign(false);
        inst.emit('exited');
      };
    }
  }

  return (
    <box
      ref={captureNode(inst)}
      style={style}
      {...handlers}
      {...keyFocusProps(inst)}
    >
      {renderQmlChildren(inst)}
    </box>
  );
}

// --- TextInput / TextEdit --------------------------------------------------

/** The font/colour subset Text and the editors share. */
export function applyFontStyle(inst: QmlInstance, style: Style): void {
  const color = inst.slots.get('color')?.peek();
  if (color !== undefined) style.color = qmlColor(color);
  const px = num(inst.slots.get('font.pixelSize')?.peek());
  const pt = num(inst.slots.get('font.pointSize')?.peek());
  if (px) style.fontSize = px;
  else if (pt) style.fontSize = Math.round((pt * 96) / 72); // CSS's 1pt
  const family = inst.slots.get('font.family')?.peek();
  if (family) style.fontFamily = String(family);
  if (inst.slots.get('font.bold')?.peek()) style.fontWeight = 700;
  else {
    const weight = num(inst.slots.get('font.weight')?.peek());
    if (weight) style.fontWeight = weight;
  }
  if (inst.slots.get('font.italic')?.peek()) style.fontStyle = 'italic';
}

function useImplicitLineHeight(inst: QmlInstance, text: string): void {
  useEffect(() => {
    const node = hostNode(inst) as {
      app?: { fonts?: { layout(t: string, s: unknown): { height: number } } };
      resolvedTextStyle?(): unknown;
    } | null;
    if (!node?.app?.fonts || !node.resolvedTextStyle) return;
    try {
      const probe = node.app.fonts.layout(
        text || 'Mg',
        node.resolvedTextStyle(),
      );
      inst.slots.get('implicitHeight')?.assign(Math.ceil(probe.height) + 8);
    } catch {
      // No fonts loaded (headless without the fonts option): leave 0.
    }
  });
}

function editorView(tag: 'textinput' | 'textarea') {
  return function EditorView({ inst }: { inst: QmlInstance }): ReactElement {
    const style = geometryStyle(inst);
    applyFontStyle(inst, style);
    applyMotion(inst, style);
    const text = str(inst.slot('text').peek());
    useImplicitLineHeight(inst, text);
    const maxLen = num(inst.slots.get('maximumLength')?.peek());
    const props: Record<string, unknown> = {
      ref: captureNode(inst),
      style,
      value: text,
      onChange: (ev: { value: string }) => inst.slot('text').set(ev.value),
      ...keyFocusProps(inst),
    };
    if (tag === 'textinput') {
      props.onSubmit = () => inst.emit('accepted');
      if (maxLen > 0 && maxLen < 32767) props.maxLength = maxLen;
      return <textinput {...props} />;
    }
    return <textarea {...props} />;
  };
}

// --- the type definitions --------------------------------------------------

export const interactionTypes: Record<string, QmlTypeDef> = {
  MouseArea: {
    extends: 'Item',
    view: MouseAreaView,
    properties: {
      pressed: { default: false },
      containsMouse: { default: false },
      hoverEnabled: { default: false },
    },
    signals: {
      clicked: ['mouse'],
      doubleClicked: ['mouse'],
      pressed: ['mouse'],
      released: ['mouse'],
      positionChanged: ['mouse'],
      entered: [],
      exited: [],
      wheel: ['wheel'],
    },
  },

  TextInput: {
    extends: 'Item',
    view: editorView('textinput'),
    properties: {
      text: { default: '' },
      color: { default: undefined },
      maximumLength: { default: 32767 },
      'font.pixelSize': { default: 0 },
      'font.pointSize': { default: 0 },
      'font.family': { default: '' },
      'font.bold': { default: false },
      'font.italic': { default: false },
      'font.weight': { default: 0 },
    },
    signals: { accepted: [], editingFinished: [] },
  },

  TextEdit: {
    extends: 'Item',
    view: editorView('textarea'),
    properties: {
      text: { default: '' },
      color: { default: undefined },
      'font.pixelSize': { default: 0 },
      'font.pointSize': { default: 0 },
      'font.family': { default: '' },
      'font.bold': { default: false },
      'font.italic': { default: false },
      'font.weight': { default: 0 },
    },
  },
};
