// What happens to a document, told to the host before `<Html>` does what it
// does about it: a click before a link is followed, a submit before a form
// is sent, a key before a field types it. `onDomEvent` is one synchronous
// callback, and a `false` from it is the page's `preventDefault()`.
//
// Nothing here dispatches to anything. A document has no listeners, since
// nothing runs in it; the host that has some — a script engine over the DOM,
// an application wiring behaviour onto a document with `domutils` — is
// handed what happened and where, and answers whether the default goes on.
// The order the events come in is HTML's and UI Events', and where a default
// changes state before it is asked about — a checkbox ticked, then the click
// — a cancelled event puts the state back, as a browser's does.
//
// The pure half is here: the event's shape, the DOM's names for a key, and
// the button numbering. Where each event is raised is the component's
// (`index.ts`, `widgets.ts`, `stops.ts`).
import type {
  DrawnNode,
  KeyboardEvent as X11KeyboardEvent,
  MouseEvent as X11MouseEvent,
} from 'react-x11';

import type { Element } from './dom.js';

/** What can happen to a document that `<Html>` tells its host about. */
export type HtmlDomEventType =
  | 'click'
  | 'dblclick'
  | 'mousedown'
  | 'mouseup'
  // the pointer's moves over what the document draws, the wheel turned
  // over it, and the menu a secondary press asks for — what a page drawing
  // on a `<canvas>` listens for
  | 'mousemove'
  | 'wheel'
  | 'contextmenu'
  | 'keydown'
  | 'keyup'
  | 'input'
  | 'change'
  | 'submit'
  | 'reset'
  | 'focusin'
  | 'focusout'
  | 'toggle'
  // told after the fact: a `<link rel=stylesheet>`'s sheet applied, or not
  // to be had
  | 'load'
  | 'error';

/**
 * Something that happened to a document, before `<Html>` does what it does
 * about it. `target` is the element in the DOM; a press on a form control's
 * widget is a press on its element.
 */
export interface HtmlDomEvent {
  type: HtmlDomEventType;
  target: Element;
  /** Whether returning `false` from `onDomEvent` stops what follows: a
   *  link followed, a form sent, a key typed, a box ticked. */
  cancelable: boolean;
  /** Where the pointer was, in the document's coordinates in logical pixels
   *  — `elementRect`'s space. A click the keyboard made is at the middle of
   *  the element's first fragment. */
  x?: number;
  y?: number;
  /** The DOM's numbering: 0 the main button, 1 the middle, 2 the other. */
  button?: number;
  /** The buttons held, as the DOM's mask: 1 the main, 2 the other, 4 the
   *  middle. */
  buttons?: number;
  /** A wheel's turn, in pixels: positive right and down. */
  deltaX?: number;
  deltaY?: number;
  /** A click's count: 1, 2 for the second of a double click, 0 for one the
   *  keyboard or the page made. */
  detail?: number;
  /** A key's `KeyboardEvent.key` and `code`, as the DOM names them. */
  key?: string;
  code?: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** A submit's button, or null for an implicit submission or one with no
   *  button. */
  submitter?: Element | null;
  /** For `focusin` the element losing the focus, for `focusout` the one
   *  taking it, where it is the document's. */
  relatedTarget?: Element | null;
}

/** `onDomEvent`: false cancels a cancelable event. */
export type DomEventHandler = (event: HtmlDomEvent) => boolean | void;

/** The modifiers of an event that has none to give. */
export const NO_MODIFIERS = {
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
} as const;

type Modifiers = Pick<
  HtmlDomEvent,
  'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'
>;

/** An event's modifiers, where it has them. */
export function modifiersOf(
  ev: Partial<Modifiers> | null | undefined,
): Modifiers {
  return {
    shiftKey: !!ev?.shiftKey,
    ctrlKey: !!ev?.ctrlKey,
    altKey: !!ev?.altKey,
    metaKey: !!ev?.metaKey,
  };
}

/** What a page may cancel (UI Events, HTML): what has a default to stop.
 *  `input`, `change`, the focus's, `toggle`, `load` and `error` report
 *  what is done. */
const CANCELABLE = new Set<HtmlDomEventType>([
  'click',
  'dblclick',
  'mousedown',
  'mouseup',
  'wheel',
  'contextmenu',
  'keydown',
  'keyup',
  'submit',
  'reset',
]);

/** What an event carries besides its type, its target and whether it can
 *  be cancelled, which is the type's. */
export type DomEventInit = Partial<
  Omit<HtmlDomEvent, 'type' | 'target' | 'cancelable'>
>;

/**
 * Tell the host, and answer whether the default goes on: true unless the
 * event is cancelable and the host returned false. With no host, it does.
 */
export function fireDomEvent(
  handler: DomEventHandler | undefined,
  type: HtmlDomEventType,
  target: Element,
  init: DomEventInit = {},
): boolean {
  if (!handler) return true;
  const cancelable = CANCELABLE.has(type);
  const answer = handler({
    ...NO_MODIFIERS,
    ...init,
    type,
    target,
    cancelable,
  });
  return !(cancelable && answer === false);
}

