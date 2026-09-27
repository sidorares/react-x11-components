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

import { AUTO, isPct, resolve, resolveOrNull } from '../css/values.js';
import type { ComputedStyle, ContentSize } from '../css/style.js';
import { Box } from './boxes.js';
import {
  clampHeight,
  contentSizedWidth,
  measureIntrinsicWidth,
  moveTo,
  percentBaseInside,
  resolveEdges,
} from './block.js';
import { layoutGrid } from './css-grid.js';
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

  const root = Y.Node.create(flexConfig());
  applyContainer(root, box.style);
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

  const items: { box: Box; node: YogaNode }[] = [];
  for (const child of box.children) {
    if (child.kind === 'text' && !child.text.trim()) continue;
    if (child.outOfFlow) {
      ctx.positioned.push({ box: child, containing: box });
      continue;
    }
    const node = Y.Node.create(flexConfig());
    resolveEdges(child, contentWidth);
    applyItem(node, child, ctx, contentWidth);
    root.insertChild(node, items.length);
    items.push({ box: child, node });
  }

  root.calculateLayout(
    bounded ? contentWidth : Number.NaN,
    height ?? Number.NaN,
    box.style.direction === 'rtl' ? Y.DIRECTION_RTL : Y.DIRECTION_LTR,
  );

  let bottom = 0;
  for (const { box: child, node } of items) {
    const left = box.contentX + node.getComputedLeft();
    const top = box.contentY + node.getComputedTop();
    const width = node.getComputedWidth();
    const itemHeight = node.getComputedHeight();
    // The item is laid out again at the width the flex pass settled on: the
    // measure function answered a question, and the answer is not a layout —
    // its line breaks were computed against a width that may have changed
    // when a sibling grew.
    layoutItemAt(child, ctx, left, top, width, itemHeight);
    bottom = Math.max(bottom, top + child.height);
  }

  const contentHeight = root.getComputedHeight();
  root.freeRecursive();
  return Math.max(contentHeight, bottom - box.contentY);
}

function layoutItemAt(
  box: Box,
  ctx: LayoutContext,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (box.kind === 'text' || box.kind === 'break') {
    box.x = x;
    box.y = y;
    box.width = width;
    box.height = height;
    return;
  }
  // `measureBox` lays the box out at (0, 0); re-running it at the final width
  // and then moving it is one pass, not two, because the second call is the
  // one whose result is kept.
  ctx.layoutSubtree(box, width);
  // A stretched item is taller than its content, and the box has to say so
  // or its background stops short of the row.
  if (height > box.height) box.height = height;
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
  const justify = JUSTIFY[style.justifyContent] ?? Y.JUSTIFY_FLEX_START;
  if (justify !== Y.JUSTIFY_FLEX_START) node.setJustifyContent(justify);
  const items = ALIGN[style.alignItems] ?? Y.ALIGN_STRETCH;
  if (items !== Y.ALIGN_STRETCH) node.setAlignItems(items);
  const lines = ALIGN[style.alignContent] ?? Y.ALIGN_STRETCH;
  if (lines !== Y.ALIGN_FLEX_START) node.setAlignContent(lines);
  if (style.rowGap) node.setGap(Y.GUTTER_ROW, style.rowGap);
  if (style.columnGap) node.setGap(Y.GUTTER_COLUMN, style.columnGap);
}

function applyItem(
  node: YogaNode,
  box: Box,
  ctx: LayoutContext,
  containingWidth: number,
): void {
  const style = box.style;
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
    setLength(node, true, style.width, containingWidth, across);
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
    if (style.widthKeyword) node.setWidth(size(style.widthKeyword));
    if (style.minWidthKeyword) node.setMinWidth(size(style.minWidthKeyword));
    if (style.maxWidthKeyword) node.setMaxWidth(size(style.maxWidthKeyword));
  }
  const minHeight = resolveOrNull(style.minHeight, NaN);
  if (minHeight !== null) node.setMinHeight(minHeight + down);
  if (style.maxHeight !== 'none') {
    const maxHeight = resolveOrNull(style.maxHeight, NaN);
    if (maxHeight !== null) node.setMaxHeight(maxHeight + down);
  }

  if (style.flexBasis === 'content' || style.flexBasis === AUTO) {
    // Yoga's own
  } else if (isPct(style.flexBasis)) {
    // a percentage of the main size, which is known across a row
    const basis = style.flexBasis;
    const row = box.parent?.style.flexDirection.startsWith('row') ?? true;
    if (!basis.px && !basis.of) node.setFlexBasisPercent(basis.pct);
    else if (row && Number.isFinite(containingWidth)) {
      node.setFlexBasis(resolve(basis, containingWidth));
    } else if (basis.of) node.setFlexBasisAuto();
    else node.setFlexBasisPercent(basis.pct);
  } else node.setFlexBasis(style.flexBasis + across);

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
  // its max-content width is the same at every width Yoga asks at, and
  // taking it is a layout of the item at no width limit
  let maxContent = -1;
  const content = (): number =>
    maxContent < 0
      ? (maxContent =
          measureIntrinsicWidth(box, ctx, Infinity) - box.horizontalExtra)
      : maxContent;
  node.setMeasureFunc((w, wm, h, hm) => {
    void h;
    void hm;
    return measureBox(box, ctx, w, wm, content);
  });
}

function setLength(
  node: YogaNode,
  across: boolean,
  len: ComputedStyle['width'],
  base: number,
  /** Padding and border a `content-box` length goes without. */
  extra: number,
): void {
  const px = (v: number) => (across ? node.setWidth(v) : node.setHeight(v));
  const percent = (v: number) =>
    across ? node.setWidthPercent(v) : node.setHeightPercent(v);
  if (len === AUTO) return;
  if (isPct(len)) {
    // Yoga takes a percentage or points, not both: `calc(100% - 20px)`
    // resolves here where its base is known, and so does a percentage with
    // padding to add, and a percentage is kept alone where it is not
    if (!len.px && !len.of && !extra) percent(len.pct);
    else if (Number.isFinite(base)) px(resolve(len, base) + extra);
    else if (len.of) return;
    else percent(len.pct);
    return;
  }
  px(len + extra);
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
  width: number,
  mode: number,
  maxContent: () => number,
): { width: number; height: number } {
  const across = box.horizontalExtra;
  let inner: number;
  if (mode === Y.MEASURE_MODE_EXACTLY && Number.isFinite(width)) {
    inner = Math.max(0, width);
  } else {
    const content = maxContent();
    inner =
      mode === Y.MEASURE_MODE_AT_MOST && Number.isFinite(width)
        ? Math.min(content, Math.max(0, width))
        : content;
  }
  ctx.layoutSubtree(box, inner + across);
  return {
    width: inner,
    height: Math.max(0, box.height - box.verticalExtra),
  };
}

/** No Yoga assembly: stack the items instead of dropping them. */
function layoutAsBlockFallback(
  box: Box,
  ctx: LayoutContext,
  contentWidth: number,
): number {
  let y = box.contentY;
  for (const child of box.children) {
    if (child.kind === 'text' && !child.text.trim()) continue;
    if (child.outOfFlow) {
      ctx.positioned.push({ box: child, containing: box });
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
