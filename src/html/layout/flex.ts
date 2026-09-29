// `display: flex`, delegated to Yoga.
//
// This is the one formatting context here that is *not* written out, and the
// reason is that the engine is already in the process. react-x11 lays every
// box out with Yoga and exports it as `react-x11/yoga` precisely so a package
// doing layout of its own does not bring a second copy — a node created by
// one instance cannot be inserted into a tree owned by another. So a flex
// container builds a small Yoga tree, asks it, and reads the answer back.
//
// Flexbox is also the algorithm where writing it out would be the *worst*
// trade: it is long, it is subtle (`flex-basis: auto` vs `content`, min-size
// floors, wrapping with `align-content`), and a wrong answer is silently
// wrong rather than obviously wrong. Block flow, floats and margin collapsing
// are none of those things, which is why they are written out here — the line
// is drawn at "would a bug be visible", not at "is there a library".
//
// The bridge in both directions is `setMeasureFunc`: every flex item is a
// leaf with a measure function, and the function lays the item's content out
// with *this* engine — which for a nested flex container means a second,
// independent Yoga pass inside the measure call. Not a nested Yoga node:
// that would need the whole child subtree mirrored into Yoga's tree, and the
// measure seam already answers the only question the outer pass asks. What
// the leaf shape costs is stretch — a stretched item's box grows but its
// contents are not re-laid at the stretched height.
import { Yoga, layoutLoaded } from 'react-x11/yoga';
import type { Config as YogaConfig, Node as YogaNode } from 'react-x11/yoga';

import { AUTO, gapOf, isPct, resolve, resolveOrNull } from '../css/values.js';
import { scrolls } from '../css/style.js';
import type { ComputedStyle, ContentSize } from '../css/style.js';
import { Box, PAINT_ORDER, isBlank } from './boxes.js';
import {
  FLEXED_HEIGHT,
  MIN_CONTENT_PROBE,
  clampHeight,
  clampWidth,
  contentSizedWidth,
  exactMinContent,
  intrinsicWidth,
  measureIntrinsicWidth,
  moveTo,
  percentBaseInside,
  percentHeightsIn,
  positionOutOfFlow,
  replacedRatio,
  transferredHeight,
  transferredWidth,
  heightFromWidth,
  widthFromHeight,
  resolveEdges,
} from './block.js';
import { layoutGrid } from './css-grid.js';
import { firstBaselineIn } from './inline.js';
import type { LayoutContext } from './block.js';

// `react-x11/yoga` re-exports yoga's own declarations, so the node shape and
// the enum constants are typed rather than written out here and cast at every
// call, which is what this had to do while the engine was reached through
// `react-x11/ntk` (a deliberately loose record).
const Y = Yoga;

/**
 * The config this engine's flex trees are made in: off the pixel grid, as
 * the rest of its layout is, since its paint snaps each box's edges. On
 * the grid, Yoga rounds a measured item's size up and the next item's
 * start to the nearest, and two items that met at a fraction overlapped
 * by a pixel. Its own, not core's, whose grid its own layout keeps.
 */
let config: YogaConfig | null = null;
function flexConfig(): YogaConfig {
  if (config === null) {
    config = Y.Config.create();
    config.setPointScaleFactor(0);
  }
  return config;
}

/**
 * Lay out a flex container's children. Returns the content height.
 *
 * Falls back to the block path when the engine's assembly has not loaded.
 * `createRoot()` awaits it, so the only way to reach that is a mock backend
 * with no root at all, where there are no pixels to be wrong about anyway.
 *
 * `layoutLoaded()` rather than probing `Yoga.Node`: until the assembly lands
 * that property is a getter that **throws** with a message about the engine
 * not being loaded, so the probe this used to do could not fall back — it
 * raised the very error it was written to avoid.
 */
