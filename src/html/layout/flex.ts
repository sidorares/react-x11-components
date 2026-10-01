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
  STRETCHED_ACROSS,
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
  heightThroughRatio,
  widthFromHeight,
  resolveEdges,
} from './block.js';
import { layoutGrid } from './css-grid.js';
import { firstBaselineIn } from './inline.js';
import { TABLE_CONTENT } from './table.js';
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
  // the limits on its content box's height where it has none of its own
  let floor = 0;
  let ceiling = Infinity;
  if (height !== null) root.setHeight(height);
  else {
    root.setHeightAuto();
    const extra = box.verticalExtra;
    const min = clampHeight(box, extra) - extra;
    if (min > 0) {
      floor = min;
      root.setMinHeight(min);
    }
    const max = clampHeight(box, Infinity) - extra;
    if (Number.isFinite(max)) {
      ceiling = Math.max(0, max);
      root.setMaxHeight(ceiling);
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

  // Whether a line weighs its items one against another as it shrinks
  // them, each by its flex base size (CSS Flexbox 9.7, step 4c): the one
  // line of a row that does not wrap, two or more of whose items may
  // shrink. One that shrinks alone comes to the room the rest leave it,
  // whatever its base, and a line of a row that wraps is too narrow for
  // an item only where that is alone on it.
  const weighs =
    box.style.flexWrap === 'nowrap' &&
    box.style.flexDirection.startsWith('row') &&
    flowing.filter((child) => child.style.flexShrink > 0).length > 1;

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
      basis: NaN,
      sized: false,
      content: NaN,
      fitted: NaN,
      base: NaN,
      narrowest: NaN,
      held: NaN,
      minimum: NaN,
      auto: false,
      across: false,
      unstretched: NaN,
    };
    applyItem(
      node,
      child,
      ctx,
      contentWidth,
      laid,
      height !== null,
      own ? definite : NaN,
      weighs,
    );
    root.insertChild(node, items.length);
    items.push({ box: child, node, laid });
  }

  // A column that wraps is as wide as its content box, but each of its
  // lines is as wide as its widest item, every item `fit-content` across
  // (CSS Flexbox 9.4, steps 7 and 8), and so is placed across here and not
  // by Yoga (`crossLines`). Yoga stretched an item to the box wherever the
  // column had room for every item down it — with no height, always — so a
  // line was the box's width, an item wider at its narrowest ran out of
  // it, and `align-content` had no room to centre or end a line in. And
  // stretching a line, it laid each stretched item out again at its height
  // less its top and bottom margins and plus its side ones (its multi-line
  // pass adds the margins across a column where it means the ones down
  // it), and added what `space-around` puts between lines to its width. So
  // Yoga lays the box out with every item at its line's start, where it
  // measures each `fit-content` (`innerWidth`) and down the column as wide
  // as that, as the specification measures a line's items (9.2, step 3),
  // and the lines one more pixel apart than they are, so that each line
  // starts where the last does not and says which items are on it.
  const crossed = wrapsColumn(box.style, contentWidth);
  if (crossed) {
    root.setAlignContent(Y.ALIGN_FLEX_START);
    root.setGap(Y.GUTTER_COLUMN, columnGap + 1);
    for (const { node } of items) node.setAlignSelf(Y.ALIGN_FLEX_START);
  }
  if (bounded) root.setWidth(contentWidth);

  const direction =
    box.style.direction === 'rtl' ? Y.DIRECTION_RTL : Y.DIRECTION_LTR;
  const row = box.style.flexDirection.startsWith('row');
  // Yoga aligns the lines of a box that wraps, or aligns by baselines, in
  // one pass of its own, which drops a margin (`lineMarginFix`)
  let baselines =
    box.style.alignItems === 'baseline' ||
    items.some(({ box: child }) => child.style.alignSelf === 'baseline');
  // An `auto` margin across a row that wraps takes the room its line has
  // past the item (CSS Flexbox 8.1, 9.6), where Yoga's pass that sets the
  // items across their lines reads an item's alignment and not its
  // margins: it stretched one with `margin-top: auto` to its line, and set
  // one with a height at its line's start. So Yoga is told the alignment
  // the margins come to (`autoAcross`), which it then places it by.
  if (row && box.style.flexWrap !== 'nowrap') {
    const reverse = box.style.flexWrap === 'wrap-reverse';
    for (const { box: child, node } of items) {
      const aligned = autoAcross(child.style, reverse);
      if (aligned) node.setAlignSelf(ALIGN[aligned]);
    }
  } else if (row && baselines) {
    // Yoga takes a row that does not wrap through that pass as well, and
    // sets its line there as tall as its items and not the row, and an
    // item with an `auto` margin by its baseline: at the top, where the
    // margin puts it at the bottom, and every item beside it as far down
    // as its height reached. That item takes no part in aligning the line
    // by baselines (9.4 step 8), and Yoga is told the alignment its
    // margins come to. With fewer than two items left that do take part,
    // they come to their line's start, which Yoga is told as well: then
    // nothing in the row is aligned by its baseline, Yoga takes no such
    // pass, and the line is the row. Two or more are lined up by their
    // baselines once those are known (`baselineLines`).
    const auto = items.filter(({ box: child }) =>
      autoAcross(child.style, false),
    );
    if (auto.length > 0) {
      for (const { box: child, node } of auto) {
        node.setAlignSelf(ALIGN[autoAcross(child.style, false)!]);
      }
      const aligned = items.filter(({ box: child }) =>
        byBaseline(box.style, child.style),
      );
      if (aligned.length < 2) {
        for (const { node } of aligned) node.setAlignSelf(Y.ALIGN_FLEX_START);
        if (box.style.alignItems === 'baseline') {
          root.setAlignItems(Y.ALIGN_FLEX_START);
        }
        baselines = false;
      }
    }
  }
  // frozen at its least size on the one line of a box that does not
  // wrap, by a basis where Yoga takes one along the main axis
  // (`applyItem`'s `setBasis`)
  const hold: Hold = {
    frozen: box.style.flexWrap === 'nowrap',
    basis: row ? bounded : height !== null,
  };
  const layout = (): void =>
    root.calculateLayout(
      bounded ? contentWidth : Number.NaN,
      height ?? Number.NaN,
      direction,
    );
  // Down a column that wraps, the items Yoga stretches across their lines
  // come out of its layout at another height than it sized them at, where
  // their side margins are not their top and bottom ones (`unstretch`):
  // laid out so that each has the height it was sized at
  const restretched = row || hold.frozen ? [] : stretchedDown(root, items);
  const sized = bounded ? contentWidth : null;
  // and across a row that wraps, the items Yoga stretches across lines
  // `align-content` spaces out come out of its layout as tall as their
  // line and the room after it as well (`unspace`): laid out so that each
  // is as tall as its line, where the box has room to space them out in —
  // a height, or a minimum one
  const spaced =
    row &&
    bounded &&
    !hold.frozen &&
    (height !== null || floor > 0) &&
    spacesLines(box.style);
  const ask =
    restretched.length > 0
      ? (): void => unstretch(items, restretched, sized, layout)
      : spaced
        ? (): void =>
            unspace(root, items, box.style.flexWrap === 'wrap-reverse', layout)
        : layout;
  // The one line of a box that does not wrap is shared out by CSS
  // Flexbox 9.7 where Yoga's answer for it may not be what that makes of
  // it (`resolveLine`): along a row of a width, or down a column of a
  // height or of limits on one, where a line may have room to share out
  const line: FlexLine | null =
    hold.frozen &&
    (row ? bounded : height !== null || floor > 0 || ceiling < Infinity)
      ? {
          resolved: false,
          size: row ? contentWidth : (height ?? NaN),
          floor,
          ceiling,
          between: betweenOf(items, row, row ? columnGap : rowGap),
          probe: row && contentWidth === MIN_CONTENT_PROBE,
        }
      : null;
  // and the lines of a box that wraps may have room left over, where a
  // row has a width to have it in: Yoga's answer for one every item of
  // which that may grow its maximum stops is put right (`cappedLines`) —
  // broken into lines as Yoga breaks them, at the box's size along them
  const roomy = !hold.frozen && (row ? bounded : true);
  const breaks = row ? contentWidth : (height ?? Infinity);
  // each item's size along the main axis, read the once a layout (`Laid`)
  const read = (): void => {
    for (const { node, laid } of items) {
      laid.main = row ? node.getComputedWidth() : heightOf(node, laid);
    }
  };
  const calculate = (): void => {
    // a line shared out here is again, before Yoga places it: an item
    // since held at its content's size is frozen there (`autoMinimums`)
    if (line?.resolved) shareOut(items, row, line, hold);
    ask();
    read();
    if (line && !line.resolved) {
      const room = Number.isNaN(line.size)
        ? root.getComputedHeight()
        : line.size;
      if (resolveLine(items, row, line, room, hold, ask)) read();
    } else if (roomy) {
      const room = row ? contentWidth : (height ?? root.getComputedHeight());
      const gap = row ? columnGap : rowGap;
      if (cappedLines(items, row, room, breaks, gap, hold, ask)) read();
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

  // The lines of a row that wraps are as tall as their tallest items, each
  // as tall as its content across (CSS Flexbox 9.4, steps 7 and 8), and
  // `align-content` stretches lines short of the box to it, or centres
  // them, or ends them, past its edges where they are taller (step 9).
  // Handed the box's height as a size, Yoga measures a stretched item at it
  // wherever the row has room along it for every item, and so its line is
  // the box's height: an item taller than the box was squashed to it, and a
  // line `align-content` centres stayed at the box's top. Where that is so
  // (`heldLine`), the box is held to its height from both sides instead,
  // and laid out again: Yoga measures each item as at most that tall, which
  // its content passes where it is taller — the maximum a percentage, as a
  // minimum and a maximum that are the same are a size to Yoga. Only there,
  // which takes in the one line `space-around` and `space-evenly` centre,
  // and not where the row is measured for its widest, which is laid out
  // for its width alone.
  if (
    row &&
    bounded &&
    height !== null &&
    box.style.flexWrap !== 'nowrap' &&
    heldLine(box, ctx, items, height, contentWidth, columnGap)
  ) {
    root.setHeightAuto();
    root.setMinHeight(height);
    root.setMaxHeightPercent(100);
    // and a percentage height resolved: Yoga takes one inside a box it
    // does not hold to a size for none, and measured `h-1/2` as tall as
    // its content
    if (own) {
      for (const { box: child, node } of items) {
        const set = child.style.height;
        if (!isPct(set)) continue;
        const down =
          child.style.boxSizing === 'border-box' ? 0 : child.verticalExtra;
        node.setHeight(resolve(set, definite) + down);
      }
    }
    ctx.flexDepth = depth + 1;
    try {
      calculate();
    } finally {
      ctx.flexDepth = depth;
    }
  }

  let bottom = placeItems(
    box,
    ctx,
    items,
    row,
    own,
    box.style.flexWrap !== 'nowrap' || baselines,
    contentWidth,
    undefined,
    crossed ? crossLines(box.style, items, contentWidth, columnGap) : undefined,
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
      box.style.flexWrap !== 'nowrap',
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
      box.style.flexWrap !== 'nowrap' || baselines,
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
    // and is shared out from it where its line is here (`shareOut`)
    laid.basis = basis;
    laid.sized = false;
    laid.base = basis;
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
  /** Where each item is across a column that wraps (`crossLines`). */
  crossed?: ReadonlyMap<Box, Across>,
): number {
  let bottom = 0;
  // the lines of a row that wraps in reverse are turned round to run up it
  const reverse = row && box.style.flexWrap === 'wrap-reverse';
  for (const { box: child, node, laid } of items) {
    const placed = crossed?.get(child);
    const across =
      lined && !placed
        ? lineMarginFix(box.style, child, node, row, own, started?.has(child))
        : 0;
    const itemHeight = row ? heightOf(node, laid) : laid.main;
    const left =
      box.contentX +
      (placed ? placed.x : node.getComputedLeft() + (row ? 0 : across));
    // which Yoga turns an item round in by the height it laid it out at, and
    // not the one it is (`unspace`)
    const top =
      box.contentY +
      node.getComputedTop() +
      (row ? across : 0) +
      (reverse ? node.getComputedHeight() - itemHeight : 0);
    const width = placed
      ? placed.width
      : meant(
          row ? laid.main : node.getComputedWidth(),
          laid.set,
          laid.stretch,
          laid.width,
          row ? laid.held : NaN,
        );
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
  // it was given more — or less than a height of its own, which it takes
  // in place of that one, down to its rows.
  const given = definite ?? (column ? height : null);
  let shares = false;
  if (given !== null && (box.kind === 'flex' || box.kind === 'table')) {
    const natural = naturalHeight(box, ctx, width, containing, laid);
    shares =
      box.kind === 'flex'
        ? !(Math.abs(natural - given) <= 0.01)
        : !(natural >= given - 0.01) ||
          (box.style.height !== AUTO && natural > given + 0.01);
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
      layoutAt(box, ctx, width, containing, laid);
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
  const lines = ALIGN[crossContent(style)] ?? Y.ALIGN_STRETCH;
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
  /** That height where it is definite, and a percentage may be of it, and
   *  else NaN: one a column flexed the box to is not (`USED_HEIGHT`). */
  definite: number,
  /** Whether its line weighs it against another as it shrinks them, by
   *  their flex base sizes (`layoutFlex`). */
  weighed: boolean,
): void {
  const style = box.style;
  const own = Number.isFinite(definite);
  const row = box.parent?.style.flexDirection.startsWith('row') ?? true;
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
  // `stretch` sets an item whose height is a percentage of none at its
  // line's start, as tall as its content (`heightOfNone`), where Yoga,
  // which is handed no height for it, stretched it across the line
  if (row && box.parent && heightOfNone(style, own)) {
    const align =
      style.alignSelf === AUTO ? box.parent.style.alignItems : style.alignSelf;
    if (align === 'stretch') node.setAlignSelf(Y.ALIGN_FLEX_START);
  }

  // Yoga's sizes are border boxes, as `box-sizing: border-box` has them;
  // a `content-box` length is the content's, and the item's padding and
  // border go on top of it
  const across = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
  const down = style.boxSizing === 'border-box' ? 0 : box.verticalExtra;
  if (style.width !== AUTO) {
    laid.set = setLength(node, true, style.width, containingWidth, across);
  }
  // Down a column, a basis of the content's — `content`, or a percentage
  // of a height that is not definite (CSS Flexbox 7.2.3) — is its content's
  // height, whatever height it has of its own (9.2.3, E), and Yoga takes
  // the height of its own for a basis where it has one. So that is kept
  // from Yoga, and the measure function answers with the content's.
  const contentColumn =
    !row && (style.flexBasis === 'content' || (isPct(style.flexBasis) && !own));
  // a percentage of a height that is not definite is `auto` (CSS 2.1 10.5),
  // and is not handed to Yoga, which makes one of the height of a flex box
  // with none of its own but limits on one — and the height set on its
  // node, where that is a length, and whether one is
  let height = NaN;
  let heightSet = false;
  if (
    style.height !== AUTO &&
    (own || !isPct(style.height)) &&
    !contentColumn
  ) {
    height = setLength(node, false, style.height, definite, down);
    heightSet = true;
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
  // a percentage of a definite height, which a limit on a flex item's
  // height is where its flex box has one
  const minHeight = resolveOrNull(style.minHeight, definite);
  if (minHeight !== null) {
    leastHeight = minHeight + down;
    node.setMinHeight(leastHeight);
  }
  if (style.maxHeight !== 'none') {
    const maxHeight = resolveOrNull(style.maxHeight, definite);
    if (maxHeight !== null) {
      mostHeight = maxHeight + down;
      node.setMaxHeight(mostHeight);
    }
  }

  // a `border-box` maximum under the item's padding and borders is them,
  // its content box none wide (CSS Sizing 3, 3.3), where Yoga lays the
  // item out as wide as them and shares out its line as though it were
  // as wide as the maximum: the `auto` margins after `max-width:
  // 20.668px` with 23px of padding and border took the 2.33px between
  if (mostWidth < box.horizontalExtra) {
    mostWidth = box.horizontalExtra;
    node.setMaxWidth(mostWidth);
  }
  if (mostHeight < box.verticalExtra) {
    mostHeight = box.verticalExtra;
    node.setMaxHeight(mostHeight);
  }
  // a maximum under the minimum is the minimum (CSS 2.1 10.4, 10.7), where
  // Yoga holds an item that comes to more than both at the maximum
  if (mostWidth < leastWidth) {
    mostWidth = leastWidth;
    node.setMaxWidth(mostWidth);
  }
  if (mostHeight < leastHeight) {
    mostHeight = leastHeight;
    node.setMaxHeight(mostHeight);
  }

  laid.least = row ? leastWidth : leastHeight;
  laid.most = row ? mostWidth : mostHeight;
  laid.narrowest = leastWidth;
  // A table is as wide as the flex layout makes it, as any item is: the
  // size its line flexed it to along a row (9.7), and across a column's
  // line the line's, stretched (9.4, step 11) — where in a block's flow it
  // is as wide as its columns. Laid out at that width and then shrunk to
  // them, it was a table its columns wide at the start of a column, and one
  // `flex: 1` along a row stopped at them where Chrome's fills its share
  laid.across =
    box.kind === 'table' &&
    (row ||
      (box.parent !== null &&
        !style.widthKeyword &&
        stretches(box, box.parent.style, false)));
  // Yoga takes a length for a basis only where the flex box's main size is
  // definite, and else the item's own size along it: down a column of no
  // height of its own it read `flex: 0 0 3rem` as the item's height, or
  // its content's. There the basis is handed over as that height, which is
  // what the item's own is to a basis anyway — no more than its start
  const setBasis = (px: number): void => {
    laid.basis = px;
    if (row || tall) node.setFlexBasis(px);
    else node.setHeight(px);
  };
  // Where Yoga takes the item's own size along the main axis for its
  // basis, that size as a length, or its content's (`Laid.sized`) — and
  // its content's, whatever size it has, for a basis that says so, which
  // Yoga reads as its size down a column
  const ownSize = (content = false): void => {
    if (
      content ||
      (row ? style.width === AUTO && !style.widthKeyword : !heightSet)
    ) {
      laid.sized = true;
    } else laid.basis = row ? laid.set : height;
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
    laid.basis = contentBasis(box, ctx, containingWidth);
    node.setFlexBasis(laid.basis);
  } else if (columnBasis !== null) {
    // but a height of its own hides it from Yoga, and an item with a ratio
    // and a width is as tall as that makes it
    setBasis(columnBasis);
  } else if (style.flexBasis === 'content' || style.flexBasis === AUTO) {
    // Yoga's own
    ownSize(style.flexBasis === 'content');
  } else if (isPct(style.flexBasis) && !row && !own) {
    // a percentage of a main size that is not definite is `content` (CSS
    // Flexbox 7.2.3): Yoga's own, down a column
    ownSize(true);
  } else if (isPct(style.flexBasis)) {
    // a percentage of the main size, which is known across a row and down
    // a column of a definite height: of a content box's size, as a width
    // is, where the item's padding and border go on top of it
    const basis = style.flexBasis;
    const extra = row ? across : down;
    const known = row ? Number.isFinite(containingWidth) : own;
    if (known) {
      laid.basis = resolve(basis, row ? containingWidth : definite) + extra;
    }
    if (!basis.px && !basis.of && !(known && extra)) {
      node.setFlexBasisPercent(basis.pct);
    } else if (known) node.setFlexBasis(laid.basis);
    else if (basis.of) {
      node.setFlexBasisAuto();
      ownSize();
    } else node.setFlexBasisPercent(basis.pct);
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
  const alongRow = row;
  const content = (): number => {
    const width = maxContent();
    // its flex base size, where that is its content's (`Laid.sized`)
    if (alongRow) laid.content = width + box.horizontalExtra;
    return width;
  };
  function maxContent(): number {
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
      // measured, it is laid out with no limit on its width, and not at
      // the one it was last laid out at, which Yoga may give it again: an
      // item `min-width: min-content` that Yoga asked at its minimum and
      // then with no limit was left laid out infinitely wide
      laid.width = NaN;
    }
    // within what its least and greatest heights make of widths through
    // its ratio: its size before it is flexed, and not after
    const extra = box.horizontalExtra;
    return Math.max(0, transferredWidth(box, width + extra) - extra);
  }
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
    // which Yoga asks for as at most the row's width. One that may not
    // shrink is as wide as that (9.7): fitted to the room, a `shrink-0`
    // item of words was held to its content at its narrowest, and wrapped
    // where it overflows the row. And one that may shrink gives up room in
    // proportion to it, where its line weighs it against another (9.7,
    // step 4c, its flex shrink factor times its base): fitted, an item of
    // words wider than the row was weighed as no wider than the row, and
    // gave up too little of it beside a narrower one — 230 and 70 of a row
    // of 300, where Chrome has 245 and 55. One that shrinks alone is
    // fitted, which comes to the same and keeps the layout it is measured
    // at for the one it is given: at its widest, a paragraph in a row laid
    // itself out twice.
    // And every item of a row laid out in no room is fitted, which is the
    // flex box measured for its content at its narrowest
    // (`MIN_CONTENT_PROBE`): that is the sum of its items' content at their
    // narrowest, whatever they may shrink by, as Chrome and the css-flexbox
    // suite have it (`intrinsic-size/row-001`, `gap-015`), and not their
    // bases.
    // Across a column, the item is `fit-content` wide where it is not
    // stretched (9.4, step 7): fitted to the column, but no narrower than
    // its content at its narrowest, past the column where that is wider,
    // as a centred one is on both sides. Its `min-width` has no say in
    // that: an automatic minimum is the main axis's (4.5), so `auto` is 0
    // across a column, the same as the `min-width: 0` that lets an item
    // shrink along a row. Fitted to the column, a word wider than it ran
    // out of the item, and a centred item started at the column's start.
    // A replaced element's narrowest is its natural width, or one through
    // its ratio, and none where it has neither: an SVG with only a
    // `viewBox` is as wide as the column. And an item with something in
    // it that takes a percentage of a height is fitted to the column still:
    // the flex layout makes its height definite only after this, and
    // measured without it, an image `height: 100%` is its natural width.
    const widest =
      alongRow &&
      !exact &&
      (box.kind === 'replaced' ||
        (containingWidth !== MIN_CONTENT_PROBE &&
          (style.flexShrink === 0 || weighed)));
    const narrowest =
      alongRow || percentHeightsIn(box)
        ? undefined
        : box.kind === 'replaced'
          ? () => (replacedMinimum(box, containingWidth) ?? extra) - extra
          : () => minContentOf(box, ctx, laid) - extra;
    const fitted =
      through !== null
        ? through
        : widest
          ? content()
          : innerWidth(width, wm, content, narrowest);
    // Across a column, no wider than its maximum: Yoga hands the measure
    // a room within it, but holds the answer's width to it only after,
    // and keeps the height measured at the wider — an image `max-width:
    // 100%` its natural width at its narrowest was as tall as that made it
    const capped =
      !alongRow && fitted > mostWidth - extra ? mostWidth - extra : fitted;
    // And no narrower than its minimum: Yoga holds the item to that only
    // after it has the answer, which it keeps for the width that makes of
    // it, so an item measured at the room and held to a wider minimum was
    // as tall as its content wrapped at the room — `min-w-max` in a narrow
    // row, or down a column narrower than it, one line of words two lines
    // tall, and an item held to its longest word in a row that wraps
    // (`holdAt`) a line taller than that makes it. Stretched across a
    // column, it is asked at the column's width.
    const inner = Number.isNaN(laid.narrowest)
      ? capped
      : Math.max(capped, laid.narrowest - extra);
    let answer: { width: number; height: number } | undefined;
    if (
      box.kind === 'replaced' &&
      exact &&
      ratio > 0 &&
      style.height === AUTO
    ) {
      answer = { width: inner, height: inner / ratio };
    } else {
      answer = answers.get(inner);
      if (answer === undefined) {
        answer = measureBox(box, ctx, inner, containingWidth, laid);
        answers.set(inner, answer);
      }
    }
    // along a row, the width it answered where it might choose one
    if (alongRow && wm !== Y.MEASURE_MODE_EXACTLY) {
      laid.fitted = answer.width + box.horizontalExtra;
    }
    // down a column, its content's height where nothing held it to one:
    // its flex base size, where that is its content's (`Laid.sized`) — for
    // a basis that says so, what a height of its own has no say in
    if (!alongRow && !given) {
      if (contentColumn && style.height !== AUTO && box.kind !== 'replaced') {
        const width = inner + box.horizontalExtra;
        const kept = keptNatural(box, ctx, width, containingWidth);
        let content = kept?.content ?? NaN;
        if (Number.isNaN(content)) {
          if (kept === null || kept.serial !== box.layoutSerial) {
            layoutNaturally(box, ctx, width, containingWidth, laid);
          }
          content = columnContent(box, ctx, laid, width, containingWidth);
        }
        answer = {
          width: answer.width,
          height: Math.max(0, content - box.verticalExtra),
        };
      }
      laid.content = answer.height + box.verticalExtra;
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
  /** Its flex base size (CSS Flexbox 9.2, step 3), its border box's, where
   *  its style says what that is — a basis or a size along the main axis
   *  that is a length — or NaN where its content does (`content`) or Yoga
   *  resolves it. */
  basis: number;
  /** Whether its flex base size is its content's size along the main axis,
   *  which the measure function notes (`content`). */
  sized: boolean;
  /** Its content's size along the main axis, its border box's, as the
   *  measure function last found it with nothing holding it to a size
   *  there: its max-content width along a row, its height at its width
   *  down a column. NaN until measured so. */
  content: number;
  /** The border-box width the measure function last answered along a row
   *  where Yoga asked for one it might choose, its content's fitted to the
   *  room: the flex base size Yoga takes for it (`FlexLine.probe`). */
  fitted: number;
  /** The flex base size its line was shared out from where this engine
   *  shared it (`resolveLine`), or NaN. */
  base: number;
  /** The least border-box width its node was given, along a row or across
   *  a column: its own minimum, or along a row the automatic one it is
   *  held to (`holdAt`), or NaN. It is measured at no narrower. */
  narrowest: number;
  /** The size along the main axis it is frozen at, inflexible (`freezeAt`),
   *  or NaN. */
  held: number;
  /** Its automatic minimum along the main axis (CSS Flexbox 4.5), where it
   *  is held to it (`holdAt`), or NaN. */
  minimum: number;
  /** Whether that is its automatic minimum (`holdAt`), its content's size,
   *  and not a size its line was shared out to (`resolveLine`). */
  auto: boolean;
  /** Whether it is a table the flex layout gives its width — flexed along a
   *  row, stretched across a column's line — which it is laid out at as its
   *  own (`STRETCHED_ACROSS`, `layoutAt`). */
  across: boolean;
  /** Its border box's height as Yoga sized it before it laid it out again
   *  across its line, at another: down a column that wraps (`unstretch`),
   *  or across a row whose lines are spaced out (`unspace`). NaN where that
   *  is the height Yoga has for it. */
  unstretched: number;
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
    layoutAt(box, ctx, width, containing, laid);
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
 * Lay an item out at a border-box width: a table the flex layout gives its
 * width at that width as its own (`Laid.across`), for this layout alone. A
 * width Yoga asks its content at is one the table comes to by its columns
 * all the same — its widest, or the room where that is less — so that is
 * no matter; an unbounded one, a probe of a box around the flex box, is
 * the table's to shrink in.
 */
function layoutAt(
  box: Box,
  ctx: LayoutContext,
  width: number,
  containing: number,
  laid: Laid,
): void {
  if (!laid.across || !Number.isFinite(width)) {
    ctx.layoutSubtree(box, width, containing);
    return;
  }
  STRETCHED_ACROSS.add(box);
  try {
    ctx.layoutSubtree(box, width, containing);
  } finally {
    STRETCHED_ACROSS.delete(box);
  }
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
 *  (CSS Flexbox 9.2) — and, given its min-content width, no narrower than
 *  that either. */
function innerWidth(
  width: number,
  mode: number,
  maxContent: () => number,
  minContent?: () => number,
): number {
  if (mode === Y.MEASURE_MODE_EXACTLY && Number.isFinite(width)) {
    return Math.max(0, width);
  }
  const content = maxContent();
  if (mode !== Y.MEASURE_MODE_AT_MOST || !Number.isFinite(width)) {
    return content;
  }
  // a room exactly as wide as the content, as Yoga holds it, is room for it
  if (content <= width || nearly(content, width)) return content;
  const room = Math.max(0, width);
  return minContent ? Math.min(content, Math.max(room, minContent())) : room;
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
    const width = meant(
      row ? laid.main : node.getComputedWidth(),
      laid.set,
      laid.stretch,
      laid.width,
      row ? laid.held : NaN,
    );
    // A table is no smaller than it can be along either axis, whatever its
    // own least says, `min-width: 0` and `min-height: 0` among it: its
    // columns at their narrowest along a row, and down a column its rows
    // and captions at the width it has, however short a height of its own
    // is (CSS 2.1 17.5.2 and 17.5.3; Blink, `length_utils.cc`: "Tables
    // can't shrink below their min-intrinsic size"). The line is laid out
    // with it so, and the items after it start where it ends: Yoga had it
    // as small as its line, and the next item over the rest of it — read
    // as a block's content, two pixels into it, the spacing under its rows
    if (box.kind === 'table') {
      // as wide as its columns at their widest, where Yoga measured that,
      // it has room for them at their narrowest, which is a layout less
      const widest = row ? MAX_CONTENT.get(box) : undefined;
      if (
        widest !== undefined &&
        laid.main >= widest + box.horizontalExtra - 0.01
      ) {
        continue;
      }
      const least = row
        ? minContentOf(box, ctx, laid)
        : tableContent(box, ctx, width, containingWidth, laid);
      if (laid.main >= least - 0.01) continue;
      holdAt(node, laid, row, least, hold);
      changed = true;
      continue;
    }
    // a box that scrolls or clips has none, but for one that asks for its
    // content's height
    const asked = !row && style.minHeightKeyword !== null;
    if (!asked && scrolls(style)) {
      continue;
    }
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
      let content = Number.isNaN(read)
        ? columnContent(box, ctx, laid, width, containingWidth)
        : read;
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

/**
 * How far down a column item's content comes at a border-box width, its
 * border box's, from the layout its content's own height makes of it
 * there (`layoutNaturally`), which it has: what a height of its own has no
 * say in, which its automatic minimum reads (CSS Flexbox 4.5), and a flex
 * basis of `content` (9.2.3, E).
 */
function columnContent(
  box: Box,
  ctx: LayoutContext,
  laid: Laid,
  width: number,
  containingWidth: number,
): number {
  if (box.kind === 'replaced') return laid.height;
  if (box.style.height !== AUTO && percentHeightsIn(box)) {
    // what its content comes to where it has no height to take
    // percentages of, as an intrinsic size is measured: laid out so
    // apart, and the final pass lays it out again
    FLEXED_HEIGHT.set(box, NaN);
    try {
      ctx.layoutSubtree(box, width, containingWidth);
    } finally {
      FLEXED_HEIGHT.delete(box);
    }
    laid.width = NaN;
    return ratioContent(box, contentBottom(box) + box.verticalExtra);
  }
  const content = ratioContent(box, contentBottom(box) + box.verticalExtra);
  remember(box, ctx, width, containingWidth, 'content', content);
  return content;
}

/** A table item's rows and captions at a border-box width, its border box's
 *  height apart from one it sets (`TABLE_CONTENT`): read from its layout
 *  there, which it is given where it has another, and kept for the pass. */
function tableContent(
  box: Box,
  ctx: LayoutContext,
  width: number,
  containing: number,
  laid: Laid,
): number {
  const kept = keptNatural(box, ctx, width, containing);
  if (kept !== null && !Number.isNaN(kept.content)) return kept.content;
  // where the box has that layout still, it is put back and not made again
  layoutNaturally(box, ctx, width, containing, laid);
  const content = TABLE_CONTENT.get(box) ?? box.height;
  remember(box, ctx, width, containing, 'content', content);
  return content;
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
  laid.minimum = least;
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

/** The one line of a flex box that does not wrap, as it is shared out here
 *  (`resolveLine`). */
interface FlexLine {
  /** Whether its items are frozen at the sizes 9.7 shares it out to. */
  resolved: boolean;
  /** Its size along the main axis, where the box has one: its content
   *  box's width along a row, its height down a column of a height. NaN
   *  down a column that is as tall as its items make it, within limits. */
  size: number;
  /** Those limits, the least and the most its content box may be tall. */
  floor: number;
  ceiling: number;
  /** What is between the items' border boxes along it: the gaps, and
   *  their margins, an `auto` one none (8.1). */
  between: number;
  /**
   * Whether it is a row laid out in no room at all — how the box's
   * min-content width is measured (`MIN_CONTENT_PROBE`), where what an
   * item contributes to that is its min-content width and not a share of
   * a line. An item whose flex base size is its content's is taken there
   * at the size Yoga took, its content fitted to no room, and not at its
   * max-content width (`Laid.fitted`): a `flex: none` box of two floats
   * counted at its widest made a `width: min-content` flex box half as
   * wide again as Chrome has it. A row that is truly as wide as nothing is
   * taken the same way, and is laid out as Yoga has it.
   */
  probe: boolean;
}

/** What is between the border boxes of a line's items along the main
 *  axis: the gaps, and their margins, an `auto` one none — which is what
 *  it is while the line is shared out (CSS Flexbox 9.7, 8.1). */
function betweenOf(
  items: readonly { box: Box }[],
  row: boolean,
  gap: number,
): number {
  let between = gap * Math.max(0, items.length - 1);
  for (const { box } of items) {
    const style = box.style;
    if (row) {
      if (style.marginLeft !== AUTO) between += box.marginLeft;
      if (style.marginRight !== AUTO) between += box.marginRight;
    } else {
      if (style.marginTop !== AUTO) between += box.marginTop;
      if (style.marginBottom !== AUTO) between += box.marginBottom;
    }
  }
  return between;
}

/**
 * Share out the one line of a box that does not wrap as CSS Flexbox 9.7
 * does, where Yoga's answer for it may not be that, and freeze every item
 * at the size it comes to; whether Yoga was asked again.
 *
 * Yoga 3.2.1 shares a line out in two passes where 9.7 goes round until
 * no item's limit stops it, and each pass has its own way of coming out
 * elsewhere:
 *
 * - the first takes each item a limit stops out of the sum of the flex
 *   factors as it goes, and divides what the line is short of by that
 *   running sum, but takes the item's size off what the line is short of
 *   only once it has been round them all (react/yoga#2006, put right on
 *   Yoga's `main` behind an errata bit and in no release). Every item
 *   after the first one stopped is shrunk too far for it, and may be
 *   stopped too: `width: 100px` three times with `min-width` 95px, 45px
 *   and 0 in a row of 150 was 100, 100 and 100 wide, and overflowed it,
 *   where 9.7 has 95, 45 and 10 — with every item stopped, the line was
 *   left no shorter than it started, and the second pass shared out
 *   nothing. Where what is left of the sum is a float's rounding of
 *   nothing, the second pass divided by that, and each item came out
 *   billions of pixels wide, or none;
 * - it weighs an item's share of a shortfall by its flex base size where
 *   the item is stopped by a limit before it is shrunk, and adds it to the
 *   sum at its size within the limit, or the other way round: `width:
 *   200px; max-width: 110.992px` beside `200px` within `62.706px`, each
 *   with a `min-width`, in a row of 50 were 76.67 and 43.31, where 9.7
 *   shrinks both from 200 and has them at their minimums;
 * - and with no limit at work, it weighs that share by the flex base size,
 *   its border box's, where 9.7 weighs it by the inner flex base size, its
 *   content box's (step 4c), so an item gives up more the more padding
 *   and borders it has (`weighsPadding`);
 * - a limit that is more than the flex base size stops the item before
 *   any sharing out, and Yoga shares out from there: `flex: 1;
 *   min-width: 200px` beside a `flex: 1` in a row of 600 was 400 and
 *   200, where each grows from 0 and is 300;
 * - where the shrink factors come to less than 1, the line keeps that
 *   part of what it is short of (9.7, step 4b), and Yoga shares all of it
 *   out: a `flex-shrink: 0.5` alone was as wide as its row, where it
 *   keeps half of what it overflows by.
 *
 * Which is why a line is looked at only where Yoga's answer shows one of
 * these could be at work (`unshared`), and else left as it is: a line
 * none of whose items is stopped, that has been shared out, whose items'
 * limits do not clamp their flex base sizes, whose shrink factors come to
 * 1 or more, and which is not short of room with padding and borders more
 * of one item's flex base size than of another's is shared out by Yoga as
 * by 9.7.
 *
 * Each item's flex base size is what its style says it is, or its
 * content's size as the measure function found it (`Laid.sized`), and
 * where neither is known, Yoga is asked for the line with no limits and
 * nothing flexing, where each item is that size (`askBases`). An item held
 * at its automatic minimum is frozen there already (`holdAt`), and the
 * rest are shared out around it.
 */
function resolveLine(
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
  row: boolean,
  line: FlexLine,
  /** The size along the main axis Yoga laid the line out in. */
  room: number,
  hold: Hold,
  /** Lay the flex box out, as its nodes now are. */
  ask: () => void,
): boolean {
  if (!unshared(items, row, room - line.between, line.probe)) return false;
  let unknown = false;
  for (const { box, laid } of items) {
    laid.base = baseOf(box, laid, row, line.probe);
    if (Number.isNaN(laid.base) && Number.isNaN(laid.held)) unknown = true;
  }
  if (unknown) askBases(items, row, ask);
  const sizes = shareLine(items, row, line);
  if (items.every(({ laid }, i) => Math.abs(sizes[i] - laid.main) <= NEAR)) {
    // Yoga's answer, which asking for the bases has to be put back to
    if (unknown) ask();
    return unknown;
  }
  line.resolved = true;
  freezeLine(items, row, sizes, hold);
  ask();
  return true;
}

/** Freeze each item of a line at the size it was shared out to, but for
 *  one held at its automatic minimum whose flex base size is not known,
 *  which is frozen there already. */
function freezeLine(
  items: readonly { node: YogaNode; laid: Laid }[],
  row: boolean,
  sizes: readonly number[],
  hold: Hold,
): void {
  items.forEach(({ node, laid }, i) => {
    if (Number.isNaN(laid.base)) return;
    freezeAt(node, laid, row, sizes[i], hold);
    // its content's size, where that is what it came to (`Laid.auto`)
    laid.auto = sizes[i] <= laid.minimum + NEAR;
  });
}

/** How near to its room a line may be and have room to spare
 *  (`cappedLines`). */
const SHORT = 0.001;

/** Share a line this engine has shared out again from its items' flex base
 *  sizes, and freeze each item at its size: where one is since held at its
 *  content's size, the rest of the line is shared out around it. */
function shareOut(
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
  row: boolean,
  line: FlexLine,
  hold: Hold,
): void {
  const sizes = shareLine(items, row, line);
  freezeLine(items, row, sizes, hold);
}

/** Each item's size along the main axis as 9.7 shares the line out from
 *  their flex base sizes (`Laid.base`); one held at its automatic minimum
 *  is frozen there. */
function shareLine(
  items: readonly { box: Box; laid: Laid }[],
  row: boolean,
  line: FlexLine,
): number[] {
  const flexing: Flexing[] = items.map(({ box, laid }) => {
    // an automatic minimum it is held to is its minimum, which 9.7 freezes
    // it at where the line shares out less to it — and not before, which
    // would leave it out of the free space the line started with (4b)
    let least = leastOf(box, laid, row);
    if (!Number.isNaN(laid.minimum)) least = Math.max(least, laid.minimum);
    return {
      base: laid.base,
      least,
      most: Math.max(mostOf(box, laid, row), least),
      extra: row ? box.horizontalExtra : box.verticalExtra,
      grow: box.style.flexGrow,
      shrink: box.style.flexShrink,
      frozen: Number.isNaN(laid.base) ? laid.held : NaN,
    };
  });
  let room = line.size;
  if (Number.isNaN(room)) {
    // down a column that is as tall as its items, within its limits: the
    // sum of their hypothetical sizes (9.9.1)
    room = line.between;
    for (const item of flexing) room += hypotheticalOf(item);
    room = Math.max(line.floor, Math.min(line.ceiling, room));
  }
  return resolveLengths(flexing, room - line.between);
}

/**
 * Whether Yoga's answer for the one line of a box that does not wrap may
 * not be what CSS Flexbox 9.7 makes of it (`resolveLine`): where an item
 * has a limit of its own along the main axis, which 9.7 is then asked —
 * sums of numbers, where each item's flex base size is known — and where
 * none has, what shows in Yoga's answer: an item a limit stopped as the
 * line was shared out, which with none of its own is its padding and
 * borders, a line not shared out while an item may yet flex the way it is
 * out, or flex factors that come to less than 1, which Yoga shares out as
 * though they came to 1 — or, for one item that may grow and shrink, from
 * a flex basis of nothing.
 */
function unshared(
  items: readonly { box: Box; laid: Laid }[],
  row: boolean,
  /** The room for the items' border boxes. */
  room: number,
  /** Whether the line is a min-content probe's (`FlexLine.probe`). */
  probe: boolean,
): boolean {
  let sum = 0;
  for (const { laid } of items) sum += laid.main;
  const over = sum > room + NEAR;
  const under = sum < room - NEAR;
  let grows = 0;
  let shrinks = 0;
  let growable = false;
  for (const { box, laid } of items) {
    // held at its content's size, and frozen (`holdAt`)
    if (!Number.isNaN(laid.held)) continue;
    if (!Number.isNaN(laid.least) || !Number.isNaN(laid.most)) return true;
    const { flexGrow: grow, flexShrink: shrink } = box.style;
    const least = leastOf(box, laid, row);
    const base = baseOf(box, laid, row, probe);
    const size = laid.main;
    grows += grow;
    shrinks += shrink;
    // stopped by its padding where it was shrunk to it, and not where it
    // is that size unflexed
    if (
      shrink > 0 &&
      !under &&
      size <= least + NEAR &&
      !(base <= size + NEAR)
    ) {
      return true;
    }
    if (over && shrink > 0 && size > least + NEAR) return true;
    if (under && grow > 0) growable = true;
  }
  return (
    (growable && grows >= 1) ||
    (!under && shrinks > 0 && shrinks < 1) ||
    (!over && grows > 0 && grows < 1) ||
    (!under && weighsPadding(items, row, room, probe))
  );
}

/**
 * Whether Yoga may have shared out what a line is short of by its items'
 * padding and borders, where 9.7 leaves them out: Yoga weighs an item's
 * share by its flex shrink factor times its flex base size, its border
 * box's, and 9.7 by the factor times its inner flex base size, its content
 * box's (step 4c). The two are the same shares where padding and borders
 * are the same part of the flex base size of every item that shrinks —
 * none of it, most often — and else Yoga takes more from an item the more
 * of them it has: `width: 100px; padding-left: 50px` beside `width: 100px`
 * in a row of 150 was 90 and 60 wide, where each gives up 50 of its
 * content and is 100 and 50. Where an item's flex base size is not known,
 * its padding may be any part of it, and the line is looked at.
 */
function weighsPadding(
  items: readonly { box: Box; laid: Laid }[],
  row: boolean,
  /** The room for the items' border boxes. */
  room: number,
  probe: boolean,
): boolean {
  let sum = 0;
  let shrinking = 0;
  let padded = false;
  let unknown = false;
  // the part of the first flex base size that shrinks that is padding and
  // borders, and whether that of another is not the same
  let part = NaN;
  let uneven = false;
  for (const { box, laid } of items) {
    if (!Number.isNaN(laid.held)) {
      sum += laid.held;
      continue;
    }
    const base = baseOf(box, laid, row, probe);
    if (Number.isNaN(base)) unknown = true;
    else sum += base;
    if (!(box.style.flexShrink > 0)) continue;
    shrinking += 1;
    const extra = row ? box.horizontalExtra : box.verticalExtra;
    if (extra > 0) padded = true;
    if (Number.isNaN(base)) continue;
    const of = base > 0 ? extra / base : 0;
    if (Number.isNaN(part)) part = of;
    else if (Math.abs(of - part) > 1e-9) uneven = true;
  }
  if (shrinking < 2 || !padded) return false;
  return unknown || (uneven && sum > room + NEAR);
}

/** How near two sizes along the main axis are the same, as Yoga's float32s
 *  have them. */
const NEAR = 0.01;

/** An item's flex base size, its border box's, where this engine knows it:
 *  what its style says, or its content's size as last measured — fitted
 *  to no room, in a min-content probe (`FlexLine.probe`) — and no less than
 *  its padding and borders, as Yoga has it. Else NaN. */
function baseOf(box: Box, laid: Laid, row: boolean, probe: boolean): number {
  const extra = row ? box.horizontalExtra : box.verticalExtra;
  const content = probe ? laid.fitted : laid.content;
  return Math.max(laid.sized ? content : laid.basis, extra);
}

/**
 * Give each item that is not frozen the flex base size Yoga makes of it,
 * where this engine does not know it (`baseOf`): the line laid out with no
 * limit on any of them along the main axis and none of them flexing, where
 * each is that size. Their limits and flex factors are put back after.
 */
function askBases(
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
  row: boolean,
  ask: () => void,
): void {
  const open = items.filter(({ laid }) => Number.isNaN(laid.held));
  for (const { node } of open) {
    if (row) {
      node.setMinWidth(Number.NaN);
      node.setMaxWidth(Number.NaN);
    } else {
      node.setMinHeight(Number.NaN);
      node.setMaxHeight(Number.NaN);
    }
    node.setFlexGrow(0);
    node.setFlexShrink(0);
  }
  ask();
  for (const { box, node, laid } of open) {
    if (Number.isNaN(laid.base)) {
      laid.base = row ? node.getComputedWidth() : node.getComputedHeight();
    }
    if (!Number.isNaN(laid.least)) {
      if (row) node.setMinWidth(laid.least);
      else node.setMinHeight(laid.least);
    }
    if (!Number.isNaN(laid.most)) {
      if (row) node.setMaxWidth(laid.most);
      else node.setMaxHeight(laid.most);
    }
    node.setFlexGrow(box.style.flexGrow);
    node.setFlexShrink(box.style.flexShrink);
  }
}

/** An item as its line is shared out (`resolveLengths`), each size its
 *  border box's along the main axis. */
interface Flexing {
  base: number;
  /** Its least size, no less than `extra`, and its most, no less than
   *  that. */
  least: number;
  most: number;
  /** Its padding and borders. */
  extra: number;
  grow: number;
  shrink: number;
  /** The size it is frozen at from the start, or NaN. */
  frozen: number;
}

/** An item's hypothetical main size: its flex base size within its limits
 *  (CSS Flexbox 9.2, step 3), or where it is frozen, that size. */
function hypotheticalOf(item: Flexing): number {
  return Number.isNaN(item.frozen)
    ? Math.max(item.least, Math.min(item.most, item.base))
    : item.frozen;
}

/**
 * Resolve the flexible lengths of a line (CSS Flexbox 9.7): each item's
 * size along the main axis, sharing out the room its border boxes have
 * from their flex base sizes, and going round again with each item a limit
 * stops frozen at it until none is — the minimums where the line is short
 * of more than the maximums give back, and the other way round.
 */
function resolveLengths(line: readonly Flexing[], room: number): number[] {
  const count = line.length;
  const size = line.map(hypotheticalOf);
  let sum = 0;
  for (const s of size) sum += s;
  // step 1: grow where the line has room at the items' hypothetical sizes
  const grow = sum < room;
  // step 2: an item that does not flex, or would flex away from its limit,
  // is frozen at its hypothetical size — a flex base size Yoga worked out
  // being as near to that as its float32s come, and no further
  const frozen = line.map(
    (item, i) =>
      !Number.isNaN(item.frozen) ||
      (grow ? item.grow : item.shrink) === 0 ||
      (grow ? item.base > size[i] + NEAR : item.base < size[i] - NEAR),
  );
  const free = (): number => {
    let left = room;
    for (let i = 0; i < count; i++) left -= frozen[i] ? size[i] : line[i].base;
    return left;
  };
  // step 3
  const initial = free();
  const off = new Array<number>(count).fill(0);
  for (;;) {
    // step 4a
    let factors = 0;
    let open = false;
    for (let i = 0; i < count; i++) {
      if (frozen[i]) continue;
      open = true;
      factors += grow ? line[i].grow : line[i].shrink;
    }
    if (!open) break;
    // 4b: flex factors that come to less than 1 share out that part of the
    // free space the line started with
    let left = free();
    if (factors < 1) {
      const part = initial * factors;
      if (Math.abs(part) < Math.abs(left)) left = part;
    }
    // 4c: shared by the grow factors, or by the shrink factors each times
    // the item's inner flex base size
    let scaled = 0;
    if (!grow) {
      for (let i = 0; i < count; i++) {
        if (!frozen[i])
          scaled += line[i].shrink * (line[i].base - line[i].extra);
      }
    }
    // 4d: each within its limits, and how far that took it
    let violation = 0;
    for (let i = 0; i < count; i++) {
      if (frozen[i]) continue;
      const item = line[i];
      let target = item.base;
      if (grow) target += (left * item.grow) / factors;
      else if (scaled > 0) {
        target -=
          (Math.abs(left) * item.shrink * (item.base - item.extra)) / scaled;
      }
      size[i] = Math.max(item.least, Math.min(item.most, target));
      off[i] = size[i] - target;
      violation += off[i];
    }
    // 4e: freeze those stopped the way most of them were, or all of them
    for (let i = 0; i < count; i++) {
      if (frozen[i]) continue;
      if (violation === 0 || (violation > 0 ? off[i] > 0 : off[i] < 0)) {
        frozen[i] = true;
      }
    }
  }
  return size;
}

/** The least an item may be along the main axis, its border box: the
 *  minimum of its own, and no less than its padding and borders. */
function leastOf(box: Box, laid: Laid, row: boolean): number {
  const extra = row ? box.horizontalExtra : box.verticalExtra;
  return Number.isNaN(laid.least) ? extra : Math.max(laid.least, extra);
}

/**
 * Put right the lines of a flex box that wraps on which every item that
 * may grow is stopped by its maximum and Yoga made them smaller for it;
 * whether Yoga was asked again. The one line of a box that does not wrap
 * is shared out by 9.7 here where Yoga's answer may not be its
 * (`resolveLine`), which puts right this and more. Each such line is laid out with every item of it that
 * may grow frozen at its maximum, which is where CSS Flexbox leaves them
 * (9.7, step 4): the line has room left over with every one of them as
 * large as it goes. It is also where Yoga leaves them itself, where its
 * rounding is not below 0.
 *
 * It is a float's rounding of nothing. Yoga's first pass takes
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
 * What makes a line one to put right is Yoga's answer. Every item of
 * the line that may grow has a
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
  const hypothetical = items.map(({ node, laid }) =>
    row ? node.getComputedWidth() : heightOf(node, laid),
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
    if (byBaseline(style, box.style)) line.push(item);
  }
  close();
  // one alone on its line is at its start already
  return several ? out : null;
}

/** Whether an item takes part in aligning its line by baselines (CSS
 *  Flexbox 8.3, 9.4 step 8): aligned by its baseline, with no `auto`
 *  margin across the line, which takes it over its alignment. */
function byBaseline(container: ComputedStyle, item: ComputedStyle): boolean {
  const aligned =
    item.alignSelf === AUTO ? container.alignItems : item.alignSelf;
  return (
    aligned === 'baseline' &&
    item.marginTop !== AUTO &&
    item.marginBottom !== AUTO
  );
}

/**
 * Whether Yoga made a line of a row that wraps the row's height, where its
 * items make it another (CSS Flexbox 9.4, steps 7 and 8; `layoutFlex`).
 * Where `align-content` stretches the lines, that is an item stretched
 * across one that is shorter than its content at the width it was given:
 * its line is as tall as that, past the box. Where it centres them or ends
 * them, it is the one line of the row not as tall as the row, which moves
 * it from the row's start — and so where it spaces them out around or
 * evenly, which centres one line (CSS Box Alignment 3, 5.1). Lines it
 * starts at the row's start are there in Yoga's layout as well, and so is
 * the one line `space-between` starts there.
 */
function heldLine(
  container: Box,
  ctx: LayoutContext,
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
  /** The row's content height. */
  height: number,
  /** The row's content width, the items' containing block's. */
  width: number,
  /** The gap between two items along the row. */
  gap: number,
): boolean {
  const style = container.style;
  const lines = crossContent(style);
  if (
    lines !== 'stretch' &&
    lines !== 'center' &&
    lines !== 'flex-end' &&
    lines !== 'space-around' &&
    lines !== 'space-evenly'
  ) {
    return false;
  }
  const stretched = items.filter(({ box }) => stretches(box, style));
  if (stretched.length === 0) return false;
  if (lines === 'stretch') {
    return stretched.some(
      ({ box, node, laid }) =>
        naturalAcross(box, ctx, laid, width) > heightOf(node, laid) + 0.01,
    );
  }
  // one line, which the items come to no more than the row's width along:
  // Yoga made a line each of them only where they come to more
  let along = gap * (items.length - 1);
  for (const { box, laid } of items) along += laid.main + marginsOf(box, true);
  if (along > width + 0.01) return false;
  // as tall as its tallest item, as Yoga has them: it lays them out at
  // their content's height where `align-content` does not stretch lines
  let line = 0;
  for (const { box, node, laid } of items) {
    line = Math.max(line, heightOf(node, laid) + marginsOf(box, false));
  }
  return Math.abs(line - height) > 0.01;
}

/**
 * A row item's border-box height as its content makes it at the width the
 * flex layout gave it, within its limits: the layout `placeItems` gives it
 * there, made now where it has none (`layoutItemAt`), and a replaced one's
 * through its ratio or its natural height.
 */
function naturalAcross(
  box: Box,
  ctx: LayoutContext,
  laid: Laid,
  /** The flex box's content width, the item's containing block's. */
  containing: number,
): number {
  const width = meant(laid.main, laid.set, laid.stretch, laid.width, laid.held);
  if (box.kind === 'replaced') {
    const own = box.intrinsic;
    const natural =
      heightThroughRatio(box, width) ??
      (own && !(own.missing & 2) ? own.height + box.verticalExtra : null);
    return natural === null ? 0 : clampHeight(box, natural);
  }
  if (box.kind === 'text' || box.kind === 'break') return 0;
  const kept = naturalHeight(box, ctx, width, containing, laid);
  if (!Number.isNaN(kept)) return kept;
  layoutNaturally(box, ctx, width, containing, laid);
  return box.height;
}

/**
 * The alignment an item with an `auto` margin across a row that wraps comes
 * to in its line (CSS Flexbox 8.1, 9.6 step 13), as Yoga is told it
 * (`layoutFlex`): at the end where the margin at the line's cross start is
 * `auto`, at the start where the one at its end is, and centred where both
 * are; null where neither is. Its line's cross start is the box's bottom
 * where its lines wrap in reverse.
 *
 * The line is as tall as its tallest item, margins and all, so the item
 * comes to no more than it, and the margins take a share of no less than
 * nothing: the alignment puts it where they would.
 */
function autoAcross(
  item: ComputedStyle,
  reverse: boolean,
): 'flex-start' | 'flex-end' | 'center' | null {
  const top = item.marginTop === AUTO;
  const bottom = item.marginBottom === AUTO;
  if (top && bottom) return 'center';
  if (!top && !bottom) return null;
  return top !== reverse ? 'flex-end' : 'flex-start';
}

/**
 * How far an item is from where it belongs across its line, where Yoga
 * (3.2.1) aligned the lines in the pass it takes for a box that wraps or
 * aligns by baselines: it sets an item aligned to its line's start there
 * as though it had no margin at that side, and one centred as though it had
 * none at either — `items-start` in a wrapping row put every card's top
 * margin under it. By the margin at the start of the line's cross axis, and
 * by half what it exceeds the one at the end by, as Yoga holds them: for an
 * item set at its line's start (`started`), its baseline's.
 *
 * A row whose lines wrap in reverse Yoga lays out as though they wrapped
 * forward, and then turns each item over across the box, its margins with
 * it: each is where the other margin would have put it. One at its line's
 * start, the bottom, stands on nothing; one at its end, the top, or
 * stretched, is its bottom margin down from its line's top where it is its
 * top one; and one centred, half the difference. A column's, whose cross
 * axis runs right to left, or that wraps in reverse, is left as Yoga has
 * it, and so is an item an `auto` margin aligns in a row that does not
 * wrap: where Yoga still takes that pass for such a row, its items are
 * laid out again without it, aligned by their baselines (`layoutFlex`).
 */
function lineMarginFix(
  container: ComputedStyle,
  item: Box,
  node: YogaNode,
  row: boolean,
  /** Whether the flex box has a definite height. */
  own: boolean,
  started = false,
): number {
  const reverse = container.flexWrap === 'wrap-reverse';
  if (!row && (reverse || container.direction === 'rtl')) return 0;
  const style = item.style;
  // a margin that is `auto` takes the item over its alignment, which Yoga
  // is told it comes to in a row that wraps (`autoAcross`)
  const lead = row ? style.marginTop : style.marginLeft;
  const trail = row ? style.marginBottom : style.marginRight;
  let align: string | null;
  if (started) align = 'flex-start';
  else if (lead === AUTO || trail === AUTO) {
    align =
      row && container.flexWrap !== 'nowrap'
        ? autoAcross(style, reverse)
        : null;
  } else {
    align = style.alignSelf === AUTO ? container.alignItems : style.alignSelf;
    // which sets one whose height is a percentage of none at its line's
    // start, as Yoga is told it does (`applyItem`)
    if (align === 'stretch' && row && heightOfNone(style, own)) {
      align = 'flex-start';
    }
  }
  const leading = node.getComputedMargin(row ? Y.EDGE_TOP : Y.EDGE_LEFT);
  const trailing = node.getComputedMargin(row ? Y.EDGE_BOTTOM : Y.EDGE_RIGHT);
  switch (align) {
    case 'flex-start':
      return reverse ? -trailing : leading;
    case 'center':
      return (leading - trailing) / 2;
    case 'flex-end':
    case 'stretch':
      return reverse ? leading - trailing : 0;
  }
  return 0;
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

/**
 * The items of a column that wraps that Yoga (3.2.1) lays out at another
 * height than it sized them at, as it stretches them across their lines:
 * each it aligns `stretch`, with no width of its own, whose left and right
 * margins come to another sum than its top and bottom ones.
 *
 * Yoga aligns the lines of a box that wraps in a pass of its own, after it
 * has sized and placed every item down them, and lays each item it
 * stretches out again there at its line's width — and at its height plus
 * the margins across the line, where it means the ones down it
 * (CalculateLayout.cpp's multi-line `Align::Stretch`, still so on Yoga's
 * main). A leaf laid out at a width and a height is that size, so the item
 * came out its side margins taller and its top and bottom ones shorter
 * than the height its line was shared out to, which its place and the
 * next item's had been worked out from. The pass lays an item out again
 * wherever its side margins are not nothing, or its line is another width
 * than the one it was measured at, so `margin: 0 5px` on a line of words
 * was 28 tall where Chrome's is 18, and `margin: 4px 0 2px` in a column
 * with two lines 6 short; where the two sums are the same, the pass gives
 * the height back unchanged.
 */
function stretchedDown(
  root: YogaNode,
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
): { box: Box; node: YogaNode; laid: Laid }[] {
  const lines = root.getAlignItems();
  return items.filter(({ box, node }) => {
    const own = node.getAlignSelf();
    if ((own === Y.ALIGN_AUTO ? lines : own) !== Y.ALIGN_STRETCH) return false;
    const width = node.getWidth().unit;
    if (width !== Y.UNIT_AUTO && width !== Y.UNIT_UNDEFINED) return false;
    // as Yoga adds them up, an `auto` margin as nothing
    const style = box.style;
    const of = (len: unknown, px: number) => (len === AUTO ? 0 : px);
    const across =
      of(style.marginLeft, box.marginLeft) +
      of(style.marginRight, box.marginRight);
    const down =
      of(style.marginTop, box.marginTop) +
      of(style.marginBottom, box.marginBottom);
    return Math.abs(across - down) >= 0.0001;
  });
}

/**
 * Lay a column that wraps out, keeping for each item Yoga stretches across
 * its line the height it sized it at (`stretchedDown`, `Laid.unstretched`).
 *
 * Yoga is asked again with each such item set at its line's start, which
 * its multi-line pass does not lay out again: each is as tall as its line
 * made it. Its flex base size has to come out the same for that, so its
 * lines break and share out the same — and where Yoga hands the column's
 * width over as a size, it measures an item it stretches at that width, and
 * one it does not at its content's, so there the item is handed the width
 * as its own too. Then Yoga is asked once more as it was, so the lines and
 * the widths are its own, and only the heights are taken from the second
 * layout. Where an item's place down its line moved between the two, a
 * base moved too, and Yoga's height is kept, as it was.
 */
function unstretch(
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
  stretched: readonly { box: Box; node: YogaNode; laid: Laid }[],
  /** The column's content width, where Yoga is handed it as a size, and
   *  else null. */
  width: number | null,
  layout: () => void,
): void {
  layout();
  const tops = items.map(({ node }) => node.getComputedTop());
  const aligned = stretched.map(({ box, node }) => {
    const own = node.getAlignSelf();
    node.setAlignSelf(Y.ALIGN_FLEX_START);
    if (width !== null) node.setWidth(measuredAcross(box, node, width));
    return own;
  });
  layout();
  const kept = items.every(
    ({ node }, i) => Math.abs(node.getComputedTop() - tops[i]) < 0.01,
  );
  const heights = stretched.map(({ node }) => node.getComputedHeight());
  stretched.forEach(({ node }, i) => {
    node.setAlignSelf(aligned[i]);
    if (width !== null) node.setWidthAuto();
  });
  layout();
  stretched.forEach(({ laid }, i) => {
    laid.unstretched = kept ? heights[i] : NaN;
  });
}

/** The border-box width Yoga measures a column's item at for its flex base
 *  size where it stretches it across a column of a width: the column's,
 *  less its margins across, within its maximum. */
function measuredAcross(box: Box, node: YogaNode, width: number): number {
  const style = box.style;
  const of = (len: unknown, px: number) => (len === AUTO ? 0 : px);
  const across =
    of(style.marginLeft, box.marginLeft) +
    of(style.marginRight, box.marginRight);
  const most = node.getMaxWidth();
  const limit =
    most.unit === Y.UNIT_POINT
      ? most.value
      : most.unit === Y.UNIT_PERCENT
        ? (most.value / 100) * width
        : Infinity;
  return Math.min(width - across, limit);
}

/** An item's border-box height, as Yoga sized it: the one it had before its
 *  line stretched it, where that laid it out at another (`unstretch`,
 *  `unspace`). */
function heightOf(node: YogaNode, laid: Laid): number {
  return Number.isNaN(laid.unstretched)
    ? node.getComputedHeight()
    : laid.unstretched;
}

/** Whether `align-content` spaces a flex box's lines out, putting what
 *  room it has past them between them and around them. */
function spacesLines(style: ComputedStyle): boolean {
  const lines = crossContent(style);
  return (
    lines === 'space-between' ||
    lines === 'space-around' ||
    lines === 'space-evenly'
  );
}

/**
 * Lay a row that wraps out, its lines spaced out by `align-content`,
 * keeping each item Yoga stretches across its line as tall as the line
 * (`Laid.unstretched`; CSS Flexbox 9.4, step 11).
 *
 * Yoga (3.2.1) sets the lines of a box that wraps in a pass of its own,
 * after it has sized them, and lays each item it stretches out again there
 * as tall as its line and the room it puts after the line as well
 * (CalculateLayout.cpp's multi-line `Align::Stretch`, still so on Yoga's
 * main). Each line was where it belongs, and every item on it that is not
 * stretched, but a stretched item ran down to the next line: two lines of
 * 18px items in a row 100 tall came to 82 apiece with `space-between`. So
 * Yoga is asked with the lines set at the row's start, where it puts no
 * room between them and each item is as tall as its line. Where the lines
 * leave the row no room (`linesReach`), that is the layout the spacing
 * makes too, and is kept. Where they do, Yoga is asked again as the row
 * is, for where the lines and the items are, and the heights are kept from
 * the first layout.
 */
function unspace(
  root: YogaNode,
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
  /** Whether the lines run bottom to top. */
  reverse: boolean,
  layout: () => void,
): void {
  for (const { laid } of items) laid.unstretched = NaN;
  // each item Yoga stretches: `stretch`, with no height of its own
  const align = root.getAlignItems();
  const stretched = items.filter(({ node }) => {
    const own = node.getAlignSelf();
    if ((own === Y.ALIGN_AUTO ? align : own) !== Y.ALIGN_STRETCH) return false;
    const height = node.getHeight().unit;
    return height === Y.UNIT_AUTO || height === Y.UNIT_UNDEFINED;
  });
  if (stretched.length === 0) {
    layout();
    return;
  }
  const lines = root.getAlignContent();
  root.setAlignContent(Y.ALIGN_FLEX_START);
  layout();
  root.setAlignContent(lines);
  if (!(root.getComputedHeight() - linesReach(root, items, reverse) > NEAR)) {
    return;
  }
  const heights = stretched.map(({ node }) => node.getComputedHeight());
  layout();
  stretched.forEach(({ node, laid }, i) => {
    if (Math.abs(node.getComputedHeight() - heights[i]) >= NEAR) {
      laid.unstretched = heights[i];
    }
  });
}

/**
 * How far down a row that wraps its lines reach, at the least, in the
 * layout Yoga made of it with the lines at its start (`unspace`): the most,
 * over its items, of where the item's line ends at the least. An item is as
 * tall as its line with its margins where it is stretched across it, and
 * no taller where it is not, and Yoga ends it at its line's end, or with
 * its margins at the line's start, or centres it with neither
 * (`lineMarginFix`). Read with the lines turned back the right way up where
 * they run bottom to top.
 */
function linesReach(
  root: YogaNode,
  items: readonly { box: Box; node: YogaNode }[],
  reverse: boolean,
): number {
  const height = root.getComputedHeight();
  const lines = root.getAlignItems();
  let reach = 0;
  for (const { box, node } of items) {
    const tall = node.getComputedHeight();
    const top = reverse
      ? height - node.getComputedTop() - tall
      : node.getComputedTop();
    const style = box.style;
    const above = style.marginTop === AUTO ? 0 : box.marginTop;
    const below = style.marginBottom === AUTO ? 0 : box.marginBottom;
    const own = node.getAlignSelf();
    const align = own === Y.ALIGN_AUTO ? lines : own;
    // where Yoga set it at its line's start with no margin above it, the
    // line runs on past it by both its margins at the least, and where it
    // centred it, by half of them
    const lead =
      align === Y.ALIGN_FLEX_START
        ? above
        : align === Y.ALIGN_CENTER
          ? (above - below) / 2
          : 0;
    reach = Math.max(reach, top + tall + below + lead);
  }
  return reach;
}

/**
 * Whether a row item's height is a percentage of a height its flex box has
 * none of. That is `auto` to the item's size (CSS 2.1 10.5), and is not
 * handed to Yoga (`applyItem`), but it is not `auto` to its alignment:
 * `stretch` stretches an item whose height computes to `auto` (CSS Flexbox
 * 8.3), and this one's computes to the percentage. Such an item is as tall
 * as its content, set at its line's start, which is what Yoga is told.
 */
function heightOfNone(
  style: ComputedStyle,
  /** Whether the flex box has a definite height. */
  own: boolean,
): boolean {
  return !own && isPct(style.height);
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

/** Whether a flex box laid out at a width is a column that wraps, whose
 *  lines are as wide as their items and not as the box, and are placed
 *  across it here (`crossLines`). */
function wrapsColumn(style: ComputedStyle, width: number): boolean {
  return (
    Number.isFinite(width) &&
    !style.flexDirection.startsWith('row') &&
    style.flexWrap !== 'nowrap'
  );
}

/** Where an item is across a column that wraps (`crossLines`): its border
 *  box's left edge from the flex box's content box's, and its width. */
interface Across {
  x: number;
  width: number;
}

/**
 * Place a column that wraps across: its lines across the box, and each
 * item across its line (CSS Flexbox 9.4, steps 8 to 11, and 9.6, steps 13
 * to 16). From the layout Yoga made of it with every item at its line's
 * start (`layoutFlex`), in which each item is as wide as it is before it is
 * stretched, `fit-content` or its own width within its limits, and each
 * line starts its gap and a pixel past the one before, which is how the
 * items of one line are told from the next one's.
 *
 * A line is as wide as its widest item, margins and all. `align-content`
 * (its `start` and `end` the box's own sides, `crossContent`) shares out
 * what the box has past its lines: `stretch` to each line alike,
 * where they are short of the box; `center` and `flex-end` whether they are
 * or not, so that lines wider than the box run past both its sides, or its
 * start; and the spacing values only where there is room, setting the lines
 * at the box's start where there is none (CSS Box Alignment 3, 4.3:
 * `space-between` falls back to `flex-start`, `space-around` and
 * `space-evenly` to `safe center`, the start where the lines overflow). An
 * item with an `auto` margin across its line takes the room the line has
 * past it on that side (8.1), and none where there is none; a stretched
 * item is as wide as its line less its margins, within its limits (9.4,
 * step 11), and as tall as the column made it; and the rest are where
 * `align-self` says, a baseline at the line's start, as a column has none
 * across it to align by.
 */
function crossLines(
  style: ComputedStyle,
  items: readonly { box: Box; node: YogaNode; laid: Laid }[],
  /** The flex box's content width. */
  width: number,
  /** The gap between two lines. */
  gap: number,
): Map<Box, Across> {
  // the lines start at the right where the box runs right to left, or
  // where they wrap in reverse, and at the left where both are so
  const fromRight =
    (style.direction === 'rtl') !== (style.flexWrap === 'wrap-reverse');
  const lines: number[][] = [];
  const sizes: number[] = [];
  // each item's margins across, from its line's start, an `auto` one none
  const lead: number[] = [];
  const trail: number[] = [];
  let last = NaN;
  items.forEach(({ box, node, laid }, i) => {
    const yoga = node.getComputedWidth();
    const left = node.getComputedLeft();
    const start = fromRight ? width - left - yoga : left;
    if (!(Math.abs(start - last) < 0.5)) lines.push([]);
    last = start;
    lines[lines.length - 1].push(i);
    sizes.push(meant(yoga, laid.set, laid.stretch, laid.width));
    const own = box.style;
    const l = own.marginLeft === AUTO ? 0 : box.marginLeft;
    const r = own.marginRight === AUTO ? 0 : box.marginRight;
    lead.push(fromRight ? r : l);
    trail.push(fromRight ? l : r);
  });
  const across = lines.map((line) =>
    line.reduce((most, i) => Math.max(most, sizes[i] + lead[i] + trail[i]), 0),
  );
  const count = lines.length;
  let room = width - gap * (count - 1);
  for (const size of across) room -= size;
  let at = 0;
  let between = gap;
  switch (crossContent(style)) {
    case 'flex-end':
      at = room;
      break;
    case 'center':
      at = room / 2;
      break;
    case 'stretch':
      if (room > 0) across.forEach((_, k) => (across[k] += room / count));
      break;
    case 'space-between':
      if (room > 0 && count > 1) between += room / (count - 1);
      break;
    case 'space-around':
      if (room > 0) {
        at = room / count / 2;
        between += room / count;
      }
      break;
    case 'space-evenly':
      if (room > 0) {
        at = room / (count + 1);
        between += room / (count + 1);
      }
      break;
  }
  const placed = new Map<Box, Across>();
  lines.forEach((line, k) => {
    const size = across[k];
    for (const i of line) {
      const { box, node } = items[i];
      const own = box.style;
      let itemWidth = sizes[i];
      let offset = lead[i];
      const free = size - itemWidth - lead[i] - trail[i];
      const before = fromRight ? own.marginRight : own.marginLeft;
      const after = fromRight ? own.marginLeft : own.marginRight;
      if (before === AUTO || after === AUTO) {
        if (free > 0 && before === AUTO) {
          offset += after === AUTO ? free / 2 : free;
        }
      } else if (stretches(box, style, false) && !own.widthKeyword) {
        const most = pointsOf(node.getMaxWidth());
        const least = pointsOf(node.getMinWidth());
        itemWidth = size - lead[i] - trail[i];
        if (itemWidth > most) itemWidth = most;
        if (itemWidth < least) itemWidth = least;
        itemWidth = Math.max(itemWidth, box.horizontalExtra);
      } else {
        const align = own.alignSelf === AUTO ? style.alignItems : own.alignSelf;
        if (align === 'center') offset += free / 2;
        else if (align === 'flex-end') offset += free;
      }
      const start = at + offset;
      placed.set(box, {
        x: fromRight ? width - start - itemWidth : start,
        width: itemWidth,
      });
    }
    at += size + between;
  });
  return placed;
}

/** A length Yoga holds in points, or NaN where it holds none. */
function pointsOf(value: { unit: number; value: number }): number {
  return value.unit === Y.UNIT_POINT ? value.value : NaN;
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

/**
 * An `align-content` as the cross axis takes it (CSS Box Alignment 3,
 * 5.1): `start` and `end` are the box's own edges, which are its lines'
 * cross ends turned round where the box wraps in reverse — `end` in a row
 * `wrap-reverse` is the bottom, where its lines start.
 */
function crossContent(style: ComputedStyle): string {
  const lines = style.alignContent;
  if (lines !== 'start' && lines !== 'end') return lines;
  return (lines === 'start') === (style.flexWrap !== 'wrap-reverse')
    ? 'flex-start'
    : 'flex-end';
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
  'space-evenly': Y?.ALIGN_SPACE_EVENLY,
};
