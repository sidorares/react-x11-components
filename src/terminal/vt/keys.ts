// Keys to bytes: xterm's tables, as a pure function.
//
// Nothing here touches X, the emulator or the node, so every rule is asserted
// directly against its golden bytes — which is the point, because "what does
// Ctrl+Shift+F5 send in application-cursor mode" is exactly the kind of thing
// that is wrong for years in a terminal nobody tested this way.
//
// `altKey`/`metaKey` arrive on the synthetic event itself (react-x11#284).
// Before that landed they had to be dug out of `nativeEvent.buttons`; the
// event is the seam now, and the raw mask stays available there for a keymap
// that puts Alt somewhere other than Mod1.
import {
  XK_BACKSPACE,
  XK_DELETE,
  XK_DOWN,
  XK_END,
  XK_ESCAPE,
  XK_F1,
  XK_F10,
  XK_F11,
  XK_F12,
  XK_F2,
  XK_F3,
  XK_F4,
  XK_F5,
  XK_F6,
  XK_F7,
  XK_F8,
  XK_F9,
  XK_HOME,
  XK_INSERT,
  XK_KP_ENTER,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_RIGHT,
  XK_SPACE,
  XK_TAB,
  XK_UP,
} from 'react-x11/keysyms';

/**
 * The keysyms core does not export yet.
 *
 * Keysyms are stable numbers defined by the protocol, so a local table is a
 * transcription rather than a fork — and the missing ones are the keypad,
 * which core has no reason to name until something needs the whole block.
 * Proposed upstream as a zero-risk addition to `keysyms.js`.
 */
export const XK_ISO_LEFT_TAB = 0xfe20;
export const XK_BEGIN = 0xff58;
export const XK_KP_SPACE = 0xff80;
export const XK_KP_TAB = 0xff89;
export const XK_KP_F1 = 0xff91;
export const XK_KP_F2 = 0xff92;
export const XK_KP_F3 = 0xff93;
export const XK_KP_F4 = 0xff94;
export const XK_KP_HOME = 0xff95;
export const XK_KP_LEFT = 0xff96;
export const XK_KP_UP = 0xff97;
export const XK_KP_RIGHT = 0xff98;
export const XK_KP_DOWN = 0xff99;
export const XK_KP_PAGE_UP = 0xff9a;
export const XK_KP_PAGE_DOWN = 0xff9b;
export const XK_KP_END = 0xff9c;
export const XK_KP_BEGIN = 0xff9d;
export const XK_KP_INSERT = 0xff9e;
export const XK_KP_DELETE = 0xff9f;
export const XK_KP_EQUAL = 0xffbd;
export const XK_KP_MULTIPLY = 0xffaa;
export const XK_KP_ADD = 0xffab;
export const XK_KP_SEPARATOR = 0xffac;
export const XK_KP_SUBTRACT = 0xffad;
export const XK_KP_DECIMAL = 0xffae;
export const XK_KP_DIVIDE = 0xffaf;
export const XK_KP_0 = 0xffb0;
export const XK_KP_9 = 0xffb9;

const ESC = '\x1b';
const SS3 = '\x1bO';
const CSI = '\x1b[';

/** What a key event has to carry to be encodable. A subset of react-x11's
 *  `KeyboardEvent`, so the node passes one straight through. */