export function layoutFlex(
  box: Box,
  ctx: LayoutContext,
  contentWidth: number,
): number {
  // a grid container is one of these to the box tree, and laid out apart
  if (box.style.grid) return layoutGrid(box, ctx, contentWidth);
  if (!layoutLoaded()) return layoutAsBlockFallback(box, ctx, contentWidth);
  // Each flex box in a flex item runs its Yoga pass inside the measure of
  // the one around it, and Yoga's own stack runs out at about a hundred and
  // fifty of them — a `RuntimeError` out of the layout. Past this many, one
  // is laid out as blocks: the markup of a broken page, not of a design.
  const depth = ctx.flexDepth ?? 0;
  if (depth >= FLEX_DEPTH) return layoutAsBlockFallback(box, ctx, contentWidth);

  const root = Y.Node.create(flexConfig());
  applyContainer(root, box.style);
  // the gaps, a percentage of the content box's size along them where it
  // has one, and else of nothing (CSS Box Alignment 3, 8.3)
  const rowGap = gapOf(box.style.rowGap, percentBaseInside(box));
  const columnGap = gapOf(box.style.columnGap, contentWidth);
  if (rowGap) root.setGap(Y.GUTTER_ROW, rowGap);
  if (columnGap) root.setGap(Y.GUTTER_COLUMN, columnGap);
  // Laid out at no width limit — a flex item's max-content measured, a
  // table column's — the container is as wide as its content, which Yoga
  // works out from an `auto` width. Handed an infinite one, it took it for
  // a width, grew a `flex: 1` item to fill it, placed its text at 1.7e38,
  // and the measure that asked came back vast: a row beside such an item
  // was squeezed to wrap every word.
  const bounded = Number.isFinite(contentWidth);
  if (bounded) root.setWidth(contentWidth);
  // The content box's height, where it is definite: a length or a
  // percentage that resolves, or what `aspect-ratio` makes of the width —
  // less the padding and borders a `border-box` height holds, which put
  // `h-16 py-2 items-center` eight pixels low. Where it is not, the limits
  // on it, so a column `min-h-screen` gives its `flex-1` the rest.
  const definite = percentBaseInside(box);
  const height = Number.isFinite(definite) ? definite : null;
  if (height !== null) root.setHeight(height);
  else {
    root.setHeightAuto();
    const extra = box.verticalExtra;
    const min = clampHeight(box, extra) - extra;
    if (min > 0) root.setMinHeight(min);
    const max = clampHeight(box, Infinity) - extra;
    if (Number.isFinite(max)) root.setMaxHeight(Math.max(0, max));
  }

  const flowing: Box[] = [];
  let reordered = false;
  for (const child of box.children) {
    if (child.kind === 'text' && isBlank(child.text)) continue;
    if (child.outOfFlow) {
      positionOutOfFlow(child, box, ctx, true);
      continue;
    }
    if (child.style.order !== 0) reordered = true;
    flowing.push(child);
  }
  // in `order`, and where two have the same, in the document's (CSS
  // Flexbox 5.4): Yoga places its children in the order they were given,
  // and paint paints them in it
  if (reordered) {
    flowing.sort((a, b) => a.style.order - b.style.order);
    PAINT_ORDER.set(
      box,
      [...box.children].sort((a, b) => orderOf(a) - orderOf(b)),
    );
  } else PAINT_ORDER.delete(box);

  const items: { box: Box; node: YogaNode; laid: Laid }[] = [];
  for (const child of flowing) {
    const node = Y.Node.create(flexConfig());
    resolveEdges(child, contentWidth);
    const laid: Laid = { width: NaN, height: NaN, set: NaN, stretch: NaN };
    applyItem(node, child, ctx, contentWidth, laid, height !== null);
    root.insertChild(node, items.length);
    items.push({ box: child, node, laid });
  }

  const direction =
    box.style.direction === 'rtl' ? Y.DIRECTION_RTL : Y.DIRECTION_LTR;
  const row = box.style.flexDirection.startsWith('row');
  const calculate = (): void =>
    root.calculateLayout(
      bounded ? contentWidth : Number.NaN,
      height ?? Number.NaN,
      direction,
    );
  ctx.flexDepth = depth + 1;
  try {
    calculate();
    // an item Yoga shrank under what its content comes to is kept to it,
    // and the row is laid out again (`autoMinimums`) — which may shrink
    // another under its own, a few times over at most
    for (
      let pass = 0;
      pass < 4 && autoMinimums(items, row, ctx, contentWidth);
      pass += 1
    ) {
      calculate();
    }
  } finally {
    ctx.flexDepth = depth;
  }

  // Yoga aligns the lines of a box that wraps, or aligns by baselines, in
  // one pass of its own, which drops a margin (`lineMarginFix`)
  const baselines =
    box.style.alignItems === 'baseline' ||
    items.some(({ box: child }) => child.style.alignSelf === 'baseline');
  let bottom = placeItems(
    box,
    ctx,
    items,
    row,
    height,
    box.style.flexWrap === 'wrap' || baselines,
  );
  // Items aligned by their baselines, which Yoga cannot see, are aligned
  // with their baselines known (`baselineLines`)
  // by the flex layout again, set at their lines' starts with the margins
  // that put their baselines together, which makes each line as tall as
  // that does
  const lines = row && baselines ? baselineLines(box.style, items) : null;
  if (lines) {
    // every one of them, and the box's own `baseline` too, which is what
    // takes Yoga down that pass
    const started = new Set<Box>();
    for (const line of lines) {
      line.forEach(({ box: child, node }, i) => {
        node.setAlignSelf(Y.ALIGN_FLEX_START);
        node.setMargin(Y.EDGE_TOP, line.margins[i]);
        started.add(child);
      });
    }
    if (box.style.alignItems === 'baseline') {
      root.setAlignItems(Y.ALIGN_FLEX_START);
    }
    ctx.flexDepth = depth + 1;
    try {
      calculate();
    } finally {
      ctx.flexDepth = depth;
    }
    bottom = placeItems(
      box,
      ctx,
      items,
      row,
      height,
      box.style.flexWrap === 'wrap',
      started,
    );
  }

  // A replaced item with a ratio that is stretched across a line of a
  // definite size takes its flex base size from the stretched one through
  // the ratio (CSS Flexbox 9.2 and 9.8), where Yoga took its natural size —
  // which Yoga's own `aspectRatio` would do for its border box, where a
  // replaced element's ratio is its content box's. Laid out again with it.
  // where the line's cross size is definite: one line, in a box of that
  // size of its own (9.8)
  const definiteCross =
    box.style.flexWrap === 'nowrap' && (row ? height !== null : bounded);
  if (definiteCross && keepRatios(box, items, row)) {
    ctx.flexDepth = depth + 1;
    try {
      calculate();
    } finally {
      ctx.flexDepth = depth;
    }
    bottom = placeItems(
      box,
      ctx,
      items,
      row,
      height,
      box.style.flexWrap === 'wrap' || baselines,
    );
  }

  const contentHeight = root.getComputedHeight();
  root.freeRecursive();
  return Math.max(contentHeight, bottom - box.contentY);
}

/** Give each replaced item with a ratio that its line stretched the flex
 *  base size the ratio makes of the stretched size; whether any changed. */
function keepRatios(
  container: Box,
  items: readonly { box: Box; node: YogaNode }[],
  row: boolean,
): boolean {
  let changed = false;
  for (const { box, node } of items) {
    if (box.kind !== 'replaced' || !stretches(box, container.style, row)) {
      continue;
    }
    const style = box.style;
    if ((row ? style.width : style.height) !== AUTO) continue;
    const ratio = replacedRatio(box);
    if (!(ratio > 0)) continue;
    const basis = row
      ? Math.max(0, node.getComputedHeight() - box.verticalExtra) * ratio +
        box.horizontalExtra
      : Math.max(0, node.getComputedWidth() - box.horizontalExtra) / ratio +
        box.verticalExtra;
    const main = row ? node.getComputedWidth() : node.getComputedHeight();
    if (Math.abs(basis - main) < 0.5) continue;
    node.setFlexBasis(basis);
    changed = true;
  }
  return changed;
}

/**
 * A replaced row item's automatic least width, its border box (CSS
 * Flexbox 4.5): its natural width, or through its ratio what a height of
 * its own makes of it, and no more than a width of its own, within its
 * `max-width`. Null where it has neither a natural width nor a ratio to
 * take one through.
 */
function replacedMinimum(box: Box, containingWidth: number): number | null {
  const style = box.style;
  const own = box.intrinsic;
  const ratio = replacedRatio(box);
  const hx = style.boxSizing === 'border-box' ? box.horizontalExtra : 0;
  const vx = style.boxSizing === 'border-box' ? box.verticalExtra : 0;
  const base = box.percentHeightBase;
  const height = resolveOrNull(style.height, base);
  let content: number | null =
    height !== null && ratio > 0
      ? Math.max(0, height - vx) * ratio
      : own && !(own.missing & 1)
        ? own.width
        : null;
  if (content === null) return null;
  // and through its ratio, within its least and greatest heights
  if (ratio > 0) {
    const least =
      style.minHeight === AUTO ? null : resolveOrNull(style.minHeight, base);
    if (least !== null)
      content = Math.max(content, Math.max(0, least - vx) * ratio);
    const most =
      style.maxHeight === 'none' ? null : resolveOrNull(style.maxHeight, base);
    if (most !== null)
      content = Math.min(content, Math.max(0, most - vx) * ratio);
  }
  const width = resolveOrNull(style.width, containingWidth);
  if (width !== null) content = Math.min(content, Math.max(0, width - hx));
  if (style.maxWidth !== 'none') {
    const most = resolveOrNull(style.maxWidth, containingWidth);
    if (most !== null) content = Math.min(content, Math.max(0, most - hx));
  }
  return content + box.horizontalExtra;
}

