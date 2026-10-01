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
// the leaf shape costs is a layout: an item the flex pass made taller or
// shorter than its content, which lays what is in it out by its height — a
// flex or grid container, or a box holding a percentage of a height — is
// laid out again at that height (`layoutItemAt`).
import { Yoga, layoutLoaded } from 'react-x11/yoga';
import type { Config as YogaConfig, Node as YogaNode } from 'react-x11/yoga';

import { AUTO, gapOf, isPct, resolve, resolveOrNull } from '../css/values.js';
import { scrolls } from '../css/style.js';
import type { ComputedStyle, ContentSize } from '../css/style.js';
import { Box, PAINT_ORDER, isBlank } from './boxes.js';
import {
  FLEXED_HEIGHT,
  MIN_CONTENT_PROBE,
  USED_HEIGHT,
  centreButton,
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
  // on it, so a column `min-h-screen` gives its `flex-1` the rest — or the
  // height the column it is an item of flexed it to (`USED_HEIGHT`), which
  // its items are laid out in and take no percentage of.
  const definite = percentBaseInside(box);
  const own = Number.isFinite(definite);
  const height = USED_HEIGHT.get(box) ?? (own ? definite : null);
  // whether its content may come to more than it is tall
  let capped = height !== null;
  if (height !== null) root.setHeight(height);
  else {
    root.setHeightAuto();
    const extra = box.verticalExtra;
    const min = clampHeight(box, extra) - extra;
    if (min > 0) root.setMinHeight(min);
    const max = clampHeight(box, Infinity) - extra;
    if (Number.isFinite(max)) {
      root.setMaxHeight(Math.max(0, max));
      capped = true;
    }
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
    const laid: Laid = {
      width: NaN,
      height: NaN,
      tall: NaN,
      set: NaN,
      stretch: NaN,
      main: NaN,
      least: NaN,
      most: NaN,
      narrowest: NaN,
      held: NaN,
      auto: false,
    };
    applyItem(node, child, ctx, contentWidth, laid, height !== null, own);
    root.insertChild(node, items.length);
    items.push({ box: child, node, laid });
  }

  const direction =
    box.style.direction === 'rtl' ? Y.DIRECTION_RTL : Y.DIRECTION_LTR;
  const row = box.style.flexDirection.startsWith('row');
  // frozen at its least size on the one line of a box that does not
  // wrap, by a basis where Yoga takes one along the main axis
  // (`applyItem`'s `setBasis`)
  const hold: Hold = {
    frozen: box.style.flexWrap === 'nowrap',
    basis: row ? bounded : height !== null,
  };
  const ask = (): void =>
    root.calculateLayout(
      bounded ? contentWidth : Number.NaN,
      height ?? Number.NaN,
      direction,
    );
  // the one line of a box that does not wrap may be short of room, where
  // the box has a size along it that its items do not make: and Yoga's
  // answer for a line every item of which its minimum stops is put right
  // (`stoppedLine`)
  const short = hold.frozen && (row ? bounded : capped);
  // and any line may have room left over, where a row has a width to have
  // it in: Yoga's answer for one every item of which that may grow its
  // maximum stops is put right too (`cappedLines`) — broken into lines as
  // Yoga breaks them, at the box's size along them where a box that wraps
  // has one, and in one line where it does not
  const roomy = row ? bounded : true;
  const breaks = hold.frozen
    ? Infinity
    : row
      ? contentWidth
      : (height ?? Infinity);
  // each item's size along the main axis, read the once a layout (`Laid`)
  const read = (): void => {
    for (const { node, laid } of items) {
      laid.main = row ? node.getComputedWidth() : node.getComputedHeight();
    }
  };
  const calculate = (): void => {
    ask();
    read();
    if (!short && !roomy) return;
    const room = row ? contentWidth : (height ?? root.getComputedHeight());
    const gap = row ? columnGap : rowGap;
    if (short && stoppedLine(items, row, room, gap, hold, ask)) read();
    if (roomy && cappedLines(items, row, room, breaks, gap, hold, ask)) {
      read();
    }
  };
  ctx.flexDepth = depth + 1;
  try {
    calculate();
    // an item Yoga shrank under what its content comes to is kept to it,
    // and the row is laid out again (`autoMinimums`) — which may shrink
    // another under its own, a few times over at most
    for (
      let pass = 0;
      pass < 4 && autoMinimums(items, row, ctx, contentWidth, hold);
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
    own,
    box.style.flexWrap === 'wrap' || baselines,
    contentWidth,
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
      own,
      box.style.flexWrap === 'wrap',
      contentWidth,
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
      own,
      box.style.flexWrap === 'wrap' || baselines,
      contentWidth,
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
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
  row: boolean,
): boolean {
  let changed = false;
  for (const { box, node, laid } of items) {
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
    if (Math.abs(basis - laid.main) < 0.5) continue;
    node.setFlexBasis(basis);
    // one held at its least size (`holdAt`) flexes from the new basis, no
    // further down than that
    if (!Number.isNaN(laid.held)) {
      laid.held = NaN;
      laid.auto = false;
      node.setFlexGrow(style.flexGrow);
      node.setFlexShrink(style.flexShrink);
    }
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
  /** Whether the flex box has a definite height. */
  own: boolean,
  /** Whether Yoga aligned the lines in its pass that drops a margin. */
  lined: boolean,
  /** The flex box's content width: its items' containing block's. */
  contentWidth: number,
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
      row ? laid.main : node.getComputedWidth(),
      laid.set,
      laid.stretch,
      laid.width,
      row ? laid.held : NaN,
    );
    const itemHeight = row ? node.getComputedHeight() : laid.main;
    // The item is laid out again at the width the flex pass settled on: the
    // measure function answered a question, and the answer is not a layout —
    // its line breaks were computed against a width that may have changed
    // when a sibling grew. Unless the last answer was at that width, which
    // is a layout the item still has (Yoga's widths are float32s).
    // Its height is definite where the flex layout made it so (CSS Flexbox
    // 9.8): stretched across a row's line, or flexed in a column of a
    // height of its own. What is in it takes its percentages of that —
    // the `h-full` in a stretched sidebar — where they had nothing to be
    // of, and the item is laid out again for them; and so is one that is a
    // flex or grid container itself, whose own items are laid out in that
    // height (9.4, step 11: "redo layout for its contents, treating this
    // used size as its definite cross size").
    const definite = row
      ? stretches(child, box.style)
        ? itemHeight
        : null
      : own
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
      contentWidth,
      !row,
    );
    // to the end of its margin box, as Yoga measured the box: a negative
    // margin takes the item's end back in, which Codex's search field
    // hangs a pixel over its form's border with, top and bottom
    bottom = Math.max(bottom, top + child.height + child.marginBottom);
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
  /** The flex box's content width, the item's containing block's. */
  containing: number,
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
  const sameWidth = Math.abs(laid.width - width) <= 0.01;
  // The content height the item is laid out at, where the flex layout gave
  // it one that is not its own already: NaN where its content says how
  // tall it is.
  let tall = NaN;
  // A flex or grid container shares its height out among its items: an
  // `auto` margin takes what is free of it (8.1), a `flex: 1` grows into it
  // (9.7), its lines are as tall as it (9.4), its `fr` rows fill it. So it
  // is laid out in the height the flex layout gave it, definite or not —
  // the one a column with no height of its own flexed it to is its used
  // size all the same (9.7), and `min-h-screen flex flex-col` around a
  // `flex-1 flex items-center` centres what is in that. At its content's
  // own height there is nothing to share, and the layout it has is that
  // one: the tallest card of a row is laid out the once. A table shares
  // what it is given past its rows among them (`layoutTable`), and a
  // height short of them is none it can have: it is laid out again where
  // it was given more.
  const given = definite ?? (column ? height : null);
  let shares = false;
  if (given !== null && (box.kind === 'flex' || box.kind === 'table')) {
    const natural = naturalHeight(box, ctx, width, containing, laid);
    shares =
      box.kind === 'flex'
        ? !(Math.abs(natural - given) <= 0.01)
        : !(natural >= given - 0.01);
  }
  if (given !== null) {
    const inner = Math.max(0, given - box.verticalExtra);
    if (Object.is(inner, percentBaseInside(box))) {
      // the height it has of its own
    } else if (shares || (definite !== null && percentHeightsIn(box))) {
      tall = inner;
    }
  }
  // `measureBox` lays the box out at (0, 0); re-running it at the final width
  // and then moving it is one pass, not two, because the second call is the
  // one whose result is kept — or no pass, where the last layout was at
  // this width and this height. An item Yoga never measured has none, NaN,
  // and is laid out.
  if (sameWidth && Object.is(laid.tall, tall)) box.height = laid.height;
  else if (Number.isNaN(tall)) {
    layoutNaturally(box, ctx, width, containing, laid);
  } else {
    // what is in it takes its percentages of a definite height alone (9.8)
    const heights = definite !== null ? FLEXED_HEIGHT : USED_HEIGHT;
    heights.set(box, tall);
    try {
      ctx.layoutSubtree(box, width, containing);
    } finally {
      heights.delete(box);
    }
    laid.width = box.width;
    laid.height = box.height;
    laid.tall = tall;
  }
  // A stretched item is taller than its content, and the box has to say so
  // or its background stops short of the row — and it is no taller than its
  // line where its content is, or than what its ratio makes of its width:
  // its height is the line's (CSS Flexbox 9.4, step 11). But for a table,
  // whose rows are the least it can be, however short its line (CSS 2.1
  // 17.5.3, as a height of its own is; Blink: "Tables can't shrink below
  // their min-intrinsic size").
  if (
    height > box.height ||
    ((column || definite !== null) && box.kind !== 'table')
  ) {
    box.height = height;
  }
  // and a button's content is centred in the height it came to
  centreButton(box);
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
  /** Whether the flex box has a height its items are laid out in. */
  tall: boolean,
  /** Whether that height is definite, and a percentage may be of it: one a
   *  column flexed the box to is not (`USED_HEIGHT`). */
  own: boolean,
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
  // a percentage of a height that is not definite is `auto` (CSS 2.1 10.5),
  // which Yoga makes of one where the flex box has no height at all
  if (style.height !== AUTO && (own || !tall || !isPct(style.height))) {
    setLength(node, false, style.height, NaN, down);
  }
  // the least it may be along each axis, its border box's, as Yoga is
  // told it
  let leastWidth = NaN;
  let leastHeight = NaN;
  // and the most, as Yoga is told it
  let mostWidth = NaN;
  let mostHeight = NaN;
  const minWidth = resolveOrNull(style.minWidth, containingWidth);
  if (minWidth !== null) {
    leastWidth = minWidth + across;
    node.setMinWidth(leastWidth);
  }
  if (style.maxWidth !== 'none') {
    const maxWidth = resolveOrNull(style.maxWidth, containingWidth);
    if (maxWidth !== null) {
      mostWidth = maxWidth + across;
      node.setMaxWidth(mostWidth);
    }
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
    if (style.minWidthKeyword) {
      leastWidth = size(style.minWidthKeyword);
      node.setMinWidth(leastWidth);
    }
    if (style.maxWidthKeyword) {
      mostWidth = size(style.maxWidthKeyword);
      node.setMaxWidth(mostWidth);
    }
  }
  const minHeight = resolveOrNull(style.minHeight, NaN);
  if (minHeight !== null) {
    leastHeight = minHeight + down;
    node.setMinHeight(leastHeight);
  }
  if (style.maxHeight !== 'none') {
    const maxHeight = resolveOrNull(style.maxHeight, NaN);
    if (maxHeight !== null) {
      mostHeight = maxHeight + down;
      node.setMaxHeight(mostHeight);
    }
  }

  const row = box.parent?.style.flexDirection.startsWith('row') ?? true;
  laid.least = row ? leastWidth : leastHeight;
  laid.most = row ? mostWidth : mostHeight;
  laid.narrowest = leastWidth;
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
  } else if (isPct(style.flexBasis) && !row && tall && !own) {
    // a percentage of a main size that is not definite is `content` (CSS
    // Flexbox 7.2.3): Yoga's own, down a column
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
    // the height it was flexed to, that is: one its automatic minimum
    // holds it at (`holdAt`) is its content's, which a replaced element's
    // width follows through its ratio and no other's does (CSS Sizing 4,
    // 5.1)
    const flexed = box.kind === 'replaced' || !laid.auto;
    const through =
      widthThrough && given && !exact && flexed ? widthThrough(h) : null;
    // Along a row, an item's flex base size is its content at its widest,
    // whatever the room (CSS Flexbox 9.2.3 E, `content` as `max-content`),
    // which Yoga asks for as at most the row's width: a replaced element's,
    // and that of one that may not shrink, which is as wide as that (9.7).
    // Fitted to the room, a `shrink-0` item of words was held to its
    // content at its narrowest, and wrapped where it overflows the row.
    // One that may shrink is fitted, as any item is across a column — and
    // so is every item of a row laid out in no room, which is the flex box
    // measured for its content at its narrowest (`MIN_CONTENT_PROBE`): that
    // is the sum of its items' content at their narrowest, whatever they
    // may shrink by, as Chrome and the css-flexbox suite have it
    // (`intrinsic-size/row-001`, `gap-015`), and not their bases.
    const widest = alongRow && !exact;
    const fitted =
      through !== null
        ? through
        : widest &&
            (box.kind === 'replaced' ||
              (style.flexShrink === 0 && containingWidth !== MIN_CONTENT_PROBE))
          ? content()
          : innerWidth(width, wm, content);
    // And no narrower than its minimum: Yoga holds the item to that only
    // after it has the answer, which it keeps for the width that makes of
    // it, so an item measured at the room and held to a wider minimum was
    // as tall as its content wrapped at the room — `min-w-max` in a narrow
    // row, or down a column narrower than it, one line of words two lines
    // tall, and an item held to its longest word in a row that wraps
    // (`holdAt`) a line taller than that makes it. Stretched across a
    // column, it is asked at the column's width.
    const inner = Number.isNaN(laid.narrowest)
      ? fitted
      : Math.max(fitted, laid.narrowest - extra);
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
      answer = measureBox(box, ctx, inner, containingWidth, laid);
      answers.set(inner, answer);
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
  /** The content height that layout was made at, where the flex layout gave
   *  the item one (`FLEXED_HEIGHT`, `USED_HEIGHT`), and NaN where its
   *  content's own. */
  tall: number;
  /** The border-box width this engine set on the item's node — a length,
   *  or the content's for `fit-content` and its kin — or NaN. */
  set: number;
  /** Its border-box width stretched across its container: the container's
   *  content width, less its margins. */
  stretch: number;
  /** Its border box's size along the main axis in the layout Yoga last
   *  made of the flex box, as Yoga has it. */
  main: number;
  /** The least it may be along the main axis, where its own style says:
   *  the minimum this engine set on its node, or NaN. */
  least: number;
  /** The most it may be along the main axis, where its own style says: the
   *  maximum this engine set on its node, or NaN. */
  most: number;
  /** The least border-box width its node was given, along a row or across
   *  a column: its own minimum, or along a row the automatic one it is
   *  held to (`holdAt`), or NaN. It is measured at no narrower. */
  narrowest: number;
  /** The size along the main axis it is frozen at, inflexible (`freezeAt`),
   *  or NaN. */
  held: number;
  /** Whether that is its automatic minimum (`holdAt`), its content's size,
   *  and not a minimum the line stopped at (`stoppedLine`). */
  auto: boolean;
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
  /** The flex box's content width, the item's containing block's. */
  containing: number,
  laid: Laid,
): { width: number; height: number } {
  // its padding as Yoga has it, a percentage of the flex box's width: a
  // probe of its content's width leaves a percentage at none
  resolveEdges(box, containing);
  const width = inner + box.horizontalExtra;
  // its height at this width is known, where a layout since has left it
  // another: the answer is the height, and the layout `layoutItemAt`'s
  const kept = keptNatural(box, ctx, width, containing);
  if (kept !== null && kept.serial !== box.layoutSerial) {
    return {
      width: inner,
      height: Math.max(0, kept.height - box.verticalExtra),
    };
  }
  layoutNaturally(box, ctx, width, containing, laid);
  return {
    width: inner,
    height: Math.max(0, box.height - box.verticalExtra),
  };
}

/** An item's height as its content's own makes it at a border-box width,
 *  where this pass has laid it out so (`layoutNaturally`), and else NaN. */
function naturalHeight(
  box: Box,
  ctx: LayoutContext,
  width: number,
  containing: number,
  laid: Laid,
): number {
  if (Math.abs(laid.width - width) <= 0.01 && Number.isNaN(laid.tall)) {
    return laid.height;
  }
  return keptNatural(box, ctx, width, containing)?.height ?? NaN;
}

/**
 * Give an item the layout its content's own height makes of it at a
 * border-box width, and note it (`Laid`): the one this pass has made of it
 * there already, where it still has it.
 *
 * A flex box laid out a second time — at the height a stretch gave it, its
 * own flex layout made anew (`layoutItemAt`) — asks of each item what it
 * asked the first time, and the item's layout at a width is what it was.
 * Kept for the pass, a card laid out again for its height lays nothing in
 * it out that is where it was; made again at every layout of the box
 * around it, a card in a card in a card laid its innermost out twice a
 * level.
 */
function layoutNaturally(
  box: Box,
  ctx: LayoutContext,
  width: number,
  /** The flex box's content width, the item's containing block's. */
  containing: number,
  laid: Laid,
): void {
  const kept = keptNatural(box, ctx, width, containing);
  if (kept !== null && kept.serial === box.layoutSerial) {
    // put back, where the flex layout stretched it
    box.height = kept.height;
  } else {
    const at = ctx.positioned.length;
    ctx.layoutSubtree(box, width, containing);
    // a replaced box is sized, not laid out, and has no layout to count
    if (box.kind !== 'replaced') {
      NATURAL.set(box, {
        ctx,
        serial: box.layoutSerial,
        width,
        containing: readsContaining(box) ? containing : NaN,
        base: box.percentHeightBase,
        edges: edgesOf(box),
        height: box.height,
        queued:
          ctx.positioned.length > at ? { at, first: ctx.positioned[at] } : null,
        drawn: NaN,
        content: NaN,
      });
    }
  }
  laid.width = box.width;
  laid.height = box.height;
  laid.tall = NaN;
}

/**
 * The layout this pass made of an item at its content's own height
 * (`layoutNaturally`), where one at `width` now would be the same: the same
 * width, the same edges — a percentage among them resolved, as the layout
 * leaves them — the same containing block's width where a limit on its own
 * is a percentage of it, and the same height for its percentages, where its
 * own style reads that at all, which the flex box around it coming to a
 * definite height changes for every item in it. Its `height` is the item's
 * there whatever has laid it out since, and the layout is the one the box
 * has where nothing has (`Box.layoutSerial`).
 */
function keptNatural(
  box: Box,
  ctx: LayoutContext,
  width: number,
  containing: number,
): Natural | null {
  const kept = NATURAL.get(box);
  if (kept === undefined || kept.ctx !== ctx || kept.width !== width) {
    return null;
  }
  if (!Number.isNaN(kept.containing) && kept.containing !== containing) {
    return null;
  }
  if (!Object.is(kept.base, box.percentHeightBase) && readsPercentBase(box)) {
    return null;
  }
  // the boxes in it that are positioned last are still waiting to be: a
  // `line-clamp: auto` box laid out a second time forgets the ones its
  // first layout found
  if (kept.queued && ctx.positioned[kept.queued.at] !== kept.queued.first) {
    return null;
  }
  const edges = kept.edges;
  return edges[0] === box.marginTop &&
    edges[1] === box.marginRight &&
    edges[2] === box.marginBottom &&
    edges[3] === box.marginLeft &&
    edges[4] === box.borderTop &&
    edges[5] === box.borderRight &&
    edges[6] === box.borderBottom &&
    edges[7] === box.borderLeft &&
    edges[8] === box.padTop &&
    edges[9] === box.padRight &&
    edges[10] === box.padBottom &&
    edges[11] === box.padLeft
    ? kept
    : null;
}

/** A layout of an item at its content's own height (`layoutNaturally`): in
 *  which pass, which of the box's layouts it was, and what it was made
 *  from. */
interface Natural {
  ctx: LayoutContext;
  serial: number;
  /** The border-box width it was asked for at. */
  width: number;
  /** Its containing block's width, where a limit on its own width is a
   *  percentage of that (`readsContaining`), and else NaN: a nest of flex
   *  boxes is laid out in rooms of many widths, and an item with no such
   *  limit is laid out the same in each. */
  containing: number;
  /** The height its percentages were of. */
  base: number;
  /** Its margins, borders and padding once laid out (`edgesOf`). */
  edges: number[];
  height: number;
  /** The first of the out-of-flow boxes that layout queued to be
   *  positioned (`LayoutContext.positioned`) and where; null for none. */
  queued: { at: number; first: LayoutContext['positioned'][number] } | null;
  /** What `autoMinimums` read from that layout, NaN until it has: how wide
   *  it drew, and how far down its content came, each its border box's. */
  drawn: number;
  content: number;
}

const NATURAL = new WeakMap<Box, Natural>();

/** Note what was read from the layout an item has, where that is the one
 *  its content's own height makes of it at `width`. */
function remember(
  box: Box,
  ctx: LayoutContext,
  width: number,
  containing: number,
  field: 'drawn' | 'content',
  value: number,
): void {
  const made = keptNatural(box, ctx, width, containing);
  if (made !== null && made.serial === box.layoutSerial) made[field] = value;
}

/** A box's edges, which a layout resolves again against the width it is
 *  given: margins, borders, padding, each from the top round. */
function edgesOf(box: Box): number[] {
  return [
    box.marginTop,
    box.marginRight,
    box.marginBottom,
    box.marginLeft,
    box.borderTop,
    box.borderRight,
    box.borderBottom,
    box.borderLeft,
    box.padTop,
    box.padRight,
    box.padBottom,
    box.padLeft,
  ];
}

/** Whether the width a box is laid out at is held to a percentage of its
 *  containing block's: a least or greatest width that is one. */
function readsContaining(box: Box): boolean {
  const style = box.style;
  return (
    isPct(style.minWidth) ||
    (style.maxWidth !== 'none' && isPct(style.maxWidth))
  );
}

/** Whether a box's own layout reads the height its percentages are of: a
 *  height, a least or greatest one, or an offset that is a percentage, a
 *  height that is a keyword — `stretch` fills it — or an anonymous box,
 *  which hands it on to what is in it (`percentBaseInside`). */
function readsPercentBase(box: Box): boolean {
  if (!box.el && !box.pseudo) return true;
  const style = box.style;
  return (
    isPct(style.height) ||
    isPct(style.minHeight) ||
    (style.maxHeight !== 'none' && isPct(style.maxHeight)) ||
    isPct(style.top) ||
    isPct(style.bottom) ||
    style.heightKeyword !== null ||
    style.minHeightKeyword !== null ||
    style.maxHeightKeyword !== null
  );
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
  hold: Hold,
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
      row ? laid.main : node.getComputedWidth(),
      laid.set,
      laid.stretch,
      laid.width,
      row ? laid.held : NaN,
    );
    // a replaced item's content along a row is its natural width
    if (row && box.kind === 'replaced') {
      if (style.minWidth !== AUTO || style.minWidthKeyword) continue;
      const least = replacedMinimum(box, containingWidth);
      if (least === null || width >= least - 0.01) continue;
      holdAt(node, laid, row, least, hold);
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
        holdAt(node, laid, row, least, hold);
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
      if (laid.main >= least - 0.01) continue;
      holdAt(node, laid, row, least, hold);
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
    // What its content's own height makes of it at this width — how wide
    // that drew, along a row, and how far down, along a column — is read
    // from that layout, which the item is given where it has another: or
    // is what this pass read from it before, where the flex box is laid
    // out a second time (`layoutNaturally`)
    const kept = keptNatural(box, ctx, width, containingWidth);
    const read = kept === null ? NaN : row ? kept.drawn : kept.content;
    if (Number.isNaN(read) && !(Math.abs(laid.width - width) <= 0.01)) {
      layoutNaturally(box, ctx, width, containingWidth, laid);
    }
    const height = Number.isNaN(read) ? laid.height : kept!.height;
    let least: number;
    if (row) {
      // or than what it drew at the width it has: nothing overflows it —
      // unless a line in it fits for being cut short by `text-overflow`,
      // which is how the line is drawn and no part of how wide it is: a
      // button whose label is a `truncate` span is no narrower than the
      // label, where it was shrunk and the label cut. No width, then, that
      // it drew at, which is what is kept of it
      let drawn = read;
      if (Number.isNaN(drawn)) {
        const seen = { cut: false };
        drawn = intrinsicWidth(box, seen) + box.horizontalExtra;
        if (seen.cut) drawn = Infinity;
        remember(box, ctx, width, containingWidth, 'drawn', drawn);
      }
      if (
        Number.isFinite(drawn) &&
        transferredWidth(box, drawn) <= width + 0.5
      ) {
        continue;
      }
      // within what a ratio makes of its least and greatest heights (4.5's
      // content size suggestion)
      least = transferredWidth(box, minContentOf(box, ctx, laid));
      const extra = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
      if (style.maxWidth !== 'none') {
        const most = resolveOrNull(style.maxWidth, containingWidth);
        if (most !== null) least = Math.min(least, most + extra);
      }
      if (laid.main >= least - 0.01) continue;
      holdAt(node, laid, row, least, hold);
    } else {
      // its height, or where it has one of its own and its content comes to
      // less, its content's: the lesser of the two (4.5)
      let content = read;
      if (!Number.isNaN(content)) {
        // read before
      } else if (box.kind === 'replaced') content = laid.height;
      else if (style.height !== AUTO && percentHeightsIn(box)) {
        // what its content comes to where it has no height to take
        // percentages of, as an intrinsic size is measured: laid out so
        // apart, and the final pass lays it out again
        FLEXED_HEIGHT.set(box, NaN);
        try {
          ctx.layoutSubtree(box, width, containingWidth);
        } finally {
          FLEXED_HEIGHT.delete(box);
        }
        content = ratioContent(box, contentBottom(box) + box.verticalExtra);
        laid.width = NaN;
      } else {
        content = ratioContent(box, contentBottom(box) + box.verticalExtra);
        remember(box, ctx, width, containingWidth, 'content', content);
      }
      // within what the ratio makes of its least and greatest widths
      if (box.kind !== 'replaced') {
        content = transferredHeight(box, content, containingWidth);
      }
      least = Math.min(height, content);
      const extra = style.boxSizing === 'border-box' ? 0 : box.verticalExtra;
      if (style.maxHeight !== 'none') {
        const most = resolveOrNull(style.maxHeight, NaN);
        if (most !== null) least = Math.min(least, most + extra);
      }
      if (laid.main >= least - 0.01) continue;
      holdAt(node, laid, row, least, hold);
    }
    changed = true;
  }
  return changed;
}

