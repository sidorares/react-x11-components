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
import {
  optionElements,
  optionLabel,
  optionValue,
  selectedOptions,
} from './form.js';
import type { ComputedStyle } from './css/style.js';
import { invert } from './css/transform.js';
import { isTransparent } from './css/values.js';
import { placedMatrix } from './layout/block.js';
import type { Box, BoxTree, ReplacedKind } from './layout/boxes.js';
import type { FontsLike } from './layout/inline.js';
import { clipAround } from './paint.js';

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
   * The element's computed face and size: what `measureControl` measured
   * its box in, and so what the widget sets its text in. The palette's,
   * from the UA sheet, unless the page set its own — `font: inherit`, which
   * a CSS reset gives every control, for one.
   */
  fontFamily: string;
  fontSize: number;
  /**
   * Set on a text field or a `<select>` whose own box the author styled —
   * gave it a border or a background (`styledField`). The document draws
   * that box, and the widget goes bare inside its content box, here, with
   * no frame or fill of its own and its text in the element's colour and
   * font.
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
  /**
   * The part of the document the element shows through, where that is not
   * all of its box: what its own `clip` and `clip-path` leave of it, and
   * what the boxes that clip their overflow around it, and every
   * `clip-path` above it, do (`clipAround`). The widget is cut to it, as
   * the element's own drawing is. With no area, none of the element shows
   * — a control a page hides for a screen reader alone, 1px square under
   * `clip: rect(0, 0, 0, 0)` or `clip-path: inset(50%)`, beside the one it
   * draws itself — and the widget is not seen and takes no press, and
   * still takes the keyboard's focus, as the element does in a browser.
   */
  clip?: { x: number; y: number; width: number; height: number };
}

/** Where a styled field's widget goes, and how its text looks. */
export interface BareField {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  /** @deprecated The rect's own `fontFamily`, which every rect carries. */
  fontFamily: string;
  /** @deprecated The rect's own `fontSize`, which every rect carries. */
  fontSize: number;
  /**
   * A `<select>`'s: whether it draws its arrow. It does unless the page set
   * `appearance: none`, which is how a page that draws its own arrow — as a
   * background image, most often — says so.
   */
  chevron?: boolean;
}

/** The rectangles every control in a laid-out document landed on. `scale`
 *  is the document's device pixels to a CSS one. */
export function controlRectsOf(tree: BoxTree, scale = 1): ControlRect[] {
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
      fontFamily: box.style.fontFamily,
      fontSize: box.style.fontSize,
    };
    let opacity = 1;
    // A box scaled to nothing draws nothing of what it holds (CSS
    // Transforms 1, 6), which is how a page keeps a menu it has not opened.
    // A widget in it is not mounted; one in a box turned or scaled to
    // anything else is mounted where the box was laid out, as it is — a
    // widget is a node of its own, which no matrix of the document's reaches.
    let flattened = false;
    for (let at: Box | null = box; at; at = at.parent) {
      opacity *= at.style.opacity;
      const matrix = placedMatrix(at);
      if (matrix && !invert(matrix)) flattened = true;
    }
    if (flattened) continue;
    if (opacity < 1) rect.opacity = Math.max(0, opacity);
    // cut by the clips around it where they do not leave it whole, and by
    // its own box where it clips itself
    const shown = pixelsOf(box);
    const around = clipAround(box, scale);
    if (clipsItself(box)) {
      rect.clip = around ? between(around, shown) : shown;
    } else if (around && !covers(around, shown)) rect.clip = around;
    if (styledField(box.replaced, box.style)) {
      rect.bare = {
        x: box.contentX,
        y: box.contentY,
        width: box.contentWidth,
        height: box.contentHeight,
        color: box.style.color,
        fontFamily: box.style.fontFamily,
        fontSize: box.style.fontSize,
        ...(box.replaced === 'select' && {
          chevron: box.style.appearance !== 'none',
        }),
      };
    }
    out.push(rect);
  }
  return out;
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Whether a control is cut to its own box: one the page gave an `overflow`
 * other than `visible`, as an inline block's content is cut (CSS 2.1
 * 11.1.1). A browser paints no control past its border box whatever its
 * `overflow` says, scaling a checkbox into a box a pixel square; a widget
 * has a size of its own, and is cut where the page said its box cuts. At
 * the border box, which the widget's own frame is drawn in. A text field is
 * left out: it cuts its own text, and a sheet that gives every `<textarea>`
 * `overflow: auto`, as normalize.css does, asks for nothing here.
 */
function clipsItself(box: Box): boolean {
  if (box.replaced === 'input' || box.replaced === 'textarea') return false;
  return box.style.overflowX !== 'visible' || box.style.overflowY !== 'visible';
}

/** A box's border box on the pixels it is drawn on. */
function pixelsOf(box: Box): Rect {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  return {
    x,
    y,
    width: Math.round(box.x + box.width) - x,
    height: Math.round(box.y + box.height) - y,
  };
}

/** What two rectangles share, of no area where they share nothing. */
export function between(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

/** Whether a clip leaves a rectangle whole. */
function covers(clip: Rect, rect: Rect): boolean {
  return (
    clip.x <= rect.x &&
    clip.y <= rect.y &&
    clip.x + clip.width >= rect.x + rect.width &&
    clip.y + clip.height >= rect.y + rect.height
  );
}

/**
 * Whether a field's box is the author's to draw: one given a border or a
 * background of its own, which the UA sheet gives no control, or set to
 * `appearance: none`, which says so outright. A browser drops a field's
 * native look for the author's then (CSS UI 4 7.1, `appearance`), and so
 * does this: the widget's frame and fill would hide the author's, and what
 * they would draw is the theme's rather than the page's. `appearance: none`
 * is how a design system writes every field it has — meetup.com's search
 * pill holds two with no background, only one of them with a border.
 *
 * A `<select>` is one too. A browser keeps its arrow when the page gave it a
 * border or a background (Blink's `menulist-button`), and leaves that out
 * as well at `appearance: none` — `BareField.chevron`.
 */
export function styledField(kind: ReplacedKind, style: ComputedStyle): boolean {
  if (kind !== 'input' && kind !== 'textarea' && kind !== 'select') {
    return false;
  }
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
      // a select the page styled is its widest option and its arrow, and
      // the room around them is the page's
      if (styledField(kind, style)) {
        return {
          width: Math.round(
            ch * widest + (style.appearance === 'none' ? 0 : em),
          ),
          height: lineHeight,
        };
      }
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
  const type = (attr(el, 'type') ?? '').trim().toLowerCase();
  // an image button with no image yet says what the image would have
  if (type === 'image') return attr(el, 'alt') || attr(el, 'value') || 'Submit';
  const value = attr(el, 'value');
  if (value) return value;
  if (type === 'submit') return 'Submit';
  if (type === 'reset') return 'Reset';
  return attr(el, 'alt') ?? 'Button';
}

/** A `<select>`'s options, as the widget's item list. */
export function optionsOf(el: Element): { value: string; label: string }[] {
  return optionElements(el).map((option) => ({
    value: optionValue(option),
    label: optionLabel(option),
  }));
}

/** Which option a `<select>` shows: the one it has selected, which is the
 *  first where none is marked (`selectedOptions`). */
export function selectedOption(el: Element): string | null {
  const [option] = selectedOptions(el);
  return option ? optionValue(option) : null;
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
