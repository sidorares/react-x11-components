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
import type { BasicShape } from './css/basic-shape.js';
import type { Coord, ShapeFunction } from './css/shape-function.js';
import { positionAreaComputed } from './css/anchor.js';
import {
  easingText,
  secondsText,
  transitionItemText,
} from './css/animation.js';
import type { Animations } from './css/animation.js';
import { RANGE_END, RANGE_START } from './css/triggers.js';
import type { RangeEdge } from './css/triggers.js';
import { composeShorthand } from './css/specified.js';
import { fontVariantText, urlOf } from './css/style.js';
import type {
  BackgroundRepeat,
  ClipPath,
  ComputedStyle,
  ContentSize,
  GapRule,
  GridLine,
  SizeOf,
  TimelineRef,
} from './css/style.js';
import { serializeLinear } from './css/calc-tree.js';
import type { Primitive, TransformFunction } from './css/transform.js';
import { matrix4Of, matrixOf } from './css/transform.js';
import type { Len } from './css/values.js';
import {
  currentColorIn,
  inkColor,
  keptColorText,
  liveSource,
  parseColor,
  splitCommas,
  splitValue,
  stretchKeyword,
} from './css/values.js';
import { colorFormText, rgbaOf } from './css/color.js';
import {
  GENERIC_KEYWORDS,
  NOT_A_NAME,
  parseUrl,
  readFamilyName,
} from './css/parse.js';
import { closingParen } from './css/vars.js';

/** What a layout made of an element's principal box, in device pixels:
 *  its border box's size, and its margins, borders and padding. */
