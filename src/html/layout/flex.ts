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
import { Box, isBlank } from './boxes.js';
import {
  FLEXED_HEIGHT,
  MIN_CONTENT_PROBE,
  clampHeight,
  contentSizedWidth,
  exactMinContent,
  intrinsicWidth,
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
  // Each flex box in a flex item runs its Yoga pass inside the measure of
  // the one around it, and Yoga's own stack runs out at about a hundred and
  // fifty of them — a `RuntimeError` out of the layout. Past this many, one
  // is laid out as blocks: the markup of a broken page, not of a design.
  const depth = ctx.flexDepth ?? 0;
  if (depth >= FLEX_DEPTH) return layoutAsBlockFallback(box, ctx, contentWidth);

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

  const items: { box: Box; node: YogaNode; laid: Laid }[] = [];
  for (const child of box.children) {
    if (child.kind === 'text' && isBlank(child.text)) continue;
    if (child.outOfFlow) {
      ctx.positioned.push({ box: child, containing: box });
      continue;
    }
    const node = Y.Node.create(flexConfig());
    resolveEdges(child, contentWidth);
    const laid: Laid = { width: NaN, height: NaN };
    applyItem(node, child, ctx, contentWidth, laid);
    root.insertChild(node, items.length);
    items.push({ box: child, node, laid });
  }

  const direction =
    box.style.direction === 'rtl' ? Y.DIRECTION_RTL : Y.DIRECTION_LTR;
  const row = box.style.flexDirection.startsWith('row');
  ctx.flexDepth = depth + 1;
  try {
    root.calculateLayout(
      bounded ? contentWidth : Number.NaN,
      height ?? Number.NaN,
      direction,
    );
    // an item Yoga shrank under what its content comes to is kept to it,
    // and the row is laid out again (`autoMinimums`) — which may shrink
    // another under its own, a few times over at most
    for (
      let pass = 0;
      pass < 4 && autoMinimums(items, row, ctx, contentWidth);
      pass += 1
    ) {
      root.calculateLayout(
        bounded ? contentWidth : Number.NaN,
        height ?? Number.NaN,
        direction,
      );
    }
  } finally {
    ctx.flexDepth = depth;
  }

  let bottom = 0;
  for (const { box: child, node, laid } of items) {
    const left = box.contentX + node.getComputedLeft();
    const top = box.contentY + node.getComputedTop();
    const width = node.getComputedWidth();
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
  laid: Laid,
  /** Its border box's height where the flex layout made it definite. */
  definite: number | null,
  /** Whether its height is the one the flex layout gave it, in a column,
   *  whatever its own says: flexed, it is shrunk as well as grown. */
  column = false,
): void {
  if (box.kind === 'text' || box.kind === 'break') {
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
  // or its background stops short of the row.
  if (height > box.height || column) box.height = height;
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
  laid: Laid,
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
  // Its max-content width is the same at every width Yoga asks at, and at
  // every layout the box has, so it is taken once in the box's life, as a
  // table cell's is: taken per layout of the container, a flex box in a
  // flex box in a flex box laid its innermost out three times a level,
  // and twelve levels took two seconds.
  const content = (): number => {
    let width = MAX_CONTENT.get(box);
    if (width === undefined) {
      width = measureIntrinsicWidth(box, ctx, Infinity) - box.horizontalExtra;
      MAX_CONTENT.set(box, width);
    }
    return width;
  };
  // and an answer Yoga asks for twice is the layout the item already has
  const answers = new Map<number, { width: number; height: number }>();
  node.setMeasureFunc((w, wm, h, hm) => {
    void h;
    void hm;
    const inner = innerWidth(w, wm, content);
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
  return mode === Y.MEASURE_MODE_AT_MOST && Number.isFinite(width)
    ? Math.min(content, Math.max(0, width))
    : content;
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
    if (
      !asked &&
      (style.overflowX !== 'visible' || style.overflowY !== 'visible')
    ) {
      continue;
    }
    const width = node.getComputedWidth();
    // An item its content sizes along a row: one with a width of its own
    // may shrink under it to what its content comes to, which that width
    // hides from a measure, and keeps Yoga's minimum of none
    if (
      row
        ? style.minWidth !== AUTO ||
          style.minWidthKeyword ||
          style.width !== AUTO ||
          style.widthKeyword
        : style.minHeight !== AUTO && !asked
    ) {
      continue;
    }
    // no narrower than its content at its widest, where Yoga measured that
    const widest = row ? MAX_CONTENT.get(box) : undefined;
    if (widest !== undefined && widest + box.horizontalExtra <= width + 0.5) {
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
      if (intrinsicWidth(box) + box.horizontalExtra <= width + 0.5) continue;
      if (box.intrinsicMinContent < 0) {
        const exact = ctx.fonts ? exactMinContent(box, ctx.fonts) : null;
        box.intrinsicMinContent =
          exact ?? measureIntrinsicWidth(box, ctx, MIN_CONTENT_PROBE);
        // a probe lays the box out where the kept layout was
        if (exact === null) laid.width = NaN;
      }
      least = box.intrinsicMinContent;
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

/** Whether an item is stretched across its line: `stretch`, its own or its
 *  container's, with no height of its own and no `auto` margin across. */
function stretches(box: Box, container: ComputedStyle): boolean {
  const style = box.style;
  const align =
    style.alignSelf === AUTO ? container.alignItems : style.alignSelf;
  return (
    align === 'stretch' &&
    style.height === AUTO &&
    style.marginTop !== AUTO &&
    style.marginBottom !== AUTO
  );
}

/** Whether anything in a box takes a percentage of a height: what a height
 *  the flex layout makes definite changes. Kept for the tree's life. */
function percentHeightsIn(box: Box): boolean {
  let found = PERCENT_HEIGHTS.get(box);
  if (found === undefined) {
    found = false;
    // a column's basis is a height too
    const column =
      box.kind === 'flex' &&
      !box.style.grid &&
      box.style.flexDirection.startsWith('column');
    for (const child of box.children) {
      const style = child.style;
      if (
        isPct(style.height) ||
        isPct(style.minHeight) ||
        (style.maxHeight !== 'none' && isPct(style.maxHeight)) ||
        (column && style.flexBasis !== 'content' && isPct(style.flexBasis)) ||
        percentHeightsIn(child)
      ) {
        found = true;
        break;
      }
    }
    PERCENT_HEIGHTS.set(box, found);
  }
  return found;
}

const PERCENT_HEIGHTS = new WeakMap<Box, boolean>();

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
