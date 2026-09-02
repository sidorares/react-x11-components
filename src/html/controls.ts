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
import type { BoxTree, ReplacedKind } from './layout/boxes.js';
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
}

/** The rectangles every control in a laid-out document landed on. */
export function controlRectsOf(tree: BoxTree): ControlRect[] {
  const out: ControlRect[] = [];
  for (const box of tree.controls) {
    if (!box.el) continue;
    if (box.width <= 0 || box.height <= 0) continue;
    out.push({
      element: box.el,
      kind: box.replaced,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    });
  }
  return out;
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
    case 'textarea': {
      const cols = numberAttr(el, 'cols') ?? 30;
      const rows = numberAttr(el, 'rows') ?? 3;
      return {
        width: Math.round(ch * cols + padding * 2 + chrome),
        height: Math.round(lineHeight * rows + chrome),
      };
    }
    case 'input': {
      const size = numberAttr(el, 'size') ?? 20;
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
