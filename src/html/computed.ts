// An element's style as CSSOM's `getComputedStyle` resolves it (CSSOM 9),
// for the properties a page's script reads — where a box is, how big, what
// colour, whether it shows — and not the few hundred a `ComputedStyle`
// holds, most of which no script asks for and some of which are this
// engine's own bookkeeping.
//
// Three things about the values, each CSSOM's: a length is CSS pixels where
// the style holds device ones, so a script on a 2x display reads what it
// would at 1x; the box's own sizes — `width`, `height`, the margins and the
// padding — are the used values a layout came to, where the element has a
// box, and the computed ones where it has none; and a colour is `rgb()` or
// `rgba()`, as a browser serializes every one.
import type { ComputedStyle } from './css/style.js';
import type { Len } from './css/values.js';
import { rgbaOf } from './css/color.js';

/** What a layout made of an element's principal box, in device pixels:
 *  its border box's size, and its margins, borders and padding. */
export interface UsedBox {
  width: number;
  height: number;
  margin: [number, number, number, number];
  border: [number, number, number, number];
  padding: [number, number, number, number];
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** A number as CSSOM writes it: no more than three decimals, and none it
 *  does not need. */
function num(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/** CSS pixels from device ones. */
function px(device: number, scale: number): string {
  return `${num(device / scale)}px`;
}

/** A computed length: pixels, a percentage, `calc()` of the two, `auto`. */
function len(value: Len | 'none', scale: number): string {
  if (value === 'auto' || value === 'none') return value;
  if (typeof value === 'number') return px(value, scale);
  const pct = `${num(value.pct)}%`;
  if (!value.px) return pct;
  const sign = value.px < 0 ? '-' : '+';
  return `calc(${pct} ${sign} ${px(Math.abs(value.px), scale)})`;
}

/** A colour as CSSOM serializes it: `rgb()` opaque, `rgba()` not. */
export function cssomColor(value: string | null, color: string): string {
  if (value === null) return 'rgba(0, 0, 0, 0)';
  const read = rgbaOf(value === 'currentColor' ? color : value);
  if (!read) return value;
  const [r, g, b] = read.slice(0, 3).map((c) => Math.round(c * 255));
  const a = read[3];
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${num(a)})`;
}

/** `display` as the author wrote it, where the box tree reads it as
 *  another: a grid and a `flow-root` are kept apart from what they lay
 *  out as. */
function display(style: ComputedStyle): string {
  if (style.grid)
    return style.display === 'inline-flex' ? 'inline-grid' : 'grid';
  if (style.flowRoot) return 'flow-root';
  if (style.webkitBox === 'block') return '-webkit-box';
  if (style.webkitBox === 'inline') return '-webkit-inline-box';
  return style.display;
}

/**
 * An element's style as `getComputedStyle` answers it, by property name:
 * `box` where a layout gave the element one, for the used values of its
 * size and its edges. `scale` is device pixels to the CSS pixel.
 */
export function cssomStyle(
  style: ComputedStyle,
  scale: number,
  box: UsedBox | null,
): Record<string, string> {
  const color = style.color;
  const out: Record<string, string> = {
    display: display(style),
    position: style.position,
    float: style.float,
    clear: style.clear,
    visibility: style.visibility,
    opacity: num(style.opacity),
    'z-index': String(style.zIndex),
    'box-sizing': style.boxSizing,
    'overflow-x': style.overflowX,
    'overflow-y': style.overflowY,
    overflow:
      style.overflowX === style.overflowY
        ? style.overflowX
        : `${style.overflowX} ${style.overflowY}`,
    cursor: style.cursor ?? 'auto',
    'pointer-events': style.pointerEvents,
    'user-select': style.userSelect,
    color: cssomColor(color, color),
    'color-scheme': style.colorSchemeKeywords,
    'background-color': cssomColor(style.backgroundColor, color),
    'font-family': style.fontFamily,
    'font-size': px(style.fontSize, scale),
    'font-weight': String(style.fontWeight),
    'font-style': style.fontStyle,
    'line-height':
      style.lineHeight === 'normal'
        ? 'normal'
        : style.lineHeightIsLength
          ? px(style.lineHeight, scale)
          : num(style.lineHeight),
    'letter-spacing': style.letterSpacing
      ? px(style.letterSpacing, scale)
      : 'normal',
    'word-spacing': px(style.wordSpacing, scale),
    'text-align': style.textAlign,
    'text-transform': style.textTransform,
    'text-decoration-line': style.textDecorationLine || 'none',
    'white-space': style.whiteSpace,
    direction: style.direction,
    'list-style-type': style.listStyleType,
    'min-width': len(style.minWidth, scale),
    'max-width': len(style.maxWidth, scale),
    'min-height': len(style.minHeight, scale),
    'max-height': len(style.maxHeight, scale),
    top: len(style.top, scale),
    right: len(style.right, scale),
    bottom: len(style.bottom, scale),
    left: len(style.left, scale),
    'outline-style': style.outlineStyle,
    'outline-width': px(style.outlineWidth, scale),
    'outline-color': cssomColor(style.outlineColor, color),
  };
  // a transform is a matrix CSSOM serializes, which is not written here:
  // a script asking for one hears none where there is none, and nothing
  // where there is
  if (!style.transform) out.transform = 'none';
  const widths = [
    style.borderTopWidth,
    style.borderRightWidth,
    style.borderBottomWidth,
    style.borderLeftWidth,
  ];
  const styles = [
    style.borderTopStyle,
    style.borderRightStyle,
    style.borderBottomStyle,
    style.borderLeftStyle,
  ];
  const colors = [
    style.borderTopColor,
    style.borderRightColor,
    style.borderBottomColor,
    style.borderLeftColor,
  ];
  const margins = [
    style.marginTop,
    style.marginRight,
    style.marginBottom,
    style.marginLeft,
  ];
  const paddings = [
    style.paddingTop,
    style.paddingRight,
    style.paddingBottom,
    style.paddingLeft,
  ];
  SIDES.forEach((side, i) => {
    out[`border-${side}-style`] = styles[i];
    // a side with no style has no width (CSS Backgrounds 3, 4.3)
    out[`border-${side}-width`] =
      styles[i] === 'none' || styles[i] === 'hidden'
        ? '0px'
        : px(box ? box.border[i] : widths[i], scale);
    out[`border-${side}-color`] = cssomColor(colors[i], color);
    out[`margin-${side}`] = box
      ? px(box.margin[i], scale)
      : len(margins[i], scale);
    out[`padding-${side}`] = box
      ? px(box.padding[i], scale)
      : len(paddings[i], scale);
  });
  if (box && style.display !== 'inline') {
    // the used size, of the box `box-sizing` says (CSSOM 9.1, the resolved
    // value of `width` and `height`)
    const content = style.boxSizing === 'content-box';
    const across =
      box.border[1] + box.border[3] + box.padding[1] + box.padding[3];
    const down =
      box.border[0] + box.border[2] + box.padding[0] + box.padding[2];
    out.width = px(Math.max(0, box.width - (content ? across : 0)), scale);
    out.height = px(Math.max(0, box.height - (content ? down : 0)), scale);
  } else {
    out.width = len(style.width, scale);
    out.height = len(style.height, scale);
  }
  return out;
}