/** A laid-out item's content height, its border box's: no less than its
 *  width through its ratio, height of its own or not (CSS Sizing 4, 5.1). */
function ratioContent(box: Box, content: number): number {
  const aspect = box.style.aspectRatio;
  if (!aspect || box.kind === 'replaced') return content;
  return Math.max(
    content,
    box.style.boxSizing === 'border-box'
      ? box.width / aspect.ratio
      : box.contentWidth / aspect.ratio + box.verticalExtra,
  );
}

/** How a flex box holds its items to their least sizes (`holdAt`). */
interface Hold {
  /** Whether an item is frozen at its least size: on the one line of a
   *  box that does not wrap. */
  frozen: boolean;
  /** Whether Yoga takes a length for a basis along the main axis
   *  (`applyItem`'s `setBasis`), and else the item's own size. */
  basis: boolean;
}

/**
 * Hold an item to its least size along the main axis, the size Yoga gave
 * it being under that. It is frozen there, as CSS Flexbox freezes an item
 * its minimum stops (9.7, step 4): inflexible, at that size, the rest of
 * the line sharing what is left. Handed the minimum as a `min-width`
 * alone, Yoga makes it the item's flex base size, which is two things the
 * specification does not do:
 *
 * - where the line has room to share out, the item takes its share on top
 *   of the minimum: of three `flex: 1` items in 300 pixels, the one with a
 *   word 200 wide was 233, where it is 200 and the others 50 each;
 * - where every item of a line is held, Yoga divides what the line is
 *   short of by what is left of the shrink factors once it has taken each
 *   item's away — nothing, or a float's rounding of it. Two items 110.992
 *   and 62.706 pixels wide in a row too narrow for them came out billions
 *   of pixels wide, and 31.3 and 17.7 came out as they are: by the digits
 *   of their sizes, which are a text's widths in whatever font it is set.
 *
 * On the one line of a box that does not wrap, an item Yoga had under its
 * minimum has no more room when another is held too, so frozen is where it
 * ends. In a box that wraps it may have: the minimums move the line breaks
 * (9.3), and an item held on a crowded line may be on one with room to
 * grow in once they have. There the minimum is left to Yoga, as a minimum;
 * only a line of one item is short of room there, and what Yoga takes away
 * from its shrink factors is exactly what it added.
 */