export interface UsedBox {
  width: number;
  height: number;
  margin: [number, number, number, number];
  border: [number, number, number, number];
  padding: [number, number, number, number];
  /** The insets, top first, where the box is positioned: device pixels,
   *  `auto`, or null for the computed value (`resolvedInsets`). */
  insets?: readonly (number | 'auto' | null)[] | null;
  /** Whether it is an inline box, whose margins and padding read as they
   *  compute, a percentage as a percentage: what Chrome answers, having
   *  resolved them only for a box with a rectangle of its own. */
  inline?: boolean;
  /** Whether only its margins and padding are to be read, by what otherwise
   *  takes the computed value (`HtmlViewNode._edgesOf`). */
  edgesOnly?: boolean;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** A number as CSSOM writes it: no more than three decimals, and none it
 *  does not need. */
function num(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/** A `<number>` as Chrome serializes a float it keeps: six significant
 *  digits, where an opacity an animation is part way through needs more
 *  than `num`'s three places. */
function float6(n: number): string {
  const r = Number(n.toPrecision(6));
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

/** A size as it computes: its `calc-size()`, or its keyword where it is
 *  one, which the length beside it stands in for. `fit-content()` is no
 *  keyword a browser takes on a size, so what it reads is what it reads
 *  where it is refused. */
function sizeText(
  value: Len | 'none' | 'content',
  keyword: ContentSize | null,
  sized: SizeOf | null,
  scale: number,
): string {
  if (sized) return calcSizeText(sized, keyword, value, scale);
  if (typeof keyword === 'string') return keyword;
  return value === 'content' ? value : len(value, scale);
}

/** A `calc-size()` as it was written, or the sum an interpolation made of
 *  two, from the keyword it runs on. */
function calcSizeText(
  sized: SizeOf,
  keyword: ContentSize | null,
  value: Len | 'none' | 'content',
  scale: number,
): string {
  if (sized.text) return sized.text;
  const of = typeof sized.plus === 'object' ? sized.plus : null;
  const px = of ? (of.px ?? 0) : (sized.plus as number);
  const pct = of ? of.pct : 0;
  const basis =
    typeof keyword === 'string'
      ? keyword
      : value === 'content'
        ? value
        : 'auto';
  return `calc-size(${basis}, ${serializeLinear(sized.size, px / scale, pct)})`;
}

/** `min-width` or `min-height` as a page reads it: `auto` resolves to zero
 *  but where it means something (CSS Sizing 3, 3.2), so what a page works
 *  out from the two is a number on every box it did before flexbox. */
function minSizeText(
  value: Len,
  keyword: ContentSize | null,
  sized: SizeOf | null,
  scale: number,
  keepsAuto: boolean,
): string {
  const text = sizeText(value, keyword, sized, scale);
  return text === 'auto' && !keepsAuto ? '0px' : text;
}

/** An inset pair, the end left out where it is the start; null where
 *  both are `auto`. */
function insetText(inset: readonly [Len, Len], scale: number): string | null {
  const [a, b] = inset.map((v) => len(v, scale));
  if (a === 'auto' && b === 'auto') return null;
  return a === b ? a : `${a} ${b}`;
}

/** `position-visibility` as it computes: `always`, or its keywords. */
function positionVisibilityText(bits: number): string {
  if (!bits) return 'always';
  return [
    bits & 4 ? 'anchors-valid' : '',
    bits & 1 ? 'anchors-visible' : '',
    bits & 2 ? 'no-overflow' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** `position-try-fallbacks` as it computes: each option a name before
 *  its tactics, or a `position-area` in canonical form. */
function tryFallbacksText(
  options: ComputedStyle['positionTryFallbacks'],
): string {
  if (!options) return 'none';
  return options
    .map((o) =>
      o.area
        ? (o.area.text ?? o.text)
        : [o.name, ...o.tactics].filter(Boolean).join(' '),
    )
    .join(', ');
}

/** An `animation-timeline` value as it is serialized, its defaults left
 *  out: `scroll()` names its scroller before its axis. */
function timelineText(t: TimelineRef, scale: number): string {
  if (t.kind === 'auto' || t.kind === 'none') return t.kind;
  if (t.kind === 'name') return t.name;
  const parts: string[] = [];
  if (t.kind === 'scroll') {
    if (t.scroller !== 'nearest') parts.push(t.scroller);
    if (t.axis !== 'block') parts.push(t.axis);
    return `scroll(${parts.join(' ')})`;
  }
  const view = t as Extract<TimelineRef, { kind: 'view' }>;
  if (view.axis !== 'block') parts.push(view.axis);
  const inset = insetText(view.inset, scale);
  if (inset) parts.push(inset);
  return `view(${parts.join(' ')})`;
}

/** One end of an `animation-range`: `normal`, an offset, or a range's name
 *  with its offset where it is not the one the name alone means. */
function rangeEdgeText(edge: RangeEdge, end: boolean, scale: number): string {
  if (edge === (end ? RANGE_END : RANGE_START)) return 'normal';
  const offset = len(edge.offset, scale);
  if (edge.name === null) return offset;
  return offset === (end ? '100%' : '0%') || (!end && edge.offset === 0)
    ? edge.name
    : `${edge.name} ${offset}`;
}

/** `animation-range` from its ends, the end left out where leaving it out
 *  means it: `normal` after an offset, and the end of the start's range
 *  after a name. */
function animationRangeText(
  start: RangeEdge,
  end: RangeEdge,
  scale: number,
): string {
  const a = rangeEdgeText(start, false, scale);
  const b = rangeEdgeText(end, true, scale);
  if (start.name === null ? b === 'normal' : b === start.name) return a;
  return `${a} ${b}`;
}

/** Each `animation-*` longhand as it is resolved. An `auto` duration reads
 *  `0s` where the timeline is the clock's, and `auto` where it may not be. */
function animationProperties(
  style: ComputedStyle,
  scale: number,
): Record<string, string> {
  const a: Animations = style.animations;
  const timelines = style.animationTimeline;
  const onClock = timelines.length === 1 && timelines[0].kind === 'auto';
  const durations = a.durations.map((d) =>
    d === 'auto' ? (onClock ? '0s' : 'auto') : secondsText(d),
  );
  const easings = a.easings.map(easingText);
  const delays = a.delays.map(secondsText);
  const iterations = a.iterations.map((n) =>
    n === Infinity ? 'infinite' : num(n),
  );
  const names = a.names.map((n) => n ?? 'none');
  const starts = style.animationRangeStart;
  const ends = style.animationRangeEnd;
  return {
    'animation-name': names.join(', '),
    'animation-duration': durations.join(', '),
    'animation-timing-function': easings.join(', '),
    'animation-delay': delays.join(', '),
    'animation-iteration-count': iterations.join(', '),
    'animation-direction': a.directions.join(', '),
    'animation-fill-mode': a.fillModes.join(', '),
    'animation-play-state': a.playStates.join(', '),
    'animation-range-start': starts
      .map((e) => rangeEdgeText(e, false, scale))
      .join(', '),
    'animation-range-end': ends
      .map((e) => rangeEdgeText(e, true, scale))
      .join(', '),
  };
}

/**
 * A computed `transform` as a list of functions CSS reads back, in CSS
 * pixels: what `commitStyles` writes into a `style` attribute. A function
 * an animation interpolates is kept as the function it is, and a matrix
 * that is no function's is `matrix()`, or `matrix3d()` out of the plane.
 */
export function cssomTransform(
  list: readonly TransformFunction[] | null,
  scale: number,
): string {
  if (!list?.length) return 'none';
  const n = (v: number) => num(v);
  return list
    .map((fn) => {
      if ('by' in fn) {
        const [x, y] = fn.by;
        return fn.z
          ? `translate3d(${len(x, scale)}, ${len(y, scale)}, ${px(fn.z, scale)})`
          : `translate(${len(x, scale)}, ${len(y, scale)})`;
      }
      if (fn.fn) return primitiveText(fn.fn, scale);
      if ('matrix' in fn) {
        const [a, b, c, d, e, f] = fn.matrix;
        return `matrix(${[a, b, c, d, e / scale, f / scale].map(n).join(', ')})`;
      }
      // a 4×4's translation is a length, and the row a perspective
      // divides by a length's reciprocal (`parseTransform`)
      const m = fn.solid.map((v, i) =>
        i === 12 || i === 13 || i === 14
          ? v / scale
          : i === 3 || i === 7 || i === 11
            ? v * scale
            : v,
      );
      return `matrix3d(${m.map(n).join(', ')})`;
    })
    .join(' ');
}

/** A `transform` list as the matrix it comes to for a box, in CSS pixels:
 *  `matrix()`, or `matrix3d()` where it is no matrix of the plane. */
function transformMatrixText(
  list: TransformFunction[],
  box: UsedBox,
  scale: number,
): string {
  const only = {
    transform: list,
    translate: null,
    rotate: null,
    scale: null,
    perspective: null,
  };
  const solid = matrix4Of(only, box.width, box.height);
  const planar =
    !solid ||
    ([2, 3, 6, 7, 8, 9, 11, 14].every((i) => Math.abs(solid[i]) < 1e-12) &&
      solid[10] === 1 &&
      solid[15] === 1);
  if (solid && !planar) {
    const m = solid.map((v, i) =>
      i === 12 || i === 13 || i === 14
        ? v / scale
        : i === 3 || i === 7 || i === 11
          ? v * scale
          : v,
    );
    return `matrix3d(${m.map(float6).join(', ')})`;
  }
  const [a, b, c, d, e, f] = matrixOf(only, box.width, box.height);
  return `matrix(${[a, b, c, d, e / scale, f / scale].map(float6).join(', ')})`;
}

function primitiveText(fn: Primitive, scale: number): string {
  switch (fn.kind) {
    case 'scale':
      return fn.z !== undefined && fn.z !== 1
        ? `scale3d(${num(fn.x)}, ${num(fn.y)}, ${num(fn.z)})`
        : `scale(${num(fn.x)}, ${num(fn.y)})`;
    case 'rotate':
      return `rotate(${num(fn.angle)}deg)`;
    case 'rotate3d':
      return `rotate3d(${num(fn.x)}, ${num(fn.y)}, ${num(fn.z)}, ${num(fn.angle)}deg)`;
    case 'skew':
      return `skew(${num(fn.x)}deg, ${num(fn.y)}deg)`;
    case 'perspective':
      return fn.depth === null
        ? 'perspective(none)'
        : `perspective(${px(fn.depth, scale)})`;
  }
}

/**
 * A colour as CSSOM serializes it (CSS Color 4, 15): in the space its
 * computed value keeps (`colorFormText`) — `color(srgb …)` for a mix in
 * sRGB or a relative `rgb()`, `oklch()` and `lab()` as themselves — and a
 * legacy sRGB colour as `rgb()` opaque and `rgba()` not. `source` is what
 * the field keeps beside its sRGB value (`keptColorText`), and `color` and
 * `colorSource` the element's colour, which `currentColor` is.
 */
export function cssomColor(
  value: string | null,
  source: string | null,
  color: string,
  colorSource: string | null,
): string {
  if (value === null) return 'rgba(0, 0, 0, 0)';
  if (value === 'currentColor') {
    value = color;
    source = colorSource;
  }
  // a mix or a relative colour of `currentColor` is kept as written until
  // it is used, and is worked out with the element's colour as its own
  // computed value keeps it
  let text = liveSource(value, source);
  if (text === null && value.endsWith(')')) {
    text = currentColorIn(value, liveSource(color, colorSource) ?? color);
  }
  const kept = text === null ? null : colorFormText(text);
  if (kept !== null) return kept;
  // `currentColor` itself, or in a mix or a contrast, is the element's
  const read = rgbaOf(inkColor(value, color));
  if (!read) return value;
  const [r, g, b] = read.slice(0, 3).map((c) => Math.round(c * 255));
  const a = read[3];
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${num(a)})`;
}

/**
 * `background-image` as it computes, from the layers as they were written
 * (`ComputedStyle.backgroundImageText`), as Chrome serializes it: a URL
 * as a `url()` of a string, and so the string an `image()`, a `src()` or
 * an `image-set()` names one by; a gradient's colours as computed colours,
 * its direction left out where it is the one it would have, `to bottom`;
 * an `image-set()` option's resolution in `dppx`, `1dppx` where it gives
 * none. What none of that reads is as written.
 */
export function backgroundImageText(text: string | null): string {
  if (text === null) return 'none';
  return splitCommas(text)
    .map((layer) => imageText(layer.trim()))
    .join(', ');
}

function imageText(text: string): string {
  const lower = text.toLowerCase();
  if (lower === 'none') return 'none';
  if (lower.startsWith('url(')) {
    const url = parseUrl(text);
    return url ? urlText(url) : text;
  }
  const open = text.indexOf('(');
  if (open <= 0 || closingParen(text, open + 1) !== text.length - 1) {
    return text;
  }
  const name = lower.slice(0, open);
  const inner = text.slice(open + 1, -1).trim();
  if (name === 'src') {
    const quoted = QUOTED_FIRST.exec(inner);
    if (!quoted) return text;
    const url = parseUrl(quoted[1]) ?? '';
    const rest = quoted[2].trim();
    return `src(${urlText(url)}${rest ? ` ${rest}` : ''})`;
  }
  const args = splitCommas(inner).map((arg) => arg.trim());
  if (name === 'image') {
    return `image(${args
      .map((arg, k) => {
        const quoted = k === 0 ? QUOTED_FIRST.exec(arg) : null;
        if (quoted && !quoted[2].trim()) {
          return urlText(parseUrl(quoted[1]) ?? '');
        }
        return imageWords(arg);
      })
      .join(', ')})`;
  }
  if (name === 'image-set' || name === '-webkit-image-set') {
    return `${name}(${args.map(imageSetOptionText).join(', ')})`;
  }
  if (GRADIENT.test(name)) {
    // the line a linear gradient runs along by default is left out
    if (
      name.endsWith('linear-gradient') &&
      args.length > 2 &&
      DOWNWARD.test(args[0])
    ) {
      args.shift();
    }
    return `${name}(${args.map(imageWords).join(', ')})`;
  }
  return text;
}

/** A gradient's function names, which are serialized a word at a time. */
const GRADIENT =
  /^(?:-(?:webkit|moz|o)-)?(?:repeating-)?(?:linear|radial|conic)-gradient$/;

/** A linear gradient's direction that is its default one. */
const DOWNWARD = /^(?:to\s+bottom|180deg|0\.5turn|200grad)$/i;

/** A string at a value's start, and what follows it. */
const QUOTED_FIRST = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')([\s\S]*)$/;

/** An `image-set()` option's resolution: a number and its unit. */
const RESOLUTION_WORD =
  /^\+?(\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)(x|dppx|dpi|dpcm)$/i;

/** Dots per CSS pixel in each unit (CSS Values 4, 7.4). */
const DPPX: Record<string, number> = {
  x: 1,
  dppx: 1,
  dpi: 1 / 96,
  dpcm: 2.54 / 96,
};

/** One of an `image-set()`'s options: its image, its resolution in
 *  `dppx`, and its `type()`. */
function imageSetOptionText(option: string): string {
  const quoted = QUOTED_FIRST.exec(option);
  const [first, ...rest] = quoted
    ? [quoted[1], ...splitValue(quoted[2])]
    : splitValue(option);
  if (!first) return option;
  const image = quoted ? urlText(parseUrl(first) ?? '') : imageText(first);
  let resolution = '1dppx';
  const types: string[] = [];
  for (const word of rest) {
    const m = RESOLUTION_WORD.exec(word);
    if (m) {
      resolution = `${num(Number(m[1]) * DPPX[m[2].toLowerCase()])}dppx`;
    } else types.push(word);
  }
  return [image, resolution, ...types].join(' ');
}

/** A part of an image function, a word at a time: a colour computed, a
 *  keyword and a unit in lowercase, and anything else as written. */
function imageWords(text: string): string {
  return splitValue(text)
    .map((word) => {
      const color = colorText(word);
      if (color !== null) return color;
      if (/^[a-z-]+$/i.test(word)) return word.toLowerCase();
      return word.replace(
        /^([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?)([a-z]+)$/i,
        (_, n: string, unit: string) => n + unit.toLowerCase(),
      );
    })
    .join(' ');
}

/** A colour as a computed value serializes it, `currentcolor` as itself;
 *  null for a word that is no colour. */
function colorText(word: string): string | null {
  const parsed = parseColor(word);
  if (parsed === null) return null;
  if (parsed === 'currentColor') return 'currentcolor';
  return cssomColor(parsed, keptColorText(word, parsed), parsed, null);
}

/** A URL as CSSOM serializes one: a `url()` of a string. */
function urlText(url: string): string {
  const escaped = url
    .replace(/[\\"]/g, '\\$&')
    .replace(/[\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
  return `url("${escaped}")`;
}

/** An identifier as Chrome tells one here: at most one hyphen, and no digit
 *  after it. `--foo` is one to CSS, and Chrome quotes it. */
const IDENTIFIER = /^-?[a-z_\u0080-\u{10ffff}][-\w\u0080-\u{10ffff}]*$/iu;

/** A family's name: a string where an identifier would not read as it
 *  (CSSOM 6.7.2, and csswg-drafts#5846 for those that need no quotes). */
function familyNameText(name: string): string {
  return IDENTIFIER.test(name) &&
    !NOT_A_NAME.test(name) &&
    !GENERIC_KEYWORDS.has(name)
    ? name
    : `"${name
        .replace(/[\\"]/g, '\\$&')
        .replace(
          /[\x01-\x1f\x7f]/g,
          (c) => `\\${c.charCodeAt(0).toString(16)} `,
        )}"`;
}

/** One name of a `font-family` as it was written. A host's list is no
 *  sheet's, and may hold what `readFamilyName` is not handed. */
function writtenFamilyText(written: string): string {
  const family = readFamilyName(written);
  if (!family) return familyNameText(written.replace(/[ \t\n\r\f]+/g, ' '));
  return !family.quoted && GENERIC_KEYWORDS.has(family.name)
    ? family.name
    : familyNameText(family.name);
}

/** The lists read so far, by what was written: a document has few, and an
 *  element of a page read in a loop is rarely in a list of its own.
 *  Tailwind's stack of seven was a third of a whole style's read. */
const FAMILY_TEXTS = new Map<string, string>();

/**
 * `font-family` as it computes: the list as the sheets wrote it
 * (`ComputedStyle.fontFamilyText`), as Chrome serializes it, and neither
 * `fontFamily`, where a document's faces go by names of ours and a family
 * not loaded yet is left out, nor what a list goes on to. Where no sheet
 * named one it is the host's, which stands where a browser answers its
 * standard font, and is no less a list.
 */
function fontFamilyText(style: ComputedStyle): string {
  const written = style.fontFamilyText || style.fontFamily;
  let text = FAMILY_TEXTS.get(written);
  if (text === undefined) {
    text = splitCommas(written).map(writtenFamilyText).join(', ');
    // a page can write as many as it likes
    if (FAMILY_TEXTS.size >= 256) FAMILY_TEXTS.clear();
    FAMILY_TEXTS.set(written, text);
  }
  return text;
}

/**
 * `font` as the longhands it is set from come to, in the order Chrome, Firefox
 * and WebKit all write them: '' where one has a value the shorthand has no way
 * to say (CSSOM 6.7.2), as all three read, which is a width that is no
 * keyword, capitals other than `small-caps`, and anything but the initial
 * value of what it only sets back. `size` and `family` are what those
 * properties answer, so a list never reads as the names a document's faces go
 * by here.
 */
function fontText(
  style: ComputedStyle,
  size: string,
  family: string,
  scale: number,
): string {
  const width = stretchKeyword(style.fontStretch);
  if (
    width === null ||
    style.fontUnsaid ||
    style.fontVariantNumeric ||
    style.fontVariantLigatures ||
    style.fontVariantPosition ||
    style.fontKerning ||
    style.fontFeatureSettings ||
    (style.fontVariantCaps && style.fontVariantCaps !== 'smcp=1')
  ) {
    return '';
  }
  let text = style.fontStyle === 'normal' ? '' : `${style.fontStyle} `;
  if (style.fontVariantCaps) text += 'small-caps ';
  if (style.fontWeight !== 400) text += `${style.fontWeight} `;
  if (width !== 'normal') text += `${width} `;
  text += size;
  if (style.lineHeight !== 'normal') {
    const height = style.lineHeightIsLength
      ? style.lineHeight
      : style.lineHeight * style.fontSize;
    text += ` / ${px(height, scale)}`;
  }
  return `${text} ${family}`;
}

/** A `list-style-type`, whose string a style holds with its opening quote
 *  alone, to tell it from a counter style's name. */
function listStyleTypeText(type: string): string {
  return type.startsWith('"')
    ? `"${type.slice(1).replace(/[\\"]/g, '\\$&')}"`
    : type;
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

/** The four sides' properties a shorthand of them stands for, in CSS's
 *  top-right-bottom-left order. */
const FOUR_SIDES: Record<string, readonly string[]> = {
  margin: SIDES.map((s) => `margin-${s}`),
  padding: SIDES.map((s) => `padding-${s}`),
  'border-width': SIDES.map((s) => `border-${s}-width`),
  'border-style': SIDES.map((s) => `border-${s}-style`),
  'border-color': SIDES.map((s) => `border-${s}-color`),
  inset: SIDES,
};

const CORNERS = [
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
];

/** Four sides' values as CSSOM writes their shorthand: as few as say all
 *  four, the last left off where it is the second, and so on. */
function shortest(parts: readonly string[]): string {
  const [t, r, b, l] = parts;
  if (r === l && t === b && t === r) return t;
  if (r === l && t === b) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return parts.join(' ');
}

/** A start and an end as a shorthand of the two writes them. */
function pair(start: string, end: string): string {
  return start === end ? start : `${start} ${end}`;
}

/** `row-gap` and `column-gap` as they compute. */
function gapsOf(style: ComputedStyle, scale: number): [string, string] {
  return [
    style.rowGapNormal ? 'normal' : len(style.rowGap, scale),
    style.columnGapNormal ? 'normal' : len(style.columnGap, scale),
  ];
}

/**
 * A computed `clip-path` (CSS Masking 1, 5.1): `none`, a box, a shape with
 * its box where that is not the border box, or the `url()` it names. A
 * shape's positions are its lengths and percentages from the box's corner,
 * as CSS Shapes 2 computes them.
 */
function clipPathText(path: ClipPath | null, scale: number): string {
  if (!path) return 'none';
  if (path.shape === 'url' && path.url) return `url("#${path.url.id}")`;
  const L = (v: Len) => len(v, scale);
  let shape: string | null = null;
  if (path.shape === 'basic' && path.basic) {
    shape = basicShapeText(path.basic, scale);
  } else if (path.shape === 'polygon' && path.points) {
    const points: string[] = [];
    for (let i = 0; i + 1 < path.points.length; i += 2) {
      points.push(`${L(path.points[i])} ${L(path.points[i + 1])}`);
    }
    const rule = path.fillRule === 'evenodd' ? 'evenodd, ' : '';
    shape = `polygon(${rule}${points.join(', ')})`;
  } else if (path.shape === 'inset') {
    shape = `inset(${shortest(path.lengths.map(L))})`;
  } else if (path.shape) {
    shape = `${path.shape}(${path.lengths.map(L).join(' ')})`;
  }
  if (!shape) return path.box;
  return path.box === 'border-box' ? shape : `${shape} ${path.box}`;
}

/** A basic shape's computed value: `shape()` command by command, the rest
 *  by their lengths and positions. */
function basicShapeText(basic: BasicShape, scale: number): string | null {
  const L = (v: Len) => len(v, scale);
  const at = (c: Coord) => `${L(c[0])} ${L(c[1])}`;
  const radius = (r: Len | 'closest-side' | 'farthest-side') =>
    r === 'closest-side' || r === 'farthest-side' ? r : L(r);
  switch (basic.kind) {
    case 'shape':
      return shapeText(basic.shape, scale);
    case 'path':
      return `path(${basic.rule === 'evenodd' ? 'evenodd, ' : ''}${JSON.stringify(basic.d)})`;
    case 'circle':
      return `circle(${radius(basic.r)} at ${at(basic.at)})`;
    case 'ellipse':
      return `ellipse(${radius(basic.rx)} ${radius(basic.ry)} at ${at(basic.at)})`;
    default:
      return null;
  }
}

/** `shape()`'s computed value (CSS Shapes 2, 4.2): its commands with their
 *  lengths and percentages, a control point's anchor where it is not the
 *  command's own, and an arc's defaults left out. */
function shapeText(fn: ShapeFunction, scale: number): string {
  const L = (v: Len) => len(v, scale);
  const pair = (c: Coord) => `${L(c[0])} ${L(c[1])}`;
  const parts = [
    `${fn.rule === 'evenodd' ? 'evenodd ' : ''}from ${pair(fn.from)}`,
  ];
  for (const c of fn.commands) {
    if (c.op === 'close') {
      parts.push('close');
      continue;
    }
    const how = c.by ? 'by' : 'to';
    switch (c.op) {
      case 'move':
      case 'line':
        parts.push(`${c.op} ${how} ${pair(c.to)}`);
        break;
      case 'hline':
      case 'vline':
        parts.push(`${c.op} ${how} ${L(c.to)}`);
        break;
      case 'curve':
      case 'smooth': {
        const own = c.by ? 'start' : 'origin';
        const controls = c.with.map(
          (p) => `${pair(p.at)}${p.from === own ? '' : ` from ${p.from}`}`,
        );
        parts.push(
          `${c.op} ${how} ${pair(c.to)}${controls.length ? ` with ${controls.join(' / ')}` : ''}`,
        );
        break;
      }
      case 'arc':
        parts.push(
          `arc ${how} ${pair(c.to)} of ${c.radii.map(L).join(' ')}` +
            (c.cw ? ' cw' : '') +
            (c.large ? ' large' : '') +
            (c.rotate ? ` rotate ${num(c.rotate)}deg` : ''),
        );
        break;
    }
  }
  return `shape(${parts.join(', ')})`;
}

/**
 * A property's computed value as a declaration reads it back, for
 * `inherit()` (CSS Values 5, 7.6): what `cssomStyle` answers, with no box
 * and so its computed sizes, and its shorthands, as CSSOM serializes them.
 * Undefined for a property none of that serializes.
 */
export function computedText(
  style: ComputedStyle,
  name: string,
  scale: number,
): string | undefined {
  // a style's lengths are zoomed, and a declaration reads them unzoomed
  scale *= style.effectiveZoom;
  const prop = name.toLowerCase();
  const corner = CORNERS.indexOf(prop);
  if (corner >= 0) {
    return pair(
      len(style.borderRadius[corner], scale),
      len((style.borderRadiusY ?? style.borderRadius)[corner], scale),
    );
  }
  if (prop === 'row-gap') return gapsOf(style, scale)[0];
  if (prop === 'column-gap') return gapsOf(style, scale)[1];
  // a computed value, which a `min-width: auto` is whatever box it is on
  return cssomAt(style, scale, null, true)[prop];
}

/** The sides a flow-relative property names (`logicalProperties`). */
const LOGICAL_SIDES = [
  'block-start',
  'block-end',
  'inline-start',
  'inline-end',
];

/** The two axes a flow-relative shorthand names. */
const FLOWS = ['block', 'inline'];

/** What `cssomAt` reads from a box rather than from a style, or a shorthand
 *  composes from what it does, by name and in camel case, as a page reads
 *  it. */
const FROM_A_BOX: ReadonlySet<string> = new Set(
  [
    'width',
    'height',
    'inline-size',
    'block-size',
    'transform',
    ...SIDES,
    'margin',
    'padding',
    'inset',
    'border',
    'border-width',
    ...LOGICAL_SIDES.map((side) => `inset-${side}`),
    ...[...SIDES, ...LOGICAL_SIDES].flatMap((side) => [
      `margin-${side}`,
      `padding-${side}`,
      `border-${side}`,
      `border-${side}-width`,
    ]),
    ...FLOWS.flatMap((flow) => [
      `margin-${flow}`,
      `padding-${flow}`,
      `inset-${flow}`,
      `border-${flow}`,
      `border-${flow}-width`,
    ]),
  ].flatMap((name) => [
    name,
    name.replace(/-(.)/g, (_, letter: string) => letter.toUpperCase()),
  ]),
);

/** Whether a page reading `property` of a computed style reads what a
 *  layout made of the box. Anything new `cssomAt` reads from a box joins
 *  `FROM_A_BOX`, or a script reads it as the text still to be set again
 *  left it (`HtmlViewNode.computedStyle`). */
export function comesFromBox(property: string): boolean {
  return FROM_A_BOX.has(property);
}

/**
 * An element's style as `getComputedStyle` answers it, by property name:
 * `box` where a layout gave the element one, for the used values of its
 * size and its edges. `scale` is device pixels to the CSS pixel. Its
 * lengths are as an unzoomed element's (CSS Viewport 1, 5): the style's
 * and the box's are divided by its effective zoom, as Chrome answers.
 * `keepsAuto` has a `min-width: auto` read as itself: on a flex or a grid
 * item, which a `::before` is with no `box` handed in, and for what takes
 * the computed value, as `getKeyframes()` and `commitStyles()` do.
 * `unrendered` says there is no box to be had, which a `box` of null does
 * not: what takes the computed value hands in none either, and a `transform`
 * goes on reading its list there.
 */
export function cssomStyle(
  style: ComputedStyle,
  scale: number,
  box: UsedBox | null,
  keepsAuto = false,
  unrendered = false,
): Record<string, string> {
  return cssomAt(
    style,
    scale * style.effectiveZoom,
    box,
    keepsAuto,
    unrendered,
  );
}

function cssomAt(
  style: ComputedStyle,
  scale: number,
  given: UsedBox | null,
  keepsAuto: boolean,
  unrendered = false,
): Record<string, string> {
  const box = given?.edgesOnly ? null : given;
  const color = style.color;
  const out: Record<string, string> = {
    display: display(style),
    position: style.position,
    float: style.float,
    clear: style.clear,
    visibility: style.visibility,
    opacity: float6(style.opacity),
    zoom: num(style.zoom),
    'z-index': String(style.zIndex),
    'clip-path': clipPathText(style.clipPath, scale),
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
    isolation: style.isolation,
    'mix-blend-mode': style.mixBlendMode,
    'will-change': style.willChangeNames,
    ...animationProperties(style, scale),
    'animation-timeline': style.animationTimeline
      .map((t) => timelineText(t, scale))
      .join(', '),
    'timeline-scope': style.timelineScope,
    'scroll-timeline-name': style.scrollTimelineName,
    'scroll-timeline-axis': style.scrollTimelineAxis,
    'view-timeline-name': style.viewTimelineName,
    'view-timeline-axis': style.viewTimelineAxis,
    'view-timeline-inset': style.viewTimelineInset
      .map((inset) => insetText(inset, scale) ?? 'auto')
      .join(', '),
    'anchor-name': style.anchorNames ? style.anchorNames.join(', ') : 'none',
    'anchor-scope': style.anchorScope,
    'position-anchor': style.positionAnchorText,
    'position-area': style.positionArea?.text
      ? positionAreaComputed(style.positionArea.text)
      : 'none',
    'position-try-order': style.positionTryOrder,
    'position-visibility': positionVisibilityText(style.positionVisibility),
    'position-try-fallbacks': tryFallbacksText(style.positionTryFallbacks),
    'justify-self': style.justifyAnchorCenter
      ? 'anchor-center'
      : style.justifySelf,
    'align-self': style.alignAnchorCenter ? 'anchor-center' : style.alignSelf,
    'view-transition-name': style.viewTransitionName,
    'view-transition-class': style.viewTransitionClass,
    color: cssomColor(color, style.colorSource, color, style.colorSource),
    'color-scheme': style.colorSchemeKeywords,
    'background-color': cssomColor(
      style.backgroundColor,
      style.backgroundColorSource,
      color,
      style.colorSource,
    ),
    'background-image': backgroundImageText(style.backgroundImageText),
    'font-family': fontFamilyText(style),
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
    'font-variant': fontVariantText(style),
    'text-decoration-line': style.textDecorationLine || 'none',
    'text-decoration-color': cssomColor(
      style.textDecorationColor ?? 'currentColor',
      null,
      color,
      style.colorSource,
    ),
    'text-decoration-style': style.textDecorationStyle,
    'text-decoration-thickness':
      style.textDecorationThickness === null
        ? 'auto'
        : px(style.textDecorationThickness, scale),
    'text-underline-offset':
      style.textUnderlineOffset === null
        ? 'auto'
        : px(style.textUnderlineOffset, scale),
    'text-shadow': style.textShadow
      ? style.textShadow
          .map(
            (s) =>
              `${cssomColor(s.color, null, color, style.colorSource)} ${px(s.x, scale)} ${px(s.y, scale)} ${px(s.blur, scale)}`,
          )
          .join(', ')
      : 'none',
    'white-space': style.whiteSpace,
    direction: style.direction,
    'writing-mode': style.writingMode,
    'text-orientation': style.textOrientation,
    'list-style-type': listStyleTypeText(style.listStyleType),
    'min-width': minSizeText(
      style.minWidth,
      style.minWidthKeyword,
      style.minWidthSize,
      scale,
      keepsAuto,
    ),
    'max-width': sizeText(
      style.maxWidth,
      style.maxWidthKeyword,
      style.maxWidthSize,
      scale,
    ),
    'min-height': minSizeText(
      style.minHeight,
      style.minHeightKeyword,
      style.minHeightSize,
      scale,
      keepsAuto,
    ),
    'max-height': sizeText(
      style.maxHeight,
      style.maxHeightKeyword,
      style.maxHeightSize,
      scale,
    ),
    'flex-basis': sizeText(
      style.flexBasis,
      style.flexBasisKeyword,
      style.flexBasisSize,
      scale,
    ),
    top: len(style.top, scale),
    right: len(style.right, scale),
    bottom: len(style.bottom, scale),
    left: len(style.left, scale),
    'outline-style': style.outlineStyle,
    'outline-width': px(style.outlineWidth, scale),
    'outline-color': cssomColor(
      style.outlineColor,
      style.outlineColorSource,
      color,
      style.colorSource,
    ),
    // `auto` resolves to the text's colour, as Chrome answers it
    'caret-color': cssomColor(
      style.caretColor ?? 'currentColor',
      null,
      color,
      style.colorSource,
    ),
  };
  out.font = fontText(style, out['font-size'], out['font-family'], scale);
  out['text-decoration'] = textDecorationText(out, style);
  // a transform resolves to the matrix its list comes to for the box
  // (CSSOM 9, "resolved value"), with none to be had is `none`, and with
  // none handed in is the list it computes to
  out.transform =
    !style.transform || unrendered
      ? 'none'
      : box
        ? transformMatrixText(style.transform, box, scale)
        : cssomTransform(style.transform, scale);
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
  const sources = [
    style.borderTopColorSource,
    style.borderRightColorSource,
    style.borderBottomColorSource,
    style.borderLeftColorSource,
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
  const edges = given?.inline ? null : given;
  SIDES.forEach((side, i) => {
    out[`border-${side}-style`] = styles[i];
    // a side with no style has no width (CSS Backgrounds 3, 4.3)
    out[`border-${side}-width`] =
      styles[i] === 'none' || styles[i] === 'hidden'
        ? '0px'
        : px(box ? box.border[i] : widths[i], scale);
    out[`border-${side}-color`] = cssomColor(
      colors[i],
      sources[i],
      color,
      style.colorSource,
    );
    out[`margin-${side}`] = edges
      ? px(edges.margin[i], scale)
      : len(margins[i], scale);
    out[`padding-${side}`] = edges
      ? px(edges.padding[i], scale)
      : len(paddings[i], scale);
  });
  // a positioned box's insets are the ones layout used (CSSOM 9.1)
  const insets = box?.insets;
  if (insets) {
    SIDES.forEach((side, i) => {
      const v = insets[i];
      if (v !== null) out[side] = v === 'auto' ? 'auto' : px(v, scale);
    });
  }
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
    out.width = sizeText(
      style.width,
      style.widthKeyword,
      style.widthSize,
      scale,
    );
    out.height = sizeText(
      style.height,
      style.heightKeyword,
      style.heightSize,
      scale,
    );
  }
  logicalProperties(out, style);
  (out as Longhands)[READ_FROM] = [style, scale];
  return Object.setPrototypeOf(out, COMPOSED);
}

/** The physical sides a style's flow puts at `LOGICAL_SIDES`' four. */
function flowSides(style: ComputedStyle): readonly string[] {
  const mode = style.writingMode;
  const vertical = mode !== 'horizontal-tb';
  const ltr = style.direction !== 'rtl';
  const [blockStart, blockEnd] =
    mode === 'vertical-rl' || mode === 'sideways-rl'
      ? ['right', 'left']
      : vertical
        ? ['left', 'right']
        : ['top', 'bottom'];
  // a sideways-lr line runs from the bottom up
  const [inlineStart, inlineEnd] = !vertical
    ? ltr
      ? ['left', 'right']
      : ['right', 'left']
    : ltr !== (mode === 'sideways-lr')
      ? ['top', 'bottom']
      : ['bottom', 'top'];
  return [blockStart, blockEnd, inlineStart, inlineEnd];
}

/**
 * The flow-relative properties, each its physical side's resolved value
 * (CSSOM 9, CSS Logical 1, 4), as the element's writing mode and
 * direction map them. Apple's galleries read
 * `parseInt(getComputedStyle(button).marginInlineEnd)` and built a scroll
 * keyframe of the NaN that nothing answered.
 */
function logicalProperties(
  out: Record<string, string>,
  style: ComputedStyle,
): void {
  const physical = flowSides(style);
  LOGICAL_SIDES.forEach((logical, i) => {
    out[`margin-${logical}`] = out[`margin-${physical[i]}`];
    out[`padding-${logical}`] = out[`padding-${physical[i]}`];
    out[`inset-${logical}`] = out[physical[i]];
    for (const part of ['width', 'style', 'color']) {
      out[`border-${logical}-${part}`] = out[`border-${physical[i]}-${part}`];
    }
  });
  const vertical = style.writingMode !== 'horizontal-tb';
  const [inline, block] = vertical ? ['height', 'width'] : ['width', 'height'];
  out['inline-size'] = out[inline];
  out['block-size'] = out[block];
  out['min-inline-size'] = out[`min-${inline}`];
  out['min-block-size'] = out[`min-${block}`];
  out['max-inline-size'] = out[`max-${inline}`];
  out['max-block-size'] = out[`max-${block}`];
}

// --- shorthands ------------------------------------------------------------

/** What a record of longhands was read from, and at what scale: a symbol, so
 *  that a walk of its keys and `JSON.stringify` pass over it. */
const READ_FROM = Symbol('read from');

/** A record `cssomAt` makes, whose shorthands are composed as they are read. */
type Longhands = Record<string, string> & {
  [READ_FROM]: [ComputedStyle, number];
};

/** How a shorthand reads, from the longhands as a page reads them where the
 *  record has them, and the style where it does not. */
type Composer = (
  all: Record<string, string>,
  style: ComputedStyle,
  scale: number,
) => string;

/** One side's border, as `border-top` and its kin write it. */
function edgeText(all: Record<string, string>, side: string): string {
  return `${all[`border-${side}-width`]} ${all[`border-${side}-style`]} ${all[`border-${side}-color`]}`;
}

/** `border`, `border-block` or `border-inline`, which say one edge for all
 *  of `sides`, and so nothing where they differ. */
function everyEdge(sides: readonly string[]): Composer {
  return (all) => {
    const [first, ...rest] = sides.map((side) => edgeText(all, side));
    return rest.every((edge) => edge === first) ? first : '';
  };
}

/** A flow's two of four sides' values, top first. */
function flowPair(
  values: readonly string[],
  style: ComputedStyle,
  flow: string,
): string {
  const at = LOGICAL_SIDES.indexOf(`${flow}-start`);
  const physical = flowSides(style);
  const sides: readonly string[] = SIDES;
  return pair(
    values[sides.indexOf(physical[at])],
    values[sides.indexOf(physical[at + 1])],
  );
}

function scrollMargins(style: ComputedStyle, scale: number): string[] {
  return [
    style.scrollMarginTop,
    style.scrollMarginRight,
    style.scrollMarginBottom,
    style.scrollMarginLeft,
  ].map((v) => px(v, scale));
}

function scrollPaddings(style: ComputedStyle, scale: number): string[] {
  return [
    style.scrollPaddingTop,
    style.scrollPaddingRight,
    style.scrollPaddingBottom,
    style.scrollPaddingLeft,
  ].map((v) => len(v, scale));
}

/** A gap's rule: its style left out where it is `none`, as Chrome reads it. */
function ruleText(rule: GapRule, style: ComputedStyle, scale: number): string {
  const kind = rule.style === 'none' ? '' : `${rule.style} `;
  const color = cssomColor(rule.color, null, style.color, style.colorSource);
  return `${px(rule.width, scale)} ${kind}${color}`;
}

/** A corner's shape as it computes, whichever keyword it was written as. */
function cornerShapeText(k: number): string {
  if (k === Infinity) return 'superellipse(infinity)';
  if (k === -Infinity) return 'superellipse(-infinity)';
  return `superellipse(${num(k)})`;
}

function gridLineText(line: GridLine): string {
  if (line === null) return 'auto';
  if ('span' in line) {
    if (!line.name) return `span ${line.span}`;
    return line.span === 1
      ? `span ${line.name}`
      : `span ${line.span} ${line.name}`;
  }
  if ('line' in line) {
    return line.name ? `${line.line} ${line.name}` : String(line.line);
  }
  return line.name;
}

/** Whether a grid placement can leave `next` out after `first`: what it
 *  would stand for then is `first` where that is a name and `auto` where
 *  not (CSS Grid 2, 8.4). */
function followsFrom(first: GridLine, next: GridLine): boolean {
  const named = first !== null && !('span' in first) && !('line' in first);
  return named ? gridLineText(next) === gridLineText(first) : next === null;
}

function gridAxisText(start: GridLine, end: GridLine): string {
  return followsFrom(start, end)
    ? gridLineText(start)
    : `${gridLineText(start)} / ${gridLineText(end)}`;
}

/** `grid-area`, its last value left off where it can be, then the one
 *  before it, and so on. */
function gridAreaText(style: ComputedStyle): string {
  const {
    gridRowStart: rowStart,
    gridColumnStart: columnStart,
    gridRowEnd: rowEnd,
    gridColumnEnd: columnEnd,
  } = style;
  const parts = [rowStart, columnStart, rowEnd, columnEnd].map(gridLineText);
  let count = 4;
  if (followsFrom(columnStart, columnEnd)) {
    count = 3;
    if (followsFrom(rowStart, rowEnd)) {
      count = 2;
      if (followsFrom(rowStart, columnStart)) count = 1;
    }
  }
  return parts.slice(0, count).join(' / ');
}

function repeatText([x, y]: BackgroundRepeat): string {
  if (x === y) return x;
  if (x === 'repeat' && y === 'no-repeat') return 'repeat-x';
  if (x === 'no-repeat' && y === 'repeat') return 'repeat-y';
  return `${x} ${y}`;
}

function backgroundSizeText(
  size: ComputedStyle['backgroundSize'],
  scale: number,
): string {
  return typeof size === 'string'
    ? size
    : `${len(size[0], scale)} ${len(size[1], scale)}`;
}

/** `background`, a layer for each image, each list taken in turn and over
 *  again as a layer's image does, and the colour in the last. */
function backgroundText(
  all: Record<string, string>,
  style: ComputedStyle,
  scale: number,
): string {
  const images = splitCommas(all['background-image']);
  const nth = <T>(list: readonly T[] | null, one: T, i: number): T =>
    list ? list[i % list.length] : one;
  return images
    .map((image, i) => {
      const [x, y] = nth<readonly [Len, Len]>(
        style.backgroundPositions,
        [style.backgroundPositionX, style.backgroundPositionY],
        i,
      );
      return [
        i === images.length - 1 ? all['background-color'] : '',
        image.trim(),
        repeatText(nth(style.backgroundRepeats, style.backgroundRepeat, i)),
        nth(style.backgroundAttachments, style.backgroundAttachment, i),
        `${len(x, scale)} ${len(y, scale)} /`,
        backgroundSizeText(
          nth(style.backgroundSizes, style.backgroundSize, i),
          scale,
        ),
        nth(style.backgroundOrigins, style.backgroundOrigin, i),
        style.backgroundClipText
          ? 'text'
          : nth(style.backgroundClips, style.backgroundClip, i),
      ]
        .filter(Boolean)
        .join(' ');
    })
    .join(', ');
}

/** `transition`, an item for each property, the other lists taken in turn
 *  and over again as a transition does. */
function transitionText(style: ComputedStyle): string {
  const t = style.transitions;
  const nth = <T>(list: readonly T[], i: number): T => list[i % list.length];
  return (t.properties.length ? t.properties : ['none'])
    .map((property, i) =>
      transitionItemText([
        property,
        secondsText(nth(t.durations, i)),
        easingText(nth(t.easings, i)),
        secondsText(nth(t.delays, i)),
        nth(t.behaviors, i),
      ]),
    )
    .join(', ');
}

/** `text-decoration`, each part left out at its initial value. Its colour's
 *  is `currentcolor`, which reads as the text's and is still left out. */
function textDecorationText(
  all: Record<string, string>,
  style: ComputedStyle,
): string {
  const { textDecorationColor: color } = style;
  const parts = [
    all['text-decoration-line'] === 'none' ? '' : all['text-decoration-line'],
    all['text-decoration-thickness'] === 'auto'
      ? ''
      : all['text-decoration-thickness'],
    all['text-decoration-style'] === 'solid'
      ? ''
      : all['text-decoration-style'],
    color === null || color === 'currentColor'
      ? ''
      : all['text-decoration-color'],
  ];
  return parts.filter(Boolean).join(' ') || 'none';
}

/**
 * Every shorthand a page reads off a computed style, but for `font` and
 * `overflow`, which `cssomAt` writes with the longhands, since a page reads
 * them as it reads those: on the way to a text measure, and up a tree for what
 * scrolls. Each is composed from its longhands as they resolve, so `margin`
 * reads used values where `margin-top` does, and reads '' where those cannot
 * be said in it (CSSOM 6.7.2).
 *
 * Not here, and so read as a browser with no such property reads them: `mask`
 * and `border-image`, whose images a style keeps in no form a page can read,
 * `grid` and `grid-template`, whose tracks resolve to what a layout came to,
 * and what a style holds nothing of.
 */
const SHORTHANDS: Record<string, Composer> = {
  ...Object.fromEntries(
    Object.entries(FOUR_SIDES).map(([name, sides]): [string, Composer] => [
      name,
      (all) => shortest(sides.map((side) => all[side])),
    ]),
  ),
  ...Object.fromEntries(
    FLOWS.flatMap((flow): [string, Composer][] => [
      ...['margin', 'padding', 'inset'].map((prop): [string, Composer] => [
        `${prop}-${flow}`,
        (all) => pair(all[`${prop}-${flow}-start`], all[`${prop}-${flow}-end`]),
      ]),
      ...['width', 'style', 'color'].map((part): [string, Composer] => [
        `border-${flow}-${part}`,
        (all) =>
          pair(
            all[`border-${flow}-start-${part}`],
            all[`border-${flow}-end-${part}`],
          ),
      ]),
      [`border-${flow}`, everyEdge([`${flow}-start`, `${flow}-end`])],
      [
        `scroll-margin-${flow}`,
        (_, style, scale) => flowPair(scrollMargins(style, scale), style, flow),
      ],
      [
        `scroll-padding-${flow}`,
        (_, style, scale) =>
          flowPair(scrollPaddings(style, scale), style, flow),
      ],
    ]),
  ),
  ...Object.fromEntries(
    [...SIDES, ...LOGICAL_SIDES].map((side): [string, Composer] => [
      `border-${side}`,
      (all) => edgeText(all, side),
    ]),
  ),
  // what `el.style` composes, from the same strings
  ...Object.fromEntries(
    ['position-try', 'scroll-timeline', 'view-timeline'].map(
      (name): [string, Composer] => [
        name,
        (all) => composeShorthand(name, (part) => all[part] ?? null) ?? '',
      ],
    ),
  ),
  // and here each list is as long as the names, as an animation takes them
  animation: (all) => {
    const count = splitCommas(all['animation-name']).length;
    return (
      composeShorthand('animation', (part) => {
        if (/^animation-(?:timeline|range)/.test(part)) return all[part];
        const list = splitCommas(all[part]);
        return Array.from(
          { length: count },
          (_, i) => list[i % list.length],
        ).join(', ');
      }) ?? ''
    );
  },
  border: everyEdge(SIDES),
  'border-radius': (_, style, scale) => {
    const across = style.borderRadius.map((r) => len(r, scale));
    if (!style.borderRadiusY) return shortest(across);
    const down = style.borderRadiusY.map((r) => len(r, scale));
    return `${shortest(across)} / ${shortest(down)}`;
  },
  'border-spacing': (_, style, scale) =>
    pair(px(style.borderSpacing, scale), px(style.borderSpacingY, scale)),
  'corner-shape': (_, style) =>
    shortest(style.cornerShape.map(cornerShapeText)),
  outline: (all) =>
    `${all['outline-color']} ${all['outline-style']} ${all['outline-width']}`,
  'scroll-margin': (_, style, scale) => shortest(scrollMargins(style, scale)),
  'scroll-padding': (_, style, scale) => shortest(scrollPaddings(style, scale)),
  background: backgroundText,
  'list-style': (all, style) => {
    const url = style.listStyleImage ? urlOf(style.listStyleImage) : null;
    const image = url === null ? 'none' : urlText(url);
    return `${style.listStylePosition} ${image} ${all['list-style-type']}`;
  },
  gap: (_, style, scale) => pair(...gapsOf(style, scale)),
  'grid-gap': (_, style, scale) => pair(...gapsOf(style, scale)),
  flex: (all, style) =>
    `${float6(style.flexGrow)} ${float6(style.flexShrink)} ${all['flex-basis']}`,
  'flex-flow': (_, style) => `${style.flexDirection} ${style.flexWrap}`,
  // `normal` is held as `stretch` here, but for a grid's `align-items`
  // (`settleAlign`), so a `stretch` written out reads as `normal`
  'place-content': (_, style) =>
    pair(
      style.alignContent === 'stretch' ? 'normal' : style.alignContent,
      style.justifyContent,
    ),
  'place-items': (_, style) =>
    pair(
      style.alignItems === 'stretch' && !style.grid
        ? 'normal'
        : style.alignItems,
      style.justifyItems,
    ),
  'place-self': (all) => pair(all['align-self'], all['justify-self']),
  'grid-row': (_, style) => gridAxisText(style.gridRowStart, style.gridRowEnd),
  'grid-column': (_, style) =>
    gridAxisText(style.gridColumnStart, style.gridColumnEnd),
  'grid-area': (_, style) => gridAreaText(style),
  columns: (_, style, scale) =>
    [
      style.columnWidth === null ? '' : px(style.columnWidth, scale),
      style.columnCount === null ? '' : String(style.columnCount),
    ]
      .filter(Boolean)
      .join(' ') || 'auto',
  'column-rule': (_, style, scale) => ruleText(style.columnRule, style, scale),
  'row-rule': (_, style, scale) => ruleText(style.rowRule, style, scale),
  rule: (_, style, scale) => {
    const column = ruleText(style.columnRule, style, scale);
    return column === ruleText(style.rowRule, style, scale) ? column : '';
  },
  transition: (_, style) => transitionText(style),
  'animation-range': (_, style, scale) => {
    const starts = style.animationRangeStart;
    const ends = style.animationRangeEnd;
    return starts.length === ends.length
      ? starts.map((e, i) => animationRangeText(e, ends[i], scale)).join(', ')
      : '';
  },
  container: (_, style) => {
    const type = [
      style.containerType === 'normal' ? '' : style.containerType,
      style.scrollStateContainer ? 'scroll-state' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const name = style.containerName || 'none';
    return type ? `${name} / ${type}` : name;
  },
  'text-wrap': (_, style) => {
    const nowrap = style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre';
    const kind = style.textWrapStyle;
    if (kind === 'auto') return nowrap ? 'nowrap' : 'wrap';
    return nowrap ? `nowrap ${kind}` : kind;
  },
};

/**
 * What a record of `cssomAt`'s inherits: each shorthand as a getter. A page
 * that reads `display` pays for no shorthand, where a hundred more strings in
 * every record would be half as much again on a read Apple's pages make tens
 * of thousands of times a load. So `JSON.stringify` and `Object.keys` see the
 * longhands, and a read by name sees the shorthands too.
 */
const COMPOSED: object = Object.create(
  null,
  Object.fromEntries(
    Object.entries(SHORTHANDS).map(([name, compose]) => [
      name,
      {
        get(this: Longhands): string {
          const [style, scale] = this[READ_FROM];
          return compose(this, style, scale);
        },
      },
    ]),
  ),
);

/** The shorthands a computed style answers by name, and that are no item of
 *  its list, which is of longhands: a page that copies a style item by item,
 *  as html2canvas does, would set them over those. */
export const SHORTHAND_NAMES: readonly string[] = Object.keys(SHORTHANDS);

/** A record's shorthands as they compose, all of them, for a page's realm. */
export function cssomShorthands(
  all: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SHORTHAND_NAMES) out[name] = all[name];
  return out;
}
