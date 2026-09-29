// Form controls: where they go, and how big they are.
//
// A form control in a document is **not drawn here**. It is a real core
// widget — `<button>`, `<select>`, `<checkbox>`, `<radio>`, `<textinput>`,
// `<textarea>` — mounted beside the element at the rectangle layout gave it.
//
// That is the same escape hatch `<Flow>` opened for a node whose body is a
// form, and it exists for the same reason: a drawn control is a picture of a
// control. It does not take focus in the window's focus order, it does not
// speak to an assistive technology, it does not blink a caret or open a menu
// or agree with the platform's keyboard conventions, and every one of those
// would have to be rebuilt inside the paint pass. Mounting the real widget
// gets all of it, and gets it *consistent with the rest of the application* —
// a `<select>` in a rendered document drops the same menu as a `<Select>` in
// the surrounding window, because it is the same widget.
//
// What it costs is the reason this file exists rather than the component
// doing it inline: the box in the flow has to be the size the widget will
// actually be, before the widget exists. So the sizes here are measured from
// the same font metrics the widget will use, and `<Html>` mounts into
// exactly the rectangle layout reserved.
import type { Element } from 'domhandler';

import { attr, tagOf } from './dom.js';
import type { ComputedStyle } from './css/style.js';
import { isTransparent } from './css/values.js';
import type { Box, BoxTree, ReplacedKind } from './layout/boxes.js';
import type { FontsLike } from './layout/inline.js';

/** The palette numbers a control's box has to reserve room for. */
export interface ControlChrome {
  controlPadY: number;
  controlBorder: number;
  controlRadius: number;
  surface: string;
  borderColor: string;
}

/** Where a control goes, in the element's own coordinate space. Inside the
 *  engine (`controlRectsOf`) these are device pixels like every box; what
 *  `onControls` reports is the same rect in logical pixels, because it
 *  becomes the style of a widget. */
export interface ControlRect {
  element: Element;
  kind: ReplacedKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Set on a text field whose own box the author styled — gave it a border
   * or a background (`styledField`). The document draws that box, and the
   * widget goes bare inside its content box, here, with no frame or fill
   * of its own and its text in the element's colour and font.
   */
  bare?: BareField;
  /**
   * How opaque the widget is drawn, where it is less than 1: the element's
   * own `opacity` times every ancestor's, since each fades what is in it as
   * a group. At 0 the widget is not seen and still takes a press, as the
   * element does in a browser — the checkbox a CSS-only dropdown lays,
   * invisible, over its label.
   */
  opacity?: number;
}

/** Where a styled text field's widget goes, and how its text looks. */
export interface BareField {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  fontFamily: string;
  fontSize: number;
}

/** The rectangles every control in a laid-out document landed on. */
export function controlRectsOf(tree: BoxTree): ControlRect[] {
  const out: ControlRect[] = [];
  for (const box of tree.controls) {
    if (!box.el) continue;
    if (box.width <= 0 || box.height <= 0) continue;
    // a hidden element draws nothing and takes no press (CSS 2.1 11.2)
    if (box.style.visibility !== 'visible') continue;
    const rect: ControlRect = {
      element: box.el,
      kind: box.replaced,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    };
    let opacity = 1;
    for (let at: Box | null = box; at; at = at.parent) {
      opacity *= at.style.opacity;
    }
    if (opacity < 1) rect.opacity = Math.max(0, opacity);
    if (styledField(box.replaced, box.style)) {
      rect.bare = {
        x: box.contentX,
        y: box.contentY,
        width: box.contentWidth,
        height: box.contentHeight,
        color: box.style.color,
        fontFamily: box.style.fontFamily,
        fontSize: box.style.fontSize,
      };
    }
    out.push(rect);
  }
  return out;
}

/**
 * Whether a text field's box is the author's to draw: one given a border or
 * a background of its own, which the UA sheet gives no control, or set to
 * `appearance: none`, which says so outright. A browser drops a field's
 * native look for the author's then (CSS UI 4 7.1, `appearance`), and so
 * does this: the widget's frame and fill would hide the author's, and what
 * they would draw is the theme's rather than the page's. `appearance: none`
 * is how a design system writes every field it has — meetup.com's search
 * pill holds two with no background, only one of them with a border.
 */
export function styledField(kind: ReplacedKind, style: ComputedStyle): boolean {
  if (kind !== 'input' && kind !== 'textarea') return false;
  return (
    style.appearance === 'none' ||
    !isTransparent(style.backgroundColor) ||
    !!style.backgroundImage ||
    !!style.backgroundGradient ||
    !!style.backgroundImages ||
    edged(style.borderTopStyle, style.borderTopWidth) ||
    edged(style.borderRightStyle, style.borderRightWidth) ||
    edged(style.borderBottomStyle, style.borderBottomWidth) ||
    edged(style.borderLeftStyle, style.borderLeftWidth)
  );
}

function edged(style: ComputedStyle['borderTopStyle'], width: number): boolean {
  return style !== 'none' && style !== 'hidden' && width > 0;
}

/**
 * The size a control's box takes in the flow.
 *
 * An explicit `width`/`height` in the cascade wins — layout applies it after
 * this — so what is computed here is the *intrinsic* size: what the widget
 * would ask for. Text fields size from `size`/`cols`/`rows` the way HTML says
 * and from the font's own metrics otherwise, because a field measured in
 * pixels is the wrong size in every theme but the one it was measured in.
 */