function holdAt(
  node: YogaNode,
  laid: Laid,
  row: boolean,
  least: number,
  hold: Hold,
): void {
  if (row) {
    node.setMinWidth(least);
    laid.narrowest = least;
  } else node.setMinHeight(least);
  if (!hold.frozen) return;
  laid.auto = true;
  freezeAt(node, laid, row, least, hold);
}

/** Freeze an item at a size along the main axis: inflexible, and that size
 *  its flex base size. */
function freezeAt(
  node: YogaNode,
  laid: Laid,
  row: boolean,
  size: number,
  hold: Hold,
): void {
  laid.held = size;
  node.setFlexGrow(0);
  node.setFlexShrink(0);
  if (hold.basis) node.setFlexBasis(size);
  else if (row) node.setWidth(size);
  else node.setHeight(size);
}

/**
 * Put right the one line of a box that does not wrap, where every item of
 * it that may shrink is stopped by its minimum and Yoga made them wider for
 * it; whether Yoga was asked again. The line is laid out with each of them
 * frozen at its minimum, which is where CSS Flexbox leaves them (9.7, step
 * 4): the line is short of room with every one of them as small as it
 * goes.
 *
 * Yoga shares what a line is short of in two passes. The first takes each
 * item a minimum stops out of the sum of the scaled shrink factors, one
 * subtraction an item, and the second divides what the line is still short
 * of by what is left of the sum. With every item stopped that is nothing:
 * `(a + b) - a - b`, in float32s, which is 0 for some sizes and a rounding
 * either side of it for others, 2^-18 for sizes about a hundred. Yoga
 * 3.2.1 tests for 0, and the guard it has had since, a sum under 1e-6, is
 * under that rounding (react/yoga#1665, #1974). A negative rounding sends
 * every item under its minimum, which stops it, and a positive one makes
 * each of them wider by billions of pixels: `width: 110.992px; min-width:
 * 110.992px` beside `62.705625px` of the same, in a row 50 wide, were
 * 3599091712 and 2033329408 wide, where 100 and 60 were as they are. So
 * were two items with no minimum but their padding, and two with
 * `min-width: 0` beside one that does not shrink and is wider than the row
 * alone.
 *
 * A minimum of the item's own is Yoga's to hold it to, so this looks at
 * its answer, for a line that is two things at once. It is short of room
 * with every item that may shrink at its minimum — where 9.7 leaves each
 * of them at that, whatever their sizes. And one of them is wider than its
 * hypothetical size (9.7, step 2), which no sharing out of what a line is
 * short of makes an item: Yoga is asked for the line with nothing
 * shrinking, where each item is that size. Any other line is put back as
 * it was, the two layouts that took being the cost of one that is short of
 * room at its minimums and was not shared out to them; a line with room
 * for its minimums, or one whose every item sits at its own, has cost the
 * sum of its sizes.
 *
 * An automatic minimum is no part of it: an item held at one is frozen
 * already (`holdAt`), and one not yet held has no minimum to Yoga but its
 * padding and border, where this leaves it for `autoMinimums` to find
 * short of its content.
 */