/** A row item's `flex-basis: content`, its border box: its max-content
 *  width, or a replaced element's natural one. */
function contentBasis(
  box: Box,
  ctx: LayoutContext,
  containingWidth: number,
): number {
  if (box.kind === 'replaced') {
    const own = box.intrinsic;
    if (own && !(own.missing & 1)) return own.width + box.horizontalExtra;
  }
  // a ratio's is a definite height through it, whatever the width says
  const fromRatio = ratioBasis(box);
  if (fromRatio !== null) return fromRatio;
  const room = Math.max(0, containingWidth - box.marginLeft - box.marginRight);
  return contentSizedWidth(box, ctx, 'max-content', room, containingWidth);
}

/**
 * The border-box width a row item's ratio makes of a definite height: its
 * own, a length or a percentage of a flex box of a definite height, or the
 * one line of such a flex box that stretches it across (CSS Flexbox 9.2,
 * 9.4). Null where it has no ratio or no such height.
 */
function ratioBasis(box: Box): number | null {
  const style = box.style;
  const aspect = style.aspectRatio;
  const flex = box.parent;
  if (!aspect || box.kind === 'replaced' || !flex) return null;
  const room = percentBaseInside(flex);
  let height = resolveOrNull(style.height, room);
  let outer: number;
  if (height !== null) {
    outer =
      style.boxSizing === 'border-box'
        ? Math.max(height, box.verticalExtra)
        : height + box.verticalExtra;
  } else {
    const align =
      style.alignSelf === AUTO ? flex.style.alignItems : style.alignSelf;
    if (
      align !== 'stretch' ||
      flex.style.flexWrap !== 'nowrap' ||
      !Number.isFinite(room) ||
      style.marginTop === AUTO ||
      style.marginBottom === AUTO
    ) {
      return null;
    }
    height = room - box.marginTop - box.marginBottom;
    outer = Math.max(height, box.verticalExtra);
  }
  return widthFromHeight(box, clampHeight(box, outer));
}

/** A column item's flex base size where it has a ratio and a width of
 *  its own, its border box: the width, within its limits, through the
 *  ratio. */
function ratioHeightBasis(box: Box, containingWidth: number): number | null {
  const style = box.style;
  if (style.width === AUTO || style.widthKeyword || box.kind === 'replaced') {
    return null;
  }
  const set = resolveOrNull(style.width, containingWidth);
  if (set === null) return null;
  const outer =
    style.boxSizing === 'border-box'
      ? Math.max(set, box.horizontalExtra)
      : set + box.horizontalExtra;
  return heightFromWidth(box, clampWidth(box, outer, containingWidth));
}

/** A child's `order`, which an absolutely positioned one takes as 0 when
 *  it is painted among the items. */
function orderOf(box: Box): number {
  return box.outOfFlow || box.kind === 'text' ? 0 : box.style.order;
}

/** Lay each item out where the flex layout put it, at the size it gave it,
 *  and answer where the lowest ends. `started` are items set at their
 *  lines' starts whatever their own alignment says (`baselineLines`). */
function placeItems(
  box: Box,
  ctx: LayoutContext,
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
  row: boolean,
  height: number | null,
  /** Whether Yoga aligned the lines in its pass that drops a margin. */
  lined: boolean,
  started?: ReadonlySet<Box>,
): number {
  let bottom = 0;
  for (const { box: child, node, laid } of items) {
    const across = lined
      ? lineMarginFix(box.style, child, node, row, started?.has(child))
      : 0;
    const left = box.contentX + node.getComputedLeft() + (row ? 0 : across);
    const top = box.contentY + node.getComputedTop() + (row ? across : 0);
    const width = meant(
      node.getComputedWidth(),
      laid.set,
      laid.stretch,
      laid.width,
    );
    const itemHeight = node.getComputedHeight();
    // The item is laid out again at the width the flex pass settled on: the
    // measure function answered a question, and the answer is not a layout —
    // its line breaks were computed against a width that may have changed
    // when a sibling grew. Unless the last answer was at that width, which
    // is a layout the item still has (Yoga's widths are float32s).
    // Its height is definite where the flex layout made it so (CSS Flexbox
    // 9.8): stretched across a row's line, or flexed in a column of a
    // height of its own. What is in it takes its percentages of that —
    // the `h-full` in a stretched sidebar — where they had nothing to be
    // of, and the item is laid out again for them.
    const definite = row
      ? stretches(child, box.style)
        ? itemHeight
        : null
      : height !== null
        ? itemHeight
        : null;
    layoutItemAt(
      child,
      ctx,
      left,
      top,
      width,
      itemHeight,
      laid,
      definite,
      !row,
    );
    bottom = Math.max(bottom, top + child.height);
  }
  return bottom;
}

function layoutItemAt(
  box: Box,
  ctx: LayoutContext,
  x: number,
  y: number,
  width: number,
  height: number,
  laid: Laid,
  /** Its border box's height where the flex layout made it definite. */
  definite: number | null,
  /** Whether its height is the one the flex layout gave it, in a column,
   *  whatever its own says: flexed, it is shrunk as well as grown. */
  column = false,
): void {
  // a replaced item is the size the flex layout made it — flexed,
  // stretched — which its natural size was only the start of
  if (box.kind === 'text' || box.kind === 'break' || box.kind === 'replaced') {
    box.x = x;
    box.y = y;
    box.width = width;
    box.height = height;
    return;
  }
  const inner =
    definite === null || !percentHeightsIn(box)
      ? null
      : Math.max(0, definite - box.verticalExtra);
  if (inner !== null && !Object.is(inner, percentBaseInside(box))) {
    FLEXED_HEIGHT.set(box, inner);
    try {
      ctx.layoutSubtree(box, width);
    } finally {
      FLEXED_HEIGHT.delete(box);
    }
  }
  // `measureBox` lays the box out at (0, 0); re-running it at the final width
  // and then moving it is one pass, not two, because the second call is the
  // one whose result is kept — or no pass, where the last measure was at
  // this width. An item Yoga never measured has none, NaN, and is laid out.
  else if (Math.abs(laid.width - width) <= 0.01) box.height = laid.height;
  else ctx.layoutSubtree(box, width);
  // A stretched item is taller than its content, and the box has to say so
  // or its background stops short of the row — and it is no taller than its
  // line where its content is, or than what its ratio makes of its width:
  // its height is the line's (CSS Flexbox 9.4, step 11).
  if (height > box.height || column || definite !== null) box.height = height;
  moveTo(box, x, y);
}

