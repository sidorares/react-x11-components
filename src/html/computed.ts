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
import { animationItemText, easingText, secondsText } from './css/animation.js';
import type { Animations } from './css/animation.js';
import { RANGE_END, RANGE_START } from './css/triggers.js';
import type { RangeEdge } from './css/triggers.js';
import type { ClipPath, ComputedStyle, TimelineRef } from './css/style.js';
import type { Primitive, TransformFunction } from './css/transform.js';
import { matrix4Of, matrixOf } from './css/transform.js';
import type { Len } from './css/values.js';
import { inkColor } from './css/values.js';
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

/** An inset pair, the end left out where it is the start; null where
 *  both are `auto`. */
function insetText(inset: readonly [Len, Len], scale: number): string | null {
  const [a, b] = inset.map((v) => len(v, scale));
  if (a === 'auto' && b === 'auto') return null;
  return a === b ? a : `${a} ${b}`;
}

/** `scroll-timeline` or `view-timeline` from its longhands: each name,
 *  with its axis and inset where they are not the initial ones. */
function timelineShorthand(
  names: string,
  axes: string,
  insets: readonly (readonly [Len, Len])[] | null,
  scale: number,
): string {
  const axisList = axes.split(', ');
  const nameList = names.split(', ');
  // lists of other lengths make no shorthand (CSSOM 6.7.2)
  if (
    axisList.length !== nameList.length ||
    (insets && insets.length !== nameList.length)
  ) {
    return '';
  }
  return nameList
    .map((name, i) => {
      const axis = axisList[i % axisList.length];
      const inset = insets ? insetText(insets[i % insets.length], scale) : null;
      return [name, axis === 'block' ? '' : axis, inset ?? '']
        .filter(Boolean)
        .join(' ');
    })
    .join(', ');
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

/** Each `animation-*` longhand as it is resolved, and the `animation`
 *  shorthand, '' where it cannot say what its longhands do — a timeline or
 *  a range that is not the initial one, or lists of other lengths (CSS
 *  Animations 2, 4). An `auto` duration reads `0s` where the timeline is
 *  the clock's, and `auto` where it may not be. */
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
  const lists = [
    durations,
    easings,
    delays,
    iterations,
    a.directions,
    a.fillModes,
    a.playStates,
    names,
  ];
  const shorthand =
    onClock &&
    starts.length === 1 &&
    starts[0] === RANGE_START &&
    ends.length === 1 &&
    ends[0] === RANGE_END &&
    lists.every((l) => l.length === names.length)
      ? names
          .map((_, i) => animationItemText(lists.map((l) => l[i])))
          .join(', ')
      : '';
  return {
    animation: shorthand,
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
    'animation-range':
      starts.length === ends.length
        ? starts.map((e, i) => animationRangeText(e, ends[i], scale)).join(', ')
        : '',
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

/** A colour as CSSOM serializes it: `rgb()` opaque, `rgba()` not. */
export function cssomColor(value: string | null, color: string): string {
  if (value === null) return 'rgba(0, 0, 0, 0)';
  // `currentColor` itself, or in a mix or a contrast, is the element's
  const read = rgbaOf(inkColor(value, color));
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
 * and so its computed sizes, and the shorthands of four sides, the border
 * radii and the gaps, as CSSOM serializes them. Undefined for a property
 * none of that serializes.
 */
export function computedText(
  style: ComputedStyle,
  name: string,
  scale: number,
): string | undefined {
  // a style's lengths are zoomed, and a declaration reads them unzoomed
  scale *= style.effectiveZoom;
  const prop = name.toLowerCase();
  const xs = style.borderRadius;
  const ys = style.borderRadiusY ?? style.borderRadius;
  const corner = CORNERS.indexOf(prop);
  if (corner >= 0) {
    const x = len(xs[corner], scale);
    const y = len(ys[corner], scale);
    return x === y ? x : `${x} ${y}`;
  }
  if (prop === 'border-radius') {
    const across = shortest(xs.map((r) => len(r, scale)));
    if (!style.borderRadiusY) return across;
    return `${across} / ${shortest(ys.map((r) => len(r, scale)))}`;
  }
  const rowGap = style.rowGapNormal ? 'normal' : len(style.rowGap, scale);
  const columnGap = style.columnGapNormal
    ? 'normal'
    : len(style.columnGap, scale);
  if (prop === 'row-gap') return rowGap;
  if (prop === 'column-gap') return columnGap;
  if (prop === 'gap') {
    return rowGap === columnGap ? rowGap : `${rowGap} ${columnGap}`;
  }
  const all = cssomAt(style, scale, null);
  if (Object.hasOwn(all, prop)) return all[prop];
  const sides = FOUR_SIDES[prop];
  return sides ? shortest(sides.map((side) => all[side])) : undefined;
}

/**
 * An element's style as `getComputedStyle` answers it, by property name:
 * `box` where a layout gave the element one, for the used values of its
 * size and its edges. `scale` is device pixels to the CSS pixel. Its
 * lengths are as an unzoomed element's (CSS Viewport 1, 5): the style's
 * and the box's are divided by its effective zoom, as Chrome answers.
 */
export function cssomStyle(
  style: ComputedStyle,
  scale: number,
  box: UsedBox | null,
): Record<string, string> {
  return cssomAt(style, scale * style.effectiveZoom, box);
}

function cssomAt(
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
    'scroll-timeline': timelineShorthand(
      style.scrollTimelineName,
      style.scrollTimelineAxis,
      null,
      scale,
    ),
    'view-timeline': timelineShorthand(
      style.viewTimelineName,
      style.viewTimelineAxis,
      style.viewTimelineInset,
      scale,
    ),
    'anchor-name': style.anchorNames ? style.anchorNames.join(', ') : 'none',
    'anchor-scope': style.anchorScope,
    'position-anchor': style.positionAnchorText,
    'position-area': style.positionArea?.text
      ? positionAreaComputed(style.positionArea.text)
      : 'none',
    'position-try-order': style.positionTryOrder,
    'position-visibility': positionVisibilityText(style.positionVisibility),
    'position-try-fallbacks': tryFallbacksText(style.positionTryFallbacks),
    'position-try':
      style.positionTryOrder === 'normal'
        ? tryFallbacksText(style.positionTryFallbacks)
        : `${style.positionTryOrder} ${tryFallbacksText(style.positionTryFallbacks)}`,
    'view-transition-name': style.viewTransitionName,
    'view-transition-class': style.viewTransitionClass,
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
  // a transform resolves to the matrix its list comes to for the box
  // (CSSOM 9, "resolved value"), and with no box is the list it computes
  // to
  out.transform = !style.transform
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