/** A core button's number as the DOM numbers it: X's 1, 2, 3 are the
 *  DOM's 0, 1, 2 (UI Events 5.2.3). */
export function domButton(button: number): number {
  return button === 2 ? 1 : button === 3 ? 2 : 0;
}

/** The buttons an X state mask holds, as the DOM's mask: X's Button1Mask,
 *  Button2Mask and Button3Mask are the main, the middle and the other. */
export function domButtons(state: number): number {
  return (
    (state & 0x100 ? 1 : 0) | (state & 0x400 ? 2 : 0) | (state & 0x200 ? 4 : 0)
  );
}

/** A mouse event's point in a document's coordinates: the window's logical
 *  point less where the document's element is. */
export function documentPoint(
  ev: Pick<X11MouseEvent<DrawnNode>, 'x' | 'y'>,
  origin: { x: number; y: number } | undefined,
): { x: number; y: number } {
  return { x: ev.x - (origin?.x ?? 0), y: ev.y - (origin?.y ?? 0) };
}

/**
 * The keys the DOM names, by X keysym (UI Events KeyboardEvent key and
 * code values): `key` is what the key means, `code` where it is. A
 * printable key's `key` is the character it typed, which core hands over;
 * these are the rest.
 */
const NAMED: Record<number, [key: string, code: string]> = {
  0xff08: ['Backspace', 'Backspace'],
  0xff09: ['Tab', 'Tab'],
  0xfe20: ['Tab', 'Tab'], // ISO_Left_Tab, Shift+Tab
  0xff0d: ['Enter', 'Enter'],
  0xff8d: ['Enter', 'NumpadEnter'],
  0xff1b: ['Escape', 'Escape'],
  0xffff: ['Delete', 'Delete'],
  0xff63: ['Insert', 'Insert'],
  0xff50: ['Home', 'Home'],
  0xff57: ['End', 'End'],
  0xff55: ['PageUp', 'PageUp'],
  0xff56: ['PageDown', 'PageDown'],
  0xff51: ['ArrowLeft', 'ArrowLeft'],
  0xff52: ['ArrowUp', 'ArrowUp'],
  0xff53: ['ArrowRight', 'ArrowRight'],
  0xff54: ['ArrowDown', 'ArrowDown'],
  0xff67: ['ContextMenu', 'ContextMenu'],
  0xffe1: ['Shift', 'ShiftLeft'],
  0xffe2: ['Shift', 'ShiftRight'],
  0xffe3: ['Control', 'ControlLeft'],
  0xffe4: ['Control', 'ControlRight'],
  0xffe5: ['CapsLock', 'CapsLock'],
  0xffe9: ['Alt', 'AltLeft'],
  0xffea: ['Alt', 'AltRight'],
  0xffe7: ['Meta', 'MetaLeft'],
  0xffe8: ['Meta', 'MetaRight'],
  0xffeb: ['Meta', 'MetaLeft'], // Super_L, the key a browser calls Meta
  0xffec: ['Meta', 'MetaRight'],
};

/** Where a printable key is, by its Latin keysym: the key a US layout has
 *  there, which is what `code` names whatever the layout typed. */
function printableCode(keysym: number): string | null {
  if (keysym >= 0x61 && keysym <= 0x7a) {
    return `Key${String.fromCharCode(keysym - 0x20)}`;
  }
  if (keysym >= 0x41 && keysym <= 0x5a) {
    return `Key${String.fromCharCode(keysym)}`;
  }
  if (keysym >= 0x30 && keysym <= 0x39) {
    return `Digit${String.fromCharCode(keysym)}`;
  }
  return PUNCTUATION[keysym] ?? null;
}

const PUNCTUATION: Record<number, string> = {
  0x20: 'Space',
  0x2d: 'Minus',
  0x3d: 'Equal',
  0x5b: 'BracketLeft',
  0x5d: 'BracketRight',
  0x5c: 'Backslash',
  0x3b: 'Semicolon',
  0x27: 'Quote',
  0x60: 'Backquote',
  0x2c: 'Comma',
  0x2e: 'Period',
  0x2f: 'Slash',
};

/** A core key event's `key` and `code` as the DOM names them. A key the
 *  DOM has no name for is `Unidentified`, as it says. */
export function domKey(
  ev: Pick<X11KeyboardEvent<DrawnNode>, 'keysym' | 'key' | 'codepoint'>,
): { key: string; code: string } {
  const keysym = ev.keysym;
  const named = keysym === undefined ? undefined : NAMED[keysym];
  if (named) return { key: named[0], code: named[1] };
  if (keysym !== undefined && keysym >= 0xffbe && keysym <= 0xffc9) {
    const n = `F${keysym - 0xffbe + 1}`;
    return { key: n, code: n };
  }
  const code = (keysym !== undefined && printableCode(keysym)) || '';
  const key =
    ev.key ??
    (ev.codepoint !== undefined && ev.codepoint >= 0x20
      ? String.fromCodePoint(ev.codepoint)
      : undefined);
  return { key: key ?? 'Unidentified', code: code || 'Unidentified' };
}