// What a new Yoga node already is is not said again. A call into the
// engine costs more than the arithmetic it asks for, and a Tailwind page is
// a flex box in every list item: saying every default made the calls into
// Yoga two fifths of laying one out. A node's defaults are column, no wrap,
// start, stretch, start (for its lines), no growing, no shrinking, `auto`
// basis and size, and nothing on any edge.

function applyContainer(node: YogaNode, style: ComputedStyle): void {
  const direction = FLEX_DIRECTION[style.flexDirection] ?? Y.FLEX_DIRECTION_ROW;
  if (direction !== Y.FLEX_DIRECTION_COLUMN) node.setFlexDirection(direction);
  const wrap = WRAP[style.flexWrap] ?? Y.WRAP_NO_WRAP;
  if (wrap !== Y.WRAP_NO_WRAP) node.setFlexWrap(wrap);
  const justify = JUSTIFY[mainJustify(style)] ?? Y.JUSTIFY_FLEX_START;
  if (justify !== Y.JUSTIFY_FLEX_START) node.setJustifyContent(justify);
  const items = ALIGN[style.alignItems] ?? Y.ALIGN_STRETCH;
  if (items !== Y.ALIGN_STRETCH) node.setAlignItems(items);
  const lines = ALIGN[style.alignContent] ?? Y.ALIGN_STRETCH;
  if (lines !== Y.ALIGN_FLEX_START) node.setAlignContent(lines);
}

