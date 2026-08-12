// The pointer, as the bytes a program that asked for it expects. Pure, like
// `./keys.ts`, and for the same reason: mouse reporting is four encodings
// crossed with five tracking modes, and the only way to know it is right is
// to assert the bytes.
//
// One thing here is *not* readable from `@xterm/headless`'s public API: which
// **encoding** an application selected. `modes` carries the tracking mode
// (`none | x10 | vt200 | drag | any`) but not SGR/urxvt/UTF-8, so the node
// watches DECSET/DECRST of 1005/1006/1015 through a passive
// `parser.registerCsiHandler` that returns false — public API used as
// designed, and filed upstream as a request to expose `mouseEncoding`
// alongside `mouseTrackingMode`.

const CSI = '\x1b[';

export type MouseTracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any';
export type MouseEncoding = 'default' | 'utf8' | 'sgr' | 'urxvt';

export interface VtMouseEvent {
  kind: 'down' | 'up' | 'move' | 'wheel';
  /** X button number — 1 left, 2 middle, 3 right. Ignored for wheel. */
  button: number;
  /** Wheel direction, positive = towards the user (scroll down). */
  deltaY?: number;
  /** Zero-based grid position. */
  col: number;
  row: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  /** Whether a button is held — `move` only reports under `drag`. */
  pressed: boolean;
}

export interface MouseState {
  tracking: MouseTracking;
  encoding: MouseEncoding;
}

/** X button → the low two bits of the report. Wheel is 64/65. */
function buttonCode(ev: VtMouseEvent): number {
  if (ev.kind === 'wheel') return (ev.deltaY ?? 0) < 0 ? 64 : 65;
  switch (ev.button) {
    case 1:
      return 0;
    case 2:
      return 1;
    case 3:
      return 2;
    default:
      // Buttons 8/9 (back/forward) report as 128+; anything else is not
      // something the protocol has a code for.
      return ev.button >= 8 ? 128 + (ev.button - 8) : 0;
  }
}

function modifierBits(ev: VtMouseEvent): number {
  return (ev.shiftKey ? 4 : 0) + (ev.altKey ? 8 : 0) + (ev.ctrlKey ? 16 : 0);
}

/**
 * The bytes for one pointer event, or `null` when the program did not ask for
 * this one — which is most of them, most of the time.
 *
 * Shift is deliberately *not* passed through as a modifier for a press: it is
 * the universal "let me select instead" override, and the caller gates on it
 * before ever calling here (see the node). What arrives here with `shiftKey`
 * set is a program that asked for all motion, where the override does not
 * apply.
 */
export function encodeMouse(
  ev: VtMouseEvent,
  state: MouseState,
): string | null {
  const { tracking, encoding } = state;
  if (tracking === 'none') return null;
  if (ev.kind === 'move') {
    if (tracking !== 'any' && !(tracking === 'drag' && ev.pressed)) return null;
  }
  // X10 is press-only, and reports no modifiers at all.
  if (tracking === 'x10' && ev.kind !== 'down') return null;

  let code = buttonCode(ev);
  if (ev.kind === 'move') code += 32;
  if (tracking !== 'x10') code += modifierBits(ev);

  const col = ev.col + 1;
  const row = ev.row + 1;

  if (encoding === 'sgr') {
    // The only encoding with a release *code*: everything else spends the
    // button bits on "3" and leaves the program guessing which one came up.
    return `${CSI}<${code};${col};${row}${ev.kind === 'up' ? 'm' : 'M'}`;
  }

  // Every other encoding reports a release as button 3.
  if (ev.kind === 'up') code = 3 + (tracking === 'x10' ? 0 : modifierBits(ev));

  if (encoding === 'urxvt') {
    return `${CSI}${code + 32};${col};${row}M`;
  }
  if (encoding === 'utf8') {
    return `${CSI}M${String.fromCharCode(code + 32)}${String.fromCodePoint(
      col + 32,
    )}${String.fromCodePoint(row + 32)}`;
  }
  // The original encoding: one byte per field, biased by 32, and no way to
  // say anything past column 223. Clamp rather than wrap — a wrapped
  // coordinate is a click somewhere else, which is worse than no click.
  const clamp = (n: number): number => (n > 223 ? 0 : n + 32);
  return `${CSI}M${String.fromCharCode(code + 32)}${String.fromCharCode(
    clamp(col),
  )}${String.fromCharCode(clamp(row))}`;
}

/**
 * The wheel over an alternate-screen application that did *not* ask for mouse
 * reporting: DECSET 1007 says send arrow keys, which is what makes the wheel
 * scroll `less` and `man` at all.
 */
export function encodeAlternateScroll(
  lines: number,
  up: boolean,
  applicationCursorKeys: boolean,
): string {
  const key = applicationCursorKeys
    ? up
      ? '\x1bOA'
      : '\x1bOB'
    : up
      ? `${CSI}A`
      : `${CSI}B`;
  return key.repeat(Math.max(0, lines));
}

/**
 * The DECSET/DECRST parameters that select an encoding, and what each one
 * means. Read by the node's passive CSI observer.
 */
export const ENCODING_MODES: Record<number, MouseEncoding> = {
  1005: 'utf8',
  1006: 'sgr',
  1015: 'urxvt',
};