function stoppedLine(
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
  row: boolean,
  /** The flex box's size along the main axis. */
  room: number,
  /** The gap between two items. */
  gap: number,
  hold: Hold,
  /** Lay the flex box out, as its nodes now are. */
  ask: () => void,
): boolean {
  // what is between the items' border boxes: the gaps, and their margins
  let between = gap * (items.length - 1);
  // the line's size with each item that may shrink at its minimum
  let least = 0;
  let shrinking = 0;
  let over = false;
  for (const { box, laid } of items) {
    const style = box.style;
    // an `auto` margin is none on a line with no room (8.1)
    if (row) {
      if (style.marginLeft !== AUTO) between += box.marginLeft;
      if (style.marginRight !== AUTO) between += box.marginRight;
    } else {
      if (style.marginTop !== AUTO) between += box.marginTop;
      if (style.marginBottom !== AUTO) between += box.marginBottom;
    }
    if (!shrinks(box, laid)) least += laid.main;
    else {
      const min = leastOf(box, laid, row);
      shrinking += 1;
      least += min;
      if (laid.main > min + 0.01) over = true;
    }
  }
  // two at the least: what is left of a sum of one, less it, is 0 exactly.
  // A line within a thousandth of a pixel of room is short of it: what
  // Yoga makes of that is as far out, and the minimums are that near
  if (shrinking < 2 || !over || !(between + least > room - SHORT)) {
    return false;
  }

  const stopped = items.filter(({ box, laid }) => shrinks(box, laid));
  for (const { node } of stopped) node.setFlexShrink(0);
  ask();
  // each item its hypothetical size, which one that does not shrink is on
  // a line short of room — where Yoga may have grown it, on a line it took
  // for having some
  let wider = false;
  least = 0;
  for (const { box, node, laid } of items) {
    const hypothetical = row
      ? node.getComputedWidth()
      : node.getComputedHeight();
    if (!shrinks(box, laid)) least += hypothetical;
    else {
      least += leastOf(box, laid, row);
      if (laid.main > hypothetical && !nearly(laid.main, hypothetical)) {
        wider = true;
      }
    }
  }
  const freeze = wider && between + least > room - SHORT;
  for (const { box, node, laid } of stopped) {
    if (freeze) freezeAt(node, laid, row, leastOf(box, laid, row), hold);
    else node.setFlexShrink(box.style.flexShrink);
  }
  ask();
  return true;
}