function applyItem(
  node: YogaNode,
  box: Box,
  ctx: LayoutContext,
  containingWidth: number,
  laid: Laid,
  /** Whether the flex box has a height of its own. */
  tall: boolean,
): void {
  const style = box.style;
  laid.stretch = containingWidth - box.marginLeft - box.marginRight;
  // an `auto` margin takes the free space on its side, which is how
  // `margin-left: auto` puts an item at the end of its row (CSS Flexbox
  // 8.1); Yoga does that itself
  const margin = (edge: number, len: unknown, px: number) => {
    if (len === AUTO) node.setMarginAuto(edge);
    else if (px) node.setMargin(edge, px);
  };
  margin(Y.EDGE_TOP, style.marginTop, box.marginTop);
  margin(Y.EDGE_RIGHT, style.marginRight, box.marginRight);
  margin(Y.EDGE_BOTTOM, style.marginBottom, box.marginBottom);
  margin(Y.EDGE_LEFT, style.marginLeft, box.marginLeft);
  if (style.flexGrow) node.setFlexGrow(style.flexGrow);
  if (style.flexShrink) node.setFlexShrink(style.flexShrink);
  if (style.alignSelf !== AUTO)
    node.setAlignSelf(ALIGN[style.alignSelf] ?? Y.ALIGN_AUTO);

  // Yoga's sizes are border boxes, as `box-sizing: border-box` has them;
  // a `content-box` length is the content's, and the item's padding and
  // border go on top of it
  const across = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
  const down = style.boxSizing === 'border-box' ? 0 : box.verticalExtra;
  if (style.width !== AUTO) {
    laid.set = setLength(node, true, style.width, containingWidth, across);
  }
  if (style.height !== AUTO) setLength(node, false, style.height, NaN, down);
  const minWidth = resolveOrNull(style.minWidth, containingWidth);
  if (minWidth !== null) node.setMinWidth(minWidth + across);
  if (style.maxWidth !== 'none') {
    const maxWidth = resolveOrNull(style.maxWidth, containingWidth);
    if (maxWidth !== null) node.setMaxWidth(maxWidth + across);
  }
  if (style.widthKeyword || style.minWidthKeyword || style.maxWidthKeyword) {
    // an intrinsic size is the item's content's, measured here and handed
    // over as a length: `w-fit` in a column is not stretched across it,
    // and `min-w-max` in a row does not shrink below its content
    const room = Math.max(
      0,
      containingWidth - box.marginLeft - box.marginRight,
    );
    const size = (keyword: ContentSize): number =>
      contentSizedWidth(box, ctx, keyword, room, containingWidth);
    if (style.widthKeyword) {
      laid.set = size(style.widthKeyword);
      node.setWidth(laid.set);
    }
    if (style.minWidthKeyword) node.setMinWidth(size(style.minWidthKeyword));
    if (style.maxWidthKeyword) node.setMaxWidth(size(style.maxWidthKeyword));
  }
  const minHeight = resolveOrNull(style.minHeight, NaN);
  if (minHeight !== null) node.setMinHeight(minHeight + down);
  if (style.maxHeight !== 'none') {
    const maxHeight = resolveOrNull(style.maxHeight, NaN);
    if (maxHeight !== null) node.setMaxHeight(maxHeight + down);
  }

  const row = box.parent?.style.flexDirection.startsWith('row') ?? true;
  // Yoga takes a length for a basis only where the flex box's main size is
  // definite, and else the item's own size along it: down a column of no
  // height of its own it read `flex: 0 0 3rem` as the item's height, or
  // its content's. There the basis is handed over as that height, which is
  // what the item's own is to a basis anyway — no more than its start
  const setBasis = (px: number): void => {
    if (row || tall) node.setFlexBasis(px);
    else node.setHeight(px);
  };
  // down a column, an item with a ratio and a width is as tall as that
  // makes it, for a basis of its content or of its own `auto` height (CSS
  // Flexbox 9.2.3, B) — where Yoga measured it, and its block layout held
  // it to its content (CSS Sizing 4, 5.2), which only its automatic
  // minimum does here (`autoMinimums`)
  const columnBasis =
    !row &&
    (style.flexBasis === 'content' ||
      (style.flexBasis === AUTO && style.height === AUTO))
      ? ratioHeightBasis(box, containingWidth)
      : null;
  if (style.flexBasis === 'content' && row) {
    // the content's size along a row, whatever the item's own width says
    // (CSS Flexbox 7.2.3), which Yoga reads as `auto` and takes the width
    // for; along a column, Yoga's measure is the content's
    node.setFlexBasis(contentBasis(box, ctx, containingWidth));
  } else if (columnBasis !== null) {
    // but a height of its own hides it from Yoga, and an item with a ratio
    // and a width is as tall as that makes it
    setBasis(columnBasis);
  } else if (style.flexBasis === 'content' || style.flexBasis === AUTO) {
    // Yoga's own
  } else if (isPct(style.flexBasis)) {
    // a percentage of the main size, which is known across a row
    const basis = style.flexBasis;
    if (!basis.px && !basis.of) node.setFlexBasisPercent(basis.pct);
    else if (row && Number.isFinite(containingWidth)) {
      node.setFlexBasis(resolve(basis, containingWidth));
    } else if (basis.of) node.setFlexBasisAuto();
    else node.setFlexBasisPercent(basis.pct);
  } else setBasis(style.flexBasis + (row ? across : down));

  // The item's padding and border belong to Yoga so it can size the item,
  // and to this engine so it can paint it. Both read the same numbers.
  if (box.padTop) node.setPadding(Y.EDGE_TOP, box.padTop);
  if (box.padRight) node.setPadding(Y.EDGE_RIGHT, box.padRight);
  if (box.padBottom) node.setPadding(Y.EDGE_BOTTOM, box.padBottom);
  if (box.padLeft) node.setPadding(Y.EDGE_LEFT, box.padLeft);
  if (box.borderTop) node.setBorder(Y.EDGE_TOP, box.borderTop);
  if (box.borderRight) node.setBorder(Y.EDGE_RIGHT, box.borderRight);
  if (box.borderBottom) node.setBorder(Y.EDGE_BOTTOM, box.borderBottom);
  if (box.borderLeft) node.setBorder(Y.EDGE_LEFT, box.borderLeft);

  // Yoga asks; this engine answers. That is the whole of the bridge, and it
  // is what lets a paragraph be a flex item without flex knowing what a
  // paragraph is.
  // Its max-content width is the same at every width Yoga asks at, and at
  // every layout the box has, so it is taken once in the box's life, as a
  // table cell's is: taken per layout of the container, a flex box in a
  // flex box in a flex box laid its innermost out three times a level,
  // and twelve levels took two seconds.
  const alongRow = box.parent?.style.flexDirection.startsWith('row') ?? true;
  const content = (): number => {
    // a replaced element's is the width it has with no limit — its
    // natural one, or what its ratio makes of a height of its own — which
    // its image, loading, may change, so it is not kept; taken as its
    // content's, it was none, and Yoga measured an image as nothing wide
    if (box.kind === 'replaced') {
      ctx.layoutSubtree(box, Infinity);
      return Math.max(0, box.width - box.horizontalExtra);
    }
    // an item with a ratio and a definite height is that height through
    // its ratio wide: its flex base size along a row (CSS Flexbox 9.2.3)
    const fromRatio =
      alongRow && style.width === AUTO && !style.widthKeyword
        ? ratioBasis(box)
        : null;
    if (fromRatio !== null) return Math.max(0, fromRatio - box.horizontalExtra);
    let width = MAX_CONTENT.get(box);
    if (width === undefined) {
      width = measureIntrinsicWidth(box, ctx, Infinity) - box.horizontalExtra;
      MAX_CONTENT.set(box, width);
    }
    // within what its least and greatest heights make of widths through
    // its ratio: its size before it is flexed, and not after
    const extra = box.horizontalExtra;
    return Math.max(0, transferredWidth(box, width + extra) - extra);
  };
  // An item with a ratio is as wide, across a column, as the height it
  // was given makes it through the ratio, where its width is its own to
  // find (CSS Flexbox 9.4, its hypothetical cross size from its used main
  // size); and a replaced one is as tall, along a row, as the width it was
  // given makes it, where its height is — which a replaced element's
  // layout, sized by its own style, does not know.
  const ratio = box.kind === 'replaced' ? replacedRatio(box) : 0;
  const widthThrough =
    !alongRow && style.width === AUTO && !style.widthKeyword
      ? (height: number): number | null =>
          box.kind === 'replaced'
            ? ratio > 0
              ? height * ratio
              : null
            : (() => {
                const width = widthFromHeight(box, height + box.verticalExtra);
                return width === null
                  ? null
                  : Math.max(0, width - box.horizontalExtra);
              })()
      : null;
  // and an answer Yoga asks for twice is the layout the item already has
  const answers = new Map<number, { width: number; height: number }>();
  node.setMeasureFunc((w, wm, h, hm) => {
    // the width Yoga gave, as this engine meant it (`meant`)
    const extra = box.horizontalExtra;
    const width = meant(w, laid.set - extra, laid.stretch - extra);
    const given = hm === Y.MEASURE_MODE_EXACTLY && Number.isFinite(h);
    const exact = wm === Y.MEASURE_MODE_EXACTLY && Number.isFinite(width);
    const through = widthThrough && given && !exact ? widthThrough(h) : null;
    // along a row, a replaced element is its own width wherever there is
    // room for less — its flex base size is not fitted to the room (9.2)
    // — and across a column it is fitted, as any item is
    const inner =
      through !== null
        ? through
        : box.kind === 'replaced' && alongRow && !exact
          ? content()
          : innerWidth(width, wm, content);
    if (
      box.kind === 'replaced' &&
      exact &&
      ratio > 0 &&
      style.height === AUTO
    ) {
      return { width: inner, height: inner / ratio };
    }
    let answer = answers.get(inner);
    if (answer === undefined) {
      answer = measureBox(box, ctx, inner);
      answers.set(inner, answer);
      laid.width = box.width;
      laid.height = box.height;
    }
    return answer;
  });
}

/** How wide an item's content is as the box is laid out: its max-content
 *  width, measured the once (`applyItem`). Keyed by the box, whose lifetime
 *  is the cache's: any change to what is in it rebuilds it. */
const MAX_CONTENT = new WeakMap<Box, number>();

/** The width and height of the layout an item was last given, its border
 *  box's: what the final pass keeps where the width is the same. */
interface Laid {
  width: number;
  height: number;
  /** The border-box width this engine set on the item's node — a length,
   *  or the content's for `fit-content` and its kin — or NaN. */
  set: number;
  /** Its border-box width stretched across its container: the container's
   *  content width, less its margins. */
  stretch: number;
}