export interface VtKeyEvent {
  keysym?: number;
  /** What the key produced, layout and level applied — dead keys already
   *  resolved by core's compose handling. */
  codepoint?: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** The two modes the encoding branches on, straight off `term.modes`. */
export interface KeyModes {
  applicationCursorKeysMode: boolean;
  applicationKeypadMode: boolean;
}

/** xterm's modifier parameter: 1 + shift + 2·alt + 4·ctrl + 8·meta. */
export function modifierParam(ev: VtKeyEvent): number {
  return (
    1 +
    (ev.shiftKey ? 1 : 0) +
    (ev.altKey ? 2 : 0) +
    (ev.ctrlKey ? 4 : 0) +
    (ev.metaKey ? 8 : 0)
  );
}

/**
 * A cursor-ish key: `CSI A` normally, `SS3 A` in application-cursor mode,
 * and `CSI 1 ; m A` whenever a modifier is held — the modifier form is never
 * SS3, which is the rule applications actually rely on.
 */
function cursorKey(final: string, ev: VtKeyEvent, modes: KeyModes): string {
  const mod = modifierParam(ev);
  if (mod > 1) return `${CSI}1;${mod}${final}`;
  return modes.applicationCursorKeysMode ? `${SS3}${final}` : `${CSI}${final}`;
}

/** A `CSI n ~` key — Insert, Delete, the page keys, F5 and up. */
function tildeKey(n: number, ev: VtKeyEvent): string {
  const mod = modifierParam(ev);
  return mod > 1 ? `${CSI}${n};${mod}~` : `${CSI}${n}~`;
}

/** F1–F4: `SS3 P..S`, and `CSI 1 ; m P..S` with a modifier. */
function functionKey(final: string, ev: VtKeyEvent): string {
  const mod = modifierParam(ev);
  return mod > 1 ? `${CSI}1;${mod}${final}` : `${SS3}${final}`;
}

/** `CSI n ~` numbers for F5–F20, in xterm's order (with its gaps). */
const F_TILDE: Record<number, number> = {
  [XK_F5]: 15,
  [XK_F6]: 17,
  [XK_F7]: 18,
  [XK_F8]: 19,
  [XK_F9]: 20,
  [XK_F10]: 21,
  [XK_F11]: 23,
  [XK_F12]: 24,
  0xffca: 25, // F13
  0xffcb: 26, // F14
  0xffcc: 28, // F15
  0xffcd: 29, // F16
  0xffce: 31, // F17
  0xffcf: 32, // F18
  0xffd0: 33, // F19
  0xffd1: 34, // F20
};

/** Application-keypad codes, `SS3 <letter>`. */
const KEYPAD_APP: Record<number, string> = {
  [XK_KP_SPACE]: ' ',
  [XK_KP_TAB]: 'I',
  [XK_KP_ENTER]: 'M',
  [XK_KP_F1]: 'P',
  [XK_KP_F2]: 'Q',
  [XK_KP_F3]: 'R',
  [XK_KP_F4]: 'S',
  [XK_KP_MULTIPLY]: 'j',
  [XK_KP_ADD]: 'k',
  [XK_KP_SEPARATOR]: 'l',
  [XK_KP_SUBTRACT]: 'm',
  [XK_KP_DECIMAL]: 'n',
  [XK_KP_DIVIDE]: 'o',
  [XK_KP_EQUAL]: 'X',
};

/** What the numeric keypad types when it is not in application mode. */
const KEYPAD_NUMERIC: Record<number, string> = {
  [XK_KP_SPACE]: ' ',
  [XK_KP_TAB]: '\t',
  [XK_KP_ENTER]: '\r',
  [XK_KP_MULTIPLY]: '*',
  [XK_KP_ADD]: '+',
  [XK_KP_SEPARATOR]: ',',
  [XK_KP_SUBTRACT]: '-',
  [XK_KP_DECIMAL]: '.',
  [XK_KP_DIVIDE]: '/',
  [XK_KP_EQUAL]: '=',
};

/** The keypad's navigation half, mapped onto the keys it duplicates. */
const KEYPAD_NAV: Record<number, number> = {
  [XK_KP_HOME]: XK_HOME,
  [XK_KP_LEFT]: XK_LEFT,
  [XK_KP_UP]: XK_UP,
  [XK_KP_RIGHT]: XK_RIGHT,
  [XK_KP_DOWN]: XK_DOWN,
  [XK_KP_PAGE_UP]: XK_PAGE_UP,
  [XK_KP_PAGE_DOWN]: XK_PAGE_DOWN,
  [XK_KP_END]: XK_END,
  [XK_KP_BEGIN]: XK_BEGIN,
  [XK_KP_INSERT]: XK_INSERT,
  [XK_KP_DELETE]: XK_DELETE,
};

/**
 * Ctrl + a printable key → the C0 control it names. `Ctrl+A` is 0x01 because
 * the control characters *are* the alphabet with the top bits cleared; the
 * five punctuation entries are the rest of the block, and `Ctrl+?` is DEL.
 */
function controlByte(codepoint: number): string | null {
  if (codepoint >= 0x61 && codepoint <= 0x7a) {
    return String.fromCharCode(codepoint - 0x60); // a–z → 0x01–0x1a
  }
  if (codepoint >= 0x41 && codepoint <= 0x5a) {
    return String.fromCharCode(codepoint - 0x40); // A–Z → the same
  }
  switch (codepoint) {
    case 0x20: // space
    case 0x40: // @
    case 0x32: // 2 — the keyboard most people reach NUL through
      return '\0';
    case 0x5b: // [
    case 0x33: // 3
      return '\x1b';
    case 0x5c: // \
    case 0x34: // 4
      return '\x1c';
    case 0x5d: // ]
    case 0x35: // 5
      return '\x1d';
    case 0x5e: // ^
    case 0x36: // 6
      return '\x1e';
    case 0x5f: // _
    case 0x37: // 7
    case 0x2f: // /
      return '\x1f';
    case 0x38: // 8
    case 0x3f: // ?
      return '\x7f';
    default:
      return null;
  }
}

/**
 * The bytes a key sends, or `null` when the terminal has nothing to say about
 * it — a bare modifier, an unmapped key, an application chord. `null` is not
 * "send nothing": it is "this key was not consumed", which is what lets the
 * node leave `preventDefault()` alone and let the key reach whatever is
 * outside.
 */
export function encodeKey(ev: VtKeyEvent, modes: KeyModes): string | null {
  const k = ev.keysym;
  const alt = ev.altKey;
  /** Alt is the ESC prefix, universally. */
  const meta = (bytes: string): string => (alt ? ESC + bytes : bytes);

  if (k !== undefined) {
    // The keypad first: in application mode it has codes of its own, and in
    // numeric mode it is the main block with different keysyms.
    if (modes.applicationKeypadMode && KEYPAD_APP[k] !== undefined) {
      return meta(SS3 + KEYPAD_APP[k]);
    }
    if (k >= XK_KP_0 && k <= XK_KP_9) {
      return meta(
        modes.applicationKeypadMode
          ? SS3 + String.fromCharCode(0x70 + (k - XK_KP_0)) // p–y
          : String.fromCharCode(0x30 + (k - XK_KP_0)),
      );
    }
    if (KEYPAD_NUMERIC[k] !== undefined && !modes.applicationKeypadMode) {
      return meta(KEYPAD_NUMERIC[k]);
    }
    const nav = KEYPAD_NAV[k];
    if (nav !== undefined) return encodeKey({ ...ev, keysym: nav }, modes);

    switch (k) {
      case XK_UP:
        return cursorKey('A', ev, modes);
      case XK_DOWN:
        return cursorKey('B', ev, modes);
      case XK_RIGHT:
        return cursorKey('C', ev, modes);
      case XK_LEFT:
        return cursorKey('D', ev, modes);
      case XK_BEGIN:
        return cursorKey('E', ev, modes);
      case XK_END:
        return cursorKey('F', ev, modes);
      case XK_HOME:
        return cursorKey('H', ev, modes);
      case XK_INSERT:
        return tildeKey(2, ev);
      case XK_DELETE:
        return tildeKey(3, ev);
      case XK_PAGE_UP:
        return tildeKey(5, ev);
      case XK_PAGE_DOWN:
        return tildeKey(6, ev);
      case XK_F1:
        return functionKey('P', ev);
      case XK_F2:
        return functionKey('Q', ev);
      case XK_F3:
        return functionKey('R', ev);
      case XK_F4:
        return functionKey('S', ev);
      case XK_RETURN:
      case XK_KP_ENTER:
        // CR, not LF: the line discipline turns it into whatever the program
        // asked for, and a raw-mode program wants the key it was pressed.
        return meta('\r');
      case XK_ESCAPE:
        return meta(ESC);
      case XK_TAB:
        if (ev.shiftKey) return `${CSI}Z`;
        return ev.ctrlKey ? null : meta('\t');
      case XK_ISO_LEFT_TAB:
        return `${CSI}Z`;
      case XK_BACKSPACE:
        // DEL is what `stty erase` expects on every modern system; Ctrl+H is
        // the other one, and reaching it is what Ctrl+Backspace is for.
        return meta(ev.ctrlKey ? '\x08' : '\x7f');
      case XK_SPACE:
        if (ev.ctrlKey) return meta('\0');
        break;
      default:
        break;
    }
    const tilde = F_TILDE[k];
    if (tilde !== undefined) return tildeKey(tilde, ev);
  }

  const cp = ev.codepoint;
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
    // No character and no key we know: not ours. An application chord
    // (Ctrl+Shift+T for a new tab) lands here and stays unconsumed.
    return null;
  }
  if (ev.ctrlKey) {
    const c = controlByte(cp);
    return c === null ? null : meta(c);
  }
  // Super/Meta chords belong to the desktop, not to the program: Meta+Q is
  // quit, not `ESC q`.
  if (ev.metaKey) return null;
  return meta(String.fromCodePoint(cp));
}

/**
 * Text on its way in from a paste.
 *
 * Bracketed paste is not decoration: without it a shell runs every newline in
 * a pasted block, and a pasted `rm -rf` with a trailing newline is a very bad
 * afternoon. Inside the brackets the payload still has to be sanitised —
 * a `\x1b[201~` in the pasted text would close them early — and newlines
 * normalise to CR because that is what the key sends.
 */
export function encodePaste(text: string, bracketed: boolean): string {
  const normalized = text
    .replace(/\r\n?/g, '\r')
    .replace(/\n/g, '\r')
    // Everything else in C0 except tab and CR is a control the program never
    // asked to receive as *text*.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');
  if (!bracketed) return normalized;
  return `${CSI}200~${normalized}${CSI}201~`;
}