/** Whether Yoga may shrink an item: it has a shrink factor, and is not
 *  frozen (`freezeAt`). */
function shrinks(box: Box, laid: Laid): boolean {
  return box.style.flexShrink > 0 && Number.isNaN(laid.held);
}

/** How near to its room a line may be and be short of it (`stoppedLine`),
 *  or have room to spare (`cappedLines`). */
const SHORT = 0.001;

/** The least an item may be along the main axis, its border box: the
 *  minimum of its own, and no less than its padding and borders. */
function leastOf(box: Box, laid: Laid, row: boolean): number {
  const extra = row ? box.horizontalExtra : box.verticalExtra;
  return Number.isNaN(laid.least) ? extra : Math.max(laid.least, extra);
}

/**
 * Put right the lines of a flex box on which every item that may grow is
 * stopped by its maximum and Yoga made them smaller for it; whether Yoga
 * was asked again. Each such line is laid out with every item of it that
 * may grow frozen at its maximum, which is where CSS Flexbox leaves them
 * (9.7, step 4): the line has room left over with every one of them as
 * large as it goes. It is also where Yoga leaves them itself, where its
 * rounding is not below 0.
 *
 * It is `stoppedLine`'s rounding the other way. Yoga's first pass takes
 * each item its maximum stops out of the sum of the grow factors, and the
 * second divides the room still left by what is left of the sum: with
 * every item stopped, `(a + b + c) - a - b - c` in float32s. Where that is
 * 0, or a rounding above it, the quotient is vast and each item is held to
 * its maximum, which is right; where it is a rounding below, each is held
 * to its minimum. Three items of `flex-grow: 3.361`, `2.417` and `1.988`,
 * each `max-width: 10px`, in a row 100 wide came out nothing wide, as a
 * third of such lines of random factors do. Sums of whole numbers, and of
 * halves and quarters of them, are exact, so a box whose factors are those
 * is not looked at (`exactSums`).
 *
 * What makes a line one to put right is Yoga's answer, looked at as
 * `stoppedLine` looks at its. Every item of the line that may grow has a
 * maximum, and the line has room to spare with each of them at it. And
 * one of them came out short of its maximum and no larger than its
 * hypothetical size (9.7, step 2), which Yoga, sharing out room, makes no
 * item: Yoga is asked for the line with nothing growing, where each item
 * is that size. No larger rather than smaller, because an item held to
 * its minimum is often that size: an empty one is nothing wide either
 * way. Any other line is put back as it was, and the two layouts that
 * took are the cost of a box with a factor that is not a whole number and
 * an item short of its maximum; any other box has cost a sum.
 *
 * A few of the lines put right are still not a browser's. Once
 * some of its items are frozen, 9.7 shares out to the rest only the part
 * of the room their factors come to, where that is less than 1 (step 4,
 * b), and Yoga has no such rule: an item of `flex-grow: 0.1` left alone
 * on a line is at its maximum here, as Yoga would have had it, and a
 * tenth of the room in Chrome.
 *
 * A box that wraps has lines like it: the last line of a grid of cards
 * with a `max-width` has room for every card it has. Yoga breaks lines by
 * its items' hypothetical sizes, which the layout with nothing growing
 * gives, and they are broken here as it breaks them (`linesOf`). Freezing
 * a line's items at their maximums moves no break: the line has room for
 * every item on it at that size, so it keeps them all, and the item after
 * it, which did not fit with them smaller, fits no better with them larger.
 * But Yoga holds a size to an item's maximum before its minimum, so where
 * the maximum is the smaller — or smaller than the item's padding and
 * borders — it breaks a line by one size and lays the item out at another:
 * `max-width: 2px; min-width: 10px` is 10 wide, on a line it was put on
 * as 2. A box that wraps with an item like that is left as Yoga had it.
 */