/**
 * Whether two widths are the same to a float32's precision. Yoga keeps
 * every length as a float32, a few of its own operations deep, and hands
 * back a width this engine meant rounded — down as often as up.
 */
function nearly(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 2 ** -20;
}

/**
 * Yoga's width for an item, as this engine meant it: the first of
 * `intended` it is the float32 of, or its own where it is none of them. A
 * box exactly as wide as its text — `width: fit-content` in a column, an
 * item as wide as its content in a row, a flex box sized to what it holds —
 * came back a hair narrower than the text, and laid out there its last word
 * wrapped: meetup.com's "About us" and "Related topics" were two lines.
 */
function meant(width: number, ...intended: number[]): number {
  for (const w of intended) {
    if (Number.isFinite(w) && nearly(width, w)) return w;
  }
  return width;
}

/** Set a length on the node; the points it set, or NaN where it set a
 *  percentage, which Yoga resolves, or nothing. */
function setLength(
  node: YogaNode,
  across: boolean,
  len: ComputedStyle['width'],
  base: number,
  /** Padding and border a `content-box` length goes without. */
  extra: number,
): number {
  const px = (v: number) => {
    if (across) node.setWidth(v);
    else node.setHeight(v);
    return v;
  };
  const percent = (v: number) => {
    if (across) node.setWidthPercent(v);
    else node.setHeightPercent(v);
    return NaN;
  };
  if (len === AUTO) return NaN;
  if (isPct(len)) {
    // Yoga takes a percentage or points, not both: `calc(100% - 20px)`
    // resolves here where its base is known, and so does a percentage with
    // padding to add, and a percentage is kept alone where it is not
    if (!len.px && !len.of && !extra) return percent(len.pct);
    if (Number.isFinite(base)) return px(resolve(len, base) + extra);
    if (len.of) return NaN;
    return percent(len.pct);
  }
  return px(len + extra);
}

/**
 * The size of an item's content, the measure function's answer. Yoga holds
 * the item's padding and border and adds them itself, so this answers
 * inside them: a border box here was an item its padding's height taller
 * than a browser draws it. Asked for a width it may take up to, or none,
 * an item is as wide as its content, its max-content width (CSS Flexbox
 * 9.2, `flex-basis: auto`), rather than as wide as the row; asked for one
 * exactly, it is that wide. Its height is its content's at that width.
 */
function measureBox(
  box: Box,
  ctx: LayoutContext,
  inner: number,
): { width: number; height: number } {
  ctx.layoutSubtree(box, inner + box.horizontalExtra);
  return {
    width: inner,
    height: Math.max(0, box.height - box.verticalExtra),
  };
}

/** The width an item's content is measured at: the width Yoga gives it
 *  exactly, or its max-content width, no wider than any it may take up to
 *  (CSS Flexbox 9.2). */
function innerWidth(
  width: number,
  mode: number,
  maxContent: () => number,
): number {
  if (mode === Y.MEASURE_MODE_EXACTLY && Number.isFinite(width)) {
    return Math.max(0, width);
  }
  const content = maxContent();
  if (mode !== Y.MEASURE_MODE_AT_MOST || !Number.isFinite(width)) {
    return content;
  }
  // a room exactly as wide as the content, as Yoga holds it, is room for it
  return content <= width || nearly(content, width)
    ? content
    : Math.max(0, width);
}

/**
 * An item's automatic minimum (CSS Flexbox 4.5): with `min-width: auto` in
 * a row, or `min-height: auto` in a column, an item its content sizes is no
 * smaller along the row than its content comes to — its min-content width,
 * or its content's height at its width.
 * Yoga has no such minimum, and shrank an item under a long word or a
 * column's content, which ran out over the next one; `min-w-0` is what
 * lets an item shrink past it, and so `auto` is kept apart from 0.
 *
 * Asked of an item only where its content overflows it at the size Yoga
 * gave it, laid out there as the final pass would lay it out and keeps
 * (`Laid`), so a row with room pays for nothing. True where some item
 * was given a minimum and the row has to be laid out again.
 */