export function measureControl(
  el: Element,
  kind: ReplacedKind,
  style: ComputedStyle,
  fonts: FontsLike | null,
  look: ControlChrome,
): { width: number; height: number } {
  const em = style.fontSize;
  const ch = charWidth(style, fonts);
  const lineHeight = Math.round(em * 1.35);
  const padding = Math.round(em * 0.5);
  // The widget's own vertical chrome, so the reserved box and the mounted
  // widget agree rather than the widget overflowing the hole left for it.
  const chrome = look.controlPadY * 2 + look.controlBorder * 2;

  switch (kind) {
    case 'checkbox':
    case 'radio': {
      const box = Math.round(em * 0.95);
      return { width: box, height: box };
    }
    case 'button': {
      const label = buttonLabel(el);
      return {
        width: Math.max(
          Math.round(ch * label.length + padding * 2 + chrome),
          Math.round(em * 3),
        ),
        height: lineHeight + chrome,
      };
    }
    case 'select': {
      const widest = optionWidths(el);
      // The room for the chevron is the widget's, not the document's, but
      // the document has to reserve it or the last letter of the widest
      // option sits under it.
      return {
        width: Math.max(
          Math.round(ch * widest + padding * 2 + em + chrome),
          Math.round(em * 6),
        ),
        height: lineHeight + chrome,
      };
    }
    // a field the author drew the box of is its text and no more, as a
    // browser's is: the room around it is the author's border and padding
    case 'textarea': {
      const cols = numberAttr(el, 'cols') ?? 30;
      const rows = numberAttr(el, 'rows') ?? 3;
      if (styledField(kind, style)) {
        return {
          width: Math.round(ch * cols),
          height: Math.round(lineHeight * rows),
        };
      }
      return {
        width: Math.round(ch * cols + padding * 2 + chrome),
        height: Math.round(lineHeight * rows + chrome),
      };
    }
    case 'input': {
      const size = numberAttr(el, 'size') ?? 20;
      if (styledField(kind, style)) {
        return { width: Math.round(ch * size), height: lineHeight };
      }
      return {
        width: Math.round(ch * size + padding * 2 + chrome),
        height: lineHeight + chrome,
      };
    }
    default:
      return { width: 0, height: 0 };
  }
}

/** The label a `<button>` or an `<input type=submit>` shows. */
export function buttonLabel(el: Element): string {
  if (tagOf(el) === 'button') {
    let text = '';
    for (const child of el.children) {
      if (child.type === 'text') text += child.data;
    }
    const trimmed = text.trim();
    if (trimmed) return trimmed;
  }
  const value = attr(el, 'value');
  if (value) return value;
  const type = (attr(el, 'type') ?? '').toLowerCase();
  if (type === 'submit') return 'Submit';
  if (type === 'reset') return 'Reset';
  return attr(el, 'alt') ?? 'Button';
}

/** A `<select>`'s options, as the widget's item list. */
export function optionsOf(el: Element): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const walk = (node: Element): void => {
    for (const child of node.children) {
      if (child.type !== 'tag') continue;
      const tag = tagOf(child);
      if (tag === 'option') {
        let label = '';
        for (const kid of child.children) {
          if (kid.type === 'text') label += kid.data;
        }
        const trimmed = label.trim();
        out.push({ value: attr(child, 'value') ?? trimmed, label: trimmed });
      } else if (tag === 'optgroup') {
        walk(child);
      }
    }
  };
  walk(el);
  return out;
}

/** Which option a `<select>` starts on: `selected`, else the first. */
export function selectedOption(el: Element): string | null {
  const options = optionsOf(el);
  const walk = (node: Element): string | null => {
    for (const child of node.children) {
      if (child.type !== 'tag') continue;
      if (tagOf(child) === 'option' && attr(child, 'selected') !== undefined) {
        let label = '';
        for (const kid of child.children) {
          if (kid.type === 'text') label += kid.data;
        }
        return attr(child, 'value') ?? label.trim();
      }
      const nested = walk(child);
      if (nested !== null) return nested;
    }
    return null;
  };
  return walk(el) ?? options[0]?.value ?? null;
}

/** A `<textarea>`'s initial text — its content, not an attribute. */
export function textareaValue(el: Element): string {
  let text = '';
  for (const child of el.children) {
    if (child.type === 'text') text += child.data;
  }
  // HTML drops one leading newline after the open tag, which is why a
  // pretty-printed `<textarea>` does not start with a blank line.
  return text.replace(/^\r?\n/, '');
}

function numberAttr(el: Element, name: string): number | null {
  const raw = attr(el, name);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function optionWidths(el: Element): number {
  let widest = 4;
  for (const option of optionsOf(el))
    widest = Math.max(widest, option.label.length);
  return widest;
}

/** The average advance of a digit in this style — the `ch` unit, measured
 *  rather than guessed, because `size="20"` in a proportional face is a very
 *  different width from 20 monospace cells. */
function charWidth(style: ComputedStyle, fonts: FontsLike | null): number {
  if (!fonts) return style.fontSize * 0.55;
  try {
    const font = fonts.match(style.fontFamily, {
      size: style.fontSize,
      weight: style.fontWeight,
      style: style.fontStyle,
    });
    const metrics = font.metrics(style.fontSize);
    // No advance in the metrics slice, so the em box's height is the proxy
    // every UI toolkit uses for it.
    return (metrics.ascent + metrics.descent) * 0.5;
  } catch {
    return style.fontSize * 0.55;
  }
}