function cappedLines(
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
  row: boolean,
  /** The flex box's size along the main axis. */
  room: number,
  /** The size Yoga breaks lines at: the flex box's where it wraps and has
   *  one, and else Infinity, for the one line. */
  breaks: number,
  /** The gap between two items. */
  gap: number,
  hold: Hold,
  /** Lay the flex box out, as its nodes now are. */
  ask: () => void,
): boolean {
  // two at the least: what is left of a sum of one, less it, is 0 exactly
  const growing = items.filter(({ box, laid }) => grows(box, laid));
  if (growing.length < 2 || exactSums(growing)) return false;
  // one short of its maximum, as each on such a line is
  const short = growing.some(
    ({ box, laid }) => laid.main < mostOf(box, laid, row) - 0.01,
  );
  if (!short) return false;
  if (breaks === Infinity) {
    // and on the one line, every one of them with a maximum, and room left
    // over as Yoga has it
    let used = gap * (items.length - 1);
    for (const { box, laid } of items) used += laid.main + marginsOf(box, row);
    const capped = growing.every(({ box, laid }) => !Number.isNaN(laid.most));
    if (!capped || !(used < room - SHORT)) return false;
  } else if (
    // and on lines broken where the layout says, with no item that Yoga
    // breaks a line by at another size
    items.some(({ box, laid }) => laid.most < leastOf(box, laid, row))
  ) {
    return false;
  }

  const flexible = items.filter(({ laid }) => Number.isNaN(laid.held));
  for (const { node } of flexible) {
    node.setFlexGrow(0);
    node.setFlexShrink(0);
  }
  ask();
  // each item its hypothetical size, on every line
  const hypothetical = items.map(({ node }) =>
    row ? node.getComputedWidth() : node.getComputedHeight(),
  );
  const frozen = new Set<Box>();
  for (const line of linesOf(items, hypothetical, row, breaks, gap)) {
    const growers = line.filter((i) => grows(items[i].box, items[i].laid));
    if (growers.length < 2) continue;
    // the line with each item that may grow at its maximum: Infinity where
    // one has none
    let size = gap * (line.length - 1);
    let smaller = false;
    for (const i of line) {
      const { box, laid } = items[i];
      size += marginsOf(box, row);
      if (!grows(box, laid)) {
        size += hypothetical[i];
        continue;
      }
      const most = mostOf(box, laid, row);
      size += most;
      if (
        laid.main < most - 0.01 &&
        (laid.main < hypothetical[i] || nearly(laid.main, hypothetical[i]))
      ) {
        smaller = true;
      }
    }
    if (!smaller || !(size < room - SHORT)) continue;
    for (const i of growers) frozen.add(items[i].box);
  }
  for (const { box, node, laid } of flexible) {
    if (frozen.has(box)) {
      freezeAt(node, laid, row, mostOf(box, laid, row), hold);
    } else {
      node.setFlexGrow(box.style.flexGrow);
      node.setFlexShrink(box.style.flexShrink);
    }
  }
  ask();
  return true;
}