function autoMinimums(
  items: { box: Box; node: YogaNode; laid: Laid }[],
  row: boolean,
  ctx: LayoutContext,
  containingWidth: number,
): boolean {
  let changed = false;
  for (const { box, node, laid } of items) {
    if (box.kind === 'text' || box.kind === 'break') continue;
    const style = box.style;
    // a box that scrolls or clips has none, but for one that asks for its
    // content's height
    const asked = !row && style.minHeightKeyword !== null;
    if (!asked && scrolls(style)) {
      continue;
    }
    const width = meant(
      node.getComputedWidth(),
      laid.set,
      laid.stretch,
      laid.width,
    );
    // a replaced item's content along a row is its natural width
    if (row && box.kind === 'replaced') {
      if (style.minWidth !== AUTO || style.minWidthKeyword) continue;
      const least = replacedMinimum(box, containingWidth);
      if (least === null || width >= least - 0.01) continue;
      node.setMinWidth(least);
      changed = true;
      continue;
    }
    // An item with a ratio and a definite height is along a row as wide
    // as that height makes it, or as its content at its narrowest where
    // that is wider (4.5's content size suggestion, its min-content size
    // through the ratio, and CSS Sizing 4, 5.2) — and no wider for it
    // than a width of its own
    if (
      row &&
      box.kind !== 'replaced' &&
      style.minWidth === AUTO &&
      !style.minWidthKeyword
    ) {
      const through = ratioBasis(box);
      if (through !== null) {
        let least = Math.max(through, minContentOf(box, ctx, laid));
        const own = resolveOrNull(style.width, containingWidth);
        const extra =
          style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
        if (own !== null) least = Math.min(least, own + extra);
        if (style.maxWidth !== 'none') {
          const most = resolveOrNull(style.maxWidth, containingWidth);
          if (most !== null) least = Math.min(least, most + extra);
        }
        if (width >= least - 0.01) continue;
        node.setMinWidth(least);
        changed = true;
        continue;
      }
    }
    if (
      row
        ? style.minWidth !== AUTO || style.minWidthKeyword || style.widthKeyword
        : style.minHeight !== AUTO && !asked
    ) {
      continue;
    }
    // One with a width of its own is no narrower along a row than the
    // lesser of that width and its content at its narrowest (4.5's
    // specified and content size suggestions): a `width: 250px` sidebar
    // with `flex-basis: 0` is 250 wide beside the item that takes the
    // rest, and one holding a longer word is still no wider than 250
    if (row && style.width !== AUTO) {
      const own = resolveOrNull(style.width, containingWidth);
      if (own === null) continue;
      const extra = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
      let least = own + extra;
      if (style.maxWidth !== 'none') {
        const most = resolveOrNull(style.maxWidth, containingWidth);
        if (most !== null) least = Math.min(least, most + extra);
      }
      if (width >= least - 0.01) continue;
      least = Math.min(least, minContentOf(box, ctx, laid));
      if (node.getComputedWidth() >= least - 0.01) continue;
      node.setMinWidth(least);
      changed = true;
      continue;
    }
    // no narrower than its content at its widest, where Yoga measured that
    // — and than what a ratio makes of its least height, which a content
    // no wider may still be held to
    const widest = row ? MAX_CONTENT.get(box) : undefined;
    if (
      widest !== undefined &&
      transferredWidth(box, widest + box.horizontalExtra) <= width + 0.5
    ) {
      continue;
    }
    if (!(Math.abs(laid.width - width) <= 0.01)) {
      ctx.layoutSubtree(box, width);
      laid.width = box.width;
      laid.height = box.height;
    }
    let least: number;
    if (row) {
      // or than what it drew at the width it has: nothing overflows it
      const drawn = intrinsicWidth(box) + box.horizontalExtra;
      if (transferredWidth(box, drawn) <= width + 0.5) continue;
      // within what a ratio makes of its least and greatest heights (4.5's
      // content size suggestion)
      least = transferredWidth(box, minContentOf(box, ctx, laid));
      const extra = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
      if (style.maxWidth !== 'none') {
        const most = resolveOrNull(style.maxWidth, containingWidth);
        if (most !== null) least = Math.min(least, most + extra);
      }
      if (node.getComputedWidth() >= least - 0.01) continue;
      node.setMinWidth(least);
    } else {
      // its height, or where it has one of its own and its content comes to
      // less, its content's: the lesser of the two (4.5)
      let content: number;
      if (box.kind === 'replaced') content = laid.height;
      else if (style.height !== AUTO && percentHeightsIn(box)) {
        // what its content comes to where it has no height to take
        // percentages of, as an intrinsic size is measured: laid out so
        // apart, and the final pass lays it out again
        FLEXED_HEIGHT.set(box, NaN);
        try {
          ctx.layoutSubtree(box, width);
        } finally {
          FLEXED_HEIGHT.delete(box);
        }
        content = contentBottom(box) + box.verticalExtra;
        laid.width = NaN;
      } else content = contentBottom(box) + box.verticalExtra;
      // and a ratio's content is at least its width through the ratio,
      // height of its own or not (CSS Sizing 4, 5.1)
      const aspect = style.aspectRatio;
      if (aspect && box.kind !== 'replaced') {
        content = Math.max(
          content,
          style.boxSizing === 'border-box'
            ? box.width / aspect.ratio
            : box.contentWidth / aspect.ratio + box.verticalExtra,
        );
      }
      // within what the ratio makes of its least and greatest widths
      if (box.kind !== 'replaced') {
        content = transferredHeight(box, content, containingWidth);
      }
      least = Math.min(laid.height, content);
      const extra = style.boxSizing === 'border-box' ? 0 : box.verticalExtra;
      if (style.maxHeight !== 'none') {
        const most = resolveOrNull(style.maxHeight, NaN);
        if (most !== null) least = Math.min(least, most + extra);
      }
      if (node.getComputedHeight() >= least - 0.01) continue;
      node.setMinHeight(least);
    }
    changed = true;
  }
  return changed;
}

/** An item's min-content width, its border box's, taken the once: its
 *  content's, whatever width it has of its own (`keywordWidth`'s too). */
function minContentOf(box: Box, ctx: LayoutContext, laid: Laid): number {
  if (box.intrinsicMinContent < 0) {
    const exact = ctx.fonts ? exactMinContent(box, ctx.fonts) : null;
    box.intrinsicMinContent =
      exact ?? measureIntrinsicWidth(box, ctx, MIN_CONTENT_PROBE, true);
    // a probe lays the box out where the kept layout was
    if (exact === null) laid.width = NaN;
  }
  return box.intrinsicMinContent;
}

/** How far down a laid-out box's content reaches inside its content box:
 *  its lines and its children, floats included, with their margins. */
function contentBottom(box: Box): number {
  const top = box.contentY;
  let bottom = 0;
  for (const line of box.lines ?? []) {
    bottom = Math.max(bottom, line.y + line.height - top);
  }
  for (const child of box.children) {
    if (child.outOfFlow || child.kind === 'text' || child.kind === 'break') {
      continue;
    }
    if (child.kind === 'inline') continue;
    bottom = Math.max(
      bottom,
      child.y + child.height + child.marginBottom - top,
    );
  }
  return bottom;
}

/**
 * A row's items aligned by their baselines (CSS Flexbox 8.3, 9.4 step 8),
 * which Yoga cannot see: an item is a leaf there, and a leaf's baseline is
 * its bottom edge, so it lined them up by their bottoms. With the items laid
 * out, each line's, and for each the top margin that sets it at the line's
 * start with its first baseline where the lowest-reaching one's is — or
 * null where no line has two to align.
 */
function baselineLines<T extends { box: Box }>(
  style: ComputedStyle,
  items: readonly T[],
): (T[] & { margins: number[] })[] | null {
  // a line that grows from its end is aligned from there, and left to Yoga
  if (style.flexWrap === 'wrap-reverse') return null;
  const wraps = style.flexWrap !== 'nowrap';
  // along a line the items go the way the main axis does, and the next
  // line starts where one does not
  const back =
    (style.flexDirection === 'row-reverse') !== (style.direction === 'rtl');
  const out: (T[] & { margins: number[] })[] = [];
  let line: T[] = [];
  let last = NaN;
  let several = false;
  const close = (): void => {
    if (!line.length) return;
    if (line.length > 1) several = true;
    let reach = -Infinity;
    const ascents = line.map(({ box }) => {
      const ascent = box.marginTop + itemBaseline(box);
      reach = Math.max(reach, ascent);
      return ascent;
    });
    const margins = line.map(
      ({ box }, i) => box.marginTop + reach - ascents[i],
    );
    out.push(Object.assign(line, { margins }));
  };
  for (const item of items) {
    const box = item.box;
    if (wraps && line.length && (back ? box.x >= last : box.x <= last)) {
      close();
      line = [];
    }
    last = box.x;
    const own = box.style;
    const aligned = own.alignSelf === AUTO ? style.alignItems : own.alignSelf;
    // an `auto` margin across the line takes it over alignment
    if (
      aligned === 'baseline' &&
      own.marginTop !== AUTO &&
      own.marginBottom !== AUTO
    ) {
      line.push(item);
    }
  }
  close();
  // one alone on its line is at its start already
  return several ? out : null;
}

/**
 * How far an item is from where it belongs across its line, where Yoga
 * (3.2.1) aligned the lines in the pass it takes for a box that wraps or
 * aligns by baselines: it sets an item aligned to its line's start there
 * as though it had no margin at that side, and one centred as though it had
 * none at either — `items-start` in a wrapping row put every card's top
 * margin under it. By the margin at the start of the line's cross axis, and
 * by half what it exceeds the one at the end by, as Yoga holds them: for an
 * item set at its line's start (`started`), its baseline's. A column's,
 * whose cross axis runs right to left, and a box that wraps in reverse are
 * left as Yoga has them.
 */
function lineMarginFix(
  container: ComputedStyle,
  item: Box,
  node: YogaNode,
  row: boolean,
  started = false,
): number {
  if (container.flexWrap === 'wrap-reverse') return 0;
  if (!row && container.direction === 'rtl') return 0;
  const style = item.style;
  // a margin that is `auto` takes the item over its alignment
  const lead = row ? style.marginTop : style.marginLeft;
  const trail = row ? style.marginBottom : style.marginRight;
  if (lead === AUTO || trail === AUTO) return 0;
  const align = started
    ? 'flex-start'
    : style.alignSelf === AUTO
      ? container.alignItems
      : style.alignSelf;
  if (align !== 'flex-start' && align !== 'center') return 0;
  const leading = node.getComputedMargin(row ? Y.EDGE_TOP : Y.EDGE_LEFT);
  if (align === 'flex-start') return leading;
  const trailing = node.getComputedMargin(row ? Y.EDGE_BOTTOM : Y.EDGE_RIGHT);
  return (leading - trailing) / 2;
}

/** An item's first baseline, down from its border edge: its content's
 *  first line's, or where it has none, or is replaced, one synthesized
 *  from its border box — its bottom edge. */
function itemBaseline(item: Box): number {
  if (item.kind !== 'replaced') {
    const found = firstBaselineIn(item);
    if (found !== null) return Math.min(found - item.y, item.height);
  }
  return item.height;
}

/** Whether an item is stretched across its line: `stretch`, its own or its
 *  container's, with no height of its own and no `auto` margin across. */
function stretches(
  box: Box,
  container: ComputedStyle,
  /** Whether the line is a row's, across which the item's height is
   *  stretched; a column's stretches its width. */
  row = true,
): boolean {
  const style = box.style;
  const align =
    style.alignSelf === AUTO ? container.alignItems : style.alignSelf;
  if (align !== 'stretch') return false;
  return row
    ? style.height === AUTO &&
        style.marginTop !== AUTO &&
        style.marginBottom !== AUTO
    : style.width === AUTO &&
        style.marginLeft !== AUTO &&
        style.marginRight !== AUTO;
}

/** How deep flex boxes are laid out by Yoga, one inside another's measure
 *  (`layoutFlex`). */
const FLEX_DEPTH = 64;

/** No Yoga assembly: stack the items instead of dropping them. */
function layoutAsBlockFallback(
  box: Box,
  ctx: LayoutContext,
  contentWidth: number,
): number {
  let y = box.contentY;
  for (const child of box.children) {
    if (child.kind === 'text' && isBlank(child.text)) continue;
    if (child.outOfFlow) {
      positionOutOfFlow(child, box, ctx, true);
      continue;
    }
    resolveEdges(child, contentWidth);
    ctx.layoutSubtree(child, contentWidth);
    moveTo(child, box.contentX + child.marginLeft, y + child.marginTop);
    y = child.y + child.height + child.marginBottom;
  }
  return y - box.contentY;
}

const FLEX_DIRECTION: Record<string, number> = {
  row: Y?.FLEX_DIRECTION_ROW,
  'row-reverse': Y?.FLEX_DIRECTION_ROW_REVERSE,
  column: Y?.FLEX_DIRECTION_COLUMN,
  'column-reverse': Y?.FLEX_DIRECTION_COLUMN_REVERSE,
};
const WRAP: Record<string, number> = {
  nowrap: Y?.WRAP_NO_WRAP,
  wrap: Y?.WRAP_WRAP,
  'wrap-reverse': Y?.WRAP_WRAP_REVERSE,
};
/**
 * A `justify-content` as the main axis takes it (CSS Box Alignment 3,
 * 6.1): `start` and `end` are the writing mode's, the main axis's own ends
 * turned round in a reversed direction; `left` and `right` are the page's
 * along a row, and `start` along a column, which has neither.
 */
function mainJustify(style: ComputedStyle): string {
  const justify = style.justifyContent;
  if (
    justify !== 'start' &&
    justify !== 'end' &&
    justify !== 'left' &&
    justify !== 'right'
  ) {
    return justify;
  }
  const reverse = style.flexDirection.endsWith('-reverse');
  const row = style.flexDirection.startsWith('row');
  let start: boolean;
  if (justify === 'start') start = true;
  else if (justify === 'end') start = false;
  else if (!row) start = true;
  else start = (justify === 'left') === (style.direction !== 'rtl');
  return start !== reverse ? 'flex-start' : 'flex-end';
}

const JUSTIFY: Record<string, number> = {
  'flex-start': Y?.JUSTIFY_FLEX_START,
  'flex-end': Y?.JUSTIFY_FLEX_END,
  center: Y?.JUSTIFY_CENTER,
  'space-between': Y?.JUSTIFY_SPACE_BETWEEN,
  'space-around': Y?.JUSTIFY_SPACE_AROUND,
  'space-evenly': Y?.JUSTIFY_SPACE_EVENLY,
};
const ALIGN: Record<string, number> = {
  auto: Y?.ALIGN_AUTO,
  'flex-start': Y?.ALIGN_FLEX_START,
  'flex-end': Y?.ALIGN_FLEX_END,
  center: Y?.ALIGN_CENTER,
  stretch: Y?.ALIGN_STRETCH,
  baseline: Y?.ALIGN_BASELINE,
  'space-between': Y?.ALIGN_SPACE_BETWEEN,
  'space-around': Y?.ALIGN_SPACE_AROUND,
};