/**
 * The lines Yoga breaks a flex box's items into, as indices of them. A line
 * takes items while their hypothetical sizes, their margins and the gaps
 * between them come to no more than the size it breaks at, and always
 * takes one — added up in float32s, in the order Yoga adds them, so that an
 * item that fits exactly is on the line it is on in Yoga's.
 */
function linesOf(
  items: readonly { box: Box }[],
  /** Each item's hypothetical size along the main axis. */
  sizes: readonly number[],
  row: boolean,
  breaks: number,
  gap: number,
): number[][] {
  if (breaks === Infinity) return [items.map((_, i) => i)];
  const f = Math.fround;
  const limit = f(breaks);
  const lines: number[][] = [];
  let line: number[] = [];
  let used = 0;
  items.forEach(({ box }, i) => {
    const size = f(sizes[i]);
    const style = box.style;
    const [start, end] = row
      ? [style.marginLeft, style.marginRight]
      : [style.marginTop, style.marginBottom];
    const margin = f(
      (start === AUTO ? 0 : f(row ? box.marginLeft : box.marginTop)) +
        (end === AUTO ? 0 : f(row ? box.marginRight : box.marginBottom)),
    );
    let lead = line.length ? f(gap) : 0;
    if (line.length && f(f(f(used + size) + margin) + lead) > limit) {
      lines.push(line);
      line = [];
      used = 0;
      lead = 0;
    }
    used = f(used + f(f(size + margin) + lead));
    line.push(i);
  });
  lines.push(line);
  return lines;
}

/** Whether Yoga may grow an item: it has a grow factor, and is not frozen
 *  (`freezeAt`). */
function grows(box: Box, laid: Laid): boolean {
  return box.style.flexGrow > 0 && Number.isNaN(laid.held);
}

/** The most an item may be along the main axis, its border box: the
 *  maximum of its own, where it has one, and no less than its least size;
 *  Infinity where it has none. */
function mostOf(box: Box, laid: Laid, row: boolean): number {
  if (Number.isNaN(laid.most)) return Infinity;
  return Math.max(laid.most, leastOf(box, laid, row));
}

/** An item's margins along the main axis, where they are not `auto`: an
 *  `auto` margin is none to the size of its line (CSS Flexbox 8.1). */
function marginsOf(box: Box, row: boolean): number {
  const style = box.style;
  if (row) {
    return (
      (style.marginLeft === AUTO ? 0 : box.marginLeft) +
      (style.marginRight === AUTO ? 0 : box.marginRight)
    );
  }
  return (
    (style.marginTop === AUTO ? 0 : box.marginTop) +
    (style.marginBottom === AUTO ? 0 : box.marginBottom)
  );
}

/**
 * Whether Yoga's sums of these items' grow factors are exact: in float32s,
 * as it adds them, a sum of whole numbers is, and so is one of halves and
 * quarters of them, and what is left of it less each of its terms is then
 * 0 exactly (`cappedLines`).
 */
function exactSums(items: readonly { box: Box }[]): boolean {
  let sum = 0;
  for (const { box } of items) {
    const factor = box.style.flexGrow * EXACT;
    if (!Number.isInteger(factor)) return false;
    sum += factor;
  }
  // every sum along the way a whole number of the parts under a float32's
  // 24 bits of significand
  return sum < 2 ** 24;
}

/** The parts of one a grow factor may be a whole number of and have its
 *  sums exact (`exactSums`). */
const EXACT = 1024;

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
