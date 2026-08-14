// Block layout: the driver, and the formatting context everything else hangs
// off.
//
// Boxes are laid out into **absolute document coordinates** in one pass. The
// alternative — relative offsets resolved by a second walk — buys incremental
// relayout of a subtree, and it is not worth it here: paint, hit testing and
// the selection accessors all want absolute rectangles, and every one of them
// runs far more often than layout does. So layout writes what they read.
//
// Float coordinates are absolute for the same reason, which is what lets the
// inline pass ask "how wide is the line at this y" without knowing whose
// formatting context it is inside.
import { AUTO, isPct, resolve, resolveOrNull } from '../css/values.js';
import type { Len } from '../css/values.js';
import { Box } from './boxes.js';
import type { BoxTree, LineBox } from './boxes.js';
import { FloatContext } from './floats.js';
import { layoutInline } from './inline.js';
import type { FontsLike } from './inline.js';
import { layoutFlex } from './flex.js';
import { layoutTable } from './table.js';
import { computePaintBounds } from '../paint.js';

export interface LayoutContext {
  fonts: FontsLike | null;
  viewportWidth: number;
  viewportHeight: number;
  /** Out-of-flow boxes, collected in flow order and laid out afterwards —
   *  an absolutely positioned box may be positioned against an ancestor
   *  whose size is not known until its in-flow content has been laid out. */
  positioned: { box: Box; containing: Box }[];
  /**
   * Lay a box and everything under it out at a width, at the origin.
   *
   * The recursion back into this file that `flex.ts` and `table.ts` need — a
   * flex item contains blocks, a table cell contains anything at all — passed
   * on the context rather than imported, because the cycle is genuine and the
   * alternative is a module that registers itself at import time. This
   * package's tree-shaking contract forbids exactly that (AGENTS.md, "no side
   * effects at import time anywhere else"), and a field is cheaper than the
   * exception would be.
   */
  layoutSubtree(box: Box, width: number): void;
}

export interface LayoutResult {
  width: number;
  height: number;
}

/** Lay the whole document out at a width. */
export function layoutDocument(
  tree: BoxTree,
  fonts: FontsLike | null,
  viewportWidth: number,
  viewportHeight: number,
): LayoutResult {
  const ctx: LayoutContext = {
    fonts,
    viewportWidth,
    viewportHeight,
    positioned: [],
    layoutSubtree: (box, width) => layoutSubtree(box, ctx, width),
  };
  const root = tree.root;
  root.x = 0;
  root.y = 0;
  root.width = viewportWidth;
  // The root box stands in for `<body>` when the document has none (see
  // `Cascade.rootStyle`), so it may carry a margin — and a margin on the
  // initial containing block has nothing to collapse against and nothing to
  // sit inside. Folding it into the padding is what a browser's body margin
  // amounts to, and it keeps `contentX` the one thing layout reads.
  resolveEdges(root, viewportWidth);
  root.padTop += root.marginTop;
  root.padRight += root.marginRight;
  root.padBottom += root.marginBottom;
  root.padLeft += root.marginLeft;
  root.marginTop = 0;
  root.marginRight = 0;
  root.marginBottom = 0;
  root.marginLeft = 0;

  const contentWidth = Math.max(0, viewportWidth - root.horizontalExtra);
  const floats = new FloatContext(root.contentX, root.contentX + contentWidth);
  const flow = layoutChildren(root, ctx, floats, root.contentY, contentWidth);
  const floatBottom =
    floats.bottom === -Infinity ? 0 : floats.bottom - root.contentY;
  root.height = Math.max(flow.height, floatBottom) + root.verticalExtra;

  // Positioned boxes last, and in the order they were found, so a later one
  // can be positioned against an earlier one's resolved rectangle.
  for (let i = 0; i < ctx.positioned.length; i += 1) {
    const { box, containing } = ctx.positioned[i];
    layoutPositioned(box, containing, ctx);
  }

  // `position: relative` moves a box after everything else has been placed
  // against where it *was* — which is the whole of what makes it relative —
  // and the ink bounds are computed after that, so culling sees where boxes
  // ended up rather than where they were laid out.
  applyRelativeOffsets(root);
  computePaintBounds(root);

  let bottom = root.height;
  for (const { box } of ctx.positioned) {
    if (box.style.position !== 'fixed')
      bottom = Math.max(bottom, box.y + box.height);
  }
  return { width: viewportWidth, height: bottom };
}

/**
 * The collapsed value of two adjoining margins: the largest positive plus
 * the most negative — CSS 8.3.1's rule, whole. Both-positive takes the max,
 * both-negative the min, and a mixed pair genuinely adds, which is what
 * makes a `-8px` pull work against a `40px` push and come out at `32`.
 */
function collapseMargins(a: number, b: number): number {
  return Math.max(0, Math.max(a, b)) + Math.min(0, Math.min(a, b));
}

/** What a box's children came to: their height, and the margin still hanging
 *  past the last of them when the box's own bottom edge does not stop it. */
interface FlowResult {
  height: number;
  hanging: number;
}

/**
 * Lay out a box's children as a block formatting context's contents, or as
 * one inline formatting context when they are all inline-level.
 */
function layoutChildren(
  box: Box,
  ctx: LayoutContext,
  floats: FloatContext,
  contentTop: number,
  contentWidth: number,
): FlowResult {
  const contentLeft = box.contentX;
  if (establishesInlineContext(box)) {
    const height = layoutInlineContent(
      box,
      ctx,
      floats,
      contentTop,
      contentWidth,
      contentLeft,
    );
    return { height, hanging: 0 };
  }

  let y = contentTop;
  /** The margin left hanging by the previous sibling, for collapsing. */
  let pendingMargin = 0;
  let first = true;

  for (const child of box.children) {
    if (child.kind === 'text' && !child.text.trim()) continue;
    if (child.outOfFlow) {
      ctx.positioned.push({
        box: child,
        containing: containingBlockFor(child) ?? box,
      });
      continue;
    }
    if (child.isFloat) {
      layoutFloat(child, ctx, floats, y + pendingMargin, contentWidth);
      continue;
    }

    resolveEdges(child, contentWidth);
    const top = child.marginTop;
    const collapsed = first ? top : collapseMargins(pendingMargin, top);
    let childY = y + collapsed;
    const clearance = floats.clearance(child.style.clear);
    if (clearance > -Infinity && clearance > childY) childY = clearance;

    layoutBlockLevel(child, ctx, floats, contentLeft, childY, contentWidth);
    y = child.y + child.height;
    pendingMargin = child.marginBottom;
    first = false;
  }

  // The last child's bottom margin collapses through the parent's bottom
  // edge unless a border, padding, a specified height or a formatting
  // context of its own stops it — which is why a `<div>` around a `<p>` is
  // not 16px taller than the paragraph. The margin is not *lost*, though: it
  // escapes, and the caller merges it into the box's own bottom margin so
  // the next sibling still sees it. Dropping it here was the bug that made
  // `<div><p>…</p></div><p>…</p>` set the two paragraphs solid.
  if (
    !first &&
    !box.borderBottom &&
    !box.padBottom &&
    box.style.height === AUTO &&
    !establishesBFC(box)
  ) {
    return { height: y - contentTop, hanging: pendingMargin };
  }
  return { height: y + pendingMargin - contentTop, hanging: 0 };
}

function layoutInlineContent(
  box: Box,
  ctx: LayoutContext,
  floats: FloatContext,
  contentTop: number,
  contentWidth: number,
  contentLeft: number,
): number {
  // Floats inside an inline context are placed before the lines are built,
  // so the lines already know to avoid them.
  for (const child of box.children) {
    if (child.outOfFlow) {
      ctx.positioned.push({
        box: child,
        containing: containingBlockFor(child) ?? box,
      });
    } else if (child.isFloat) {
      layoutFloat(child, ctx, floats, contentTop, contentWidth);
    }
  }
  // Atomics have to be sized before the line breaker can place them.
  sizeAtomics(box, ctx, contentWidth);

  const result = layoutInline(box, {
    fonts: ctx.fonts,
    width: contentWidth,
    startY: contentTop,
    floats,
    originX: contentLeft,
  });
  // The inline pass works in content-box coordinates; move the result into
  // document space now, so nothing below this line has to know the
  // difference.
  for (const line of result.lines) {
    line.x += contentLeft;
    line.y += contentTop;
    for (const placed of line.atomics) {
      placed.x += contentLeft;
      placed.y += contentTop;
      moveTo(placed.box, placed.x, placed.y + placed.box.marginTop);
    }
    for (const text of line.texts) {
      text.drawX += contentLeft;
      text.drawY += contentTop;
    }
  }
  box.lines = result.lines;
  return result.height;
}

/** Size every atomic in an inline context. */
function sizeAtomics(box: Box, ctx: LayoutContext, contentWidth: number): void {
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    if (child.kind === 'inline') {
      sizeAtomics(child, ctx, contentWidth);
      continue;
    }
    if (child.kind === 'text' || child.kind === 'break') continue;
    resolveEdges(child, contentWidth);
    layoutAtomic(child, ctx, contentWidth);
  }
}

/** An inline-level box that lays out as a block inside: `inline-block`, a
 *  replaced element, an `inline-table`. */
function layoutAtomic(
  box: Box,
  ctx: LayoutContext,
  availableWidth: number,
): void {
  if (box.kind === 'replaced') {
    sizeReplaced(box, availableWidth);
    return;
  }
  const width = shrinkToFitWidth(box, ctx, availableWidth);
  layoutInternals(box, ctx, width, 0, 0);
}

function layoutBlockLevel(
  box: Box,
  ctx: LayoutContext,
  outerFloats: FloatContext,
  contentLeft: number,
  y: number,
  containingWidth: number,
): void {
  resolveEdges(box, containingWidth);

  if (box.kind === 'replaced') {
    sizeReplaced(box, containingWidth);
    placeBlock(box, contentLeft, y, containingWidth);
    return;
  }

  const width = blockWidth(box, containingWidth);
  box.width = width;
  placeBlock(box, contentLeft, y, containingWidth);
  layoutInternals(box, ctx, width, box.x, box.y, outerFloats);
}

/**
 * Lay a box out at a width and report the widest thing it drew.
 *
 * This is what a table column asks twice — once unbounded for max-content,
 * once at a hair's width for min-content — and it exists rather than the
 * caller reading `box.width` because a `width: auto` box laid out unbounded
 * *is* unbounded: it fills its containing block, and its containing block was
 * `Infinity`. The answer has to come from what the content came to, which is
 * exactly what `intrinsicWidth` walks.
 */
export function measureIntrinsicWidth(
  box: Box,
  ctx: LayoutContext,
  available: number,
): number {
  ctx.layoutSubtree(box, available);
  const specified = box.style.width;
  if (specified !== AUTO && Number.isFinite(box.width)) return box.width;
  return intrinsicWidth(box) + box.horizontalExtra;
}

/**
 * Lay a box and everything under it out at a width, at the origin — what
 * `LayoutContext.layoutSubtree` hands to `flex.ts` and `table.ts`, and what
 * the shrink-to-fit probe uses. A replaced box is sized rather than laid out,
 * because there is nothing inside it to lay out.
 */
function layoutSubtree(box: Box, ctx: LayoutContext, width: number): void {
  resolveEdges(box, Number.isFinite(width) ? width : 0);
  if (box.kind === 'replaced') {
    sizeReplaced(box, width);
    box.x = 0;
    box.y = 0;
    return;
  }
  const borderBox = Number.isFinite(width)
    ? clampWidth(box, width, width)
    : Infinity;
  layoutInternals(box, ctx, borderBox, 0, 0);
}

/**
 * Lay a box's inside out and give it a height. `outerFloats` is the parent's
 * float context, passed only when this box does *not* establish one of its
 * own — which is the difference between text flowing beside a float that
 * started in an earlier sibling and text that starts below it.
 */
function layoutInternals(
  box: Box,
  ctx: LayoutContext,
  borderBoxWidth: number,
  x: number,
  y: number,
  outerFloats?: FloatContext,
): void {
  box.x = x;
  box.y = y;
  box.width = borderBoxWidth;
  const contentWidth = box.contentWidth;

  if (box.kind === 'flex') {
    const height = layoutFlex(box, ctx, contentWidth);
    finishHeight(box, height);
    return;
  }
  if (box.kind === 'table') {
    const height = layoutTable(box, ctx, contentWidth);
    finishHeight(box, height);
    return;
  }

  const ownFloats = establishesBFC(box) || !outerFloats;
  const floats = ownFloats
    ? new FloatContext(box.contentX, box.contentX + contentWidth)
    : outerFloats;
  const flow = layoutChildren(box, ctx, floats, box.contentY, contentWidth);
  // A box that establishes a formatting context contains its own floats, so
  // it has to be at least as tall as they are. One that does not, does not —
  // that is the classic "collapsed parent" every author has met.
  const withFloats = ownFloats
    ? Math.max(
        flow.height,
        floats.bottom === -Infinity ? 0 : floats.bottom - box.contentY,
      )
    : flow.height;
  finishHeight(box, withFloats);
  // The margin that escaped through this box's bottom edge becomes part of
  // its own: the parent's flow loop reads `child.marginBottom` for the next
  // sibling's collapse, which is exactly where an escaped margin goes.
  if (flow.hanging) {
    box.marginBottom = collapseMargins(box.marginBottom, flow.hanging);
  }
  if (box.markerText) layoutMarker(box, ctx);
}

/** The first line box anywhere under a box, in layout order. */
function firstLineIn(box: Box): LineBox | null {
  if (box.lines?.length) return box.lines[0];
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    const found = firstLineIn(child);
    if (found) return found;
  }
  return null;
}

/**
 * A list item's marker.
 *
 * `outside` — the default, and what `<ul>`'s padding leaves room for — sits
 * in the padding to the left of the content, right-aligned against it so a
 * list numbered past 9 stays lined up. `inside` sits at the content edge and
 * the text does not reserve room for it, which is what the keyword means.
 *
 * The marker is laid out here rather than being a box because it is not
 * content: it must not join the selection, or copying a list would paste a
 * bullet before every line.
 */
function layoutMarker(box: Box, ctx: LayoutContext): void {
  const fonts = ctx.fonts;
  if (!fonts) return;
  const style = box.style;
  const layout = fonts.layout(
    [
      {
        text: box.markerText,
        family: style.fontFamily,
        size: style.fontSize,
        color: style.color,
      },
    ],
    { family: style.fontFamily, size: style.fontSize, color: style.color },
    {},
  );
  box.markerLayout = layout;
  const gap = Math.round(style.fontSize * 0.4);
  // The marker sits on the first line of the item's *content*, which is not
  // always the item's own: an `<li>` holding a paragraph, or one holding text
  // and a nested list, has its inline content in an anonymous block. Looking
  // only at `box.lines` puts the marker of every such item at the content
  // top, which reads as a missing bullet rather than a misplaced one.
  const first = firstLineIn(box);
  const baselineY = first ? first.y + first.baseline : box.contentY;
  const own = layout.lines[0];
  box.markerY = baselineY - (own ? own.baseline : style.fontSize);
  box.markerX =
    style.listStylePosition === 'inside'
      ? box.contentX
      : box.contentX - gap - layout.width;
}

function finishHeight(box: Box, contentHeight: number): void {
  const specified = resolveOrNull(box.style.height, NaN);
  const height = specified ?? contentHeight;
  const borderBox =
    box.style.boxSizing === 'border-box' && specified !== null
      ? Math.max(height, box.verticalExtra)
      : height + box.verticalExtra;
  box.height = clampHeight(box, borderBox);
}

function clampHeight(box: Box, height: number): number {
  let out = height;
  const min = resolveOrNull(box.style.minHeight, NaN);
  const max =
    box.style.maxHeight === 'none'
      ? null
      : resolveOrNull(box.style.maxHeight, NaN);
  if (max !== null)
    out = Math.min(
      out,
      max + (box.style.boxSizing === 'border-box' ? 0 : box.verticalExtra),
    );
  if (min !== null)
    out = Math.max(
      out,
      min + (box.style.boxSizing === 'border-box' ? 0 : box.verticalExtra),
    );
  return Math.max(0, out);
}

/** Place a block-level box horizontally, honouring `margin: auto`. */
function placeBlock(
  box: Box,
  contentLeft: number,
  y: number,
  containingWidth: number,
): void {
  const style = box.style;
  const leftAuto = style.marginLeft === AUTO;
  const rightAuto = style.marginRight === AUTO;
  const slack = containingWidth - box.width - box.marginLeft - box.marginRight;
  let left = contentLeft + box.marginLeft;
  if (slack > 0) {
    if (leftAuto && rightAuto) left = contentLeft + slack / 2 + box.marginLeft;
    else if (leftAuto) left = contentLeft + slack + box.marginLeft;
  }
  box.x = left;
  box.y = y;
}

/** The border-box width of an in-flow block-level box. */
function blockWidth(box: Box, containingWidth: number): number {
  const style = box.style;
  const available = containingWidth - box.marginLeft - box.marginRight;
  if (style.width === AUTO) {
    return clampWidth(box, Math.max(0, available), containingWidth);
  }
  const specified = resolve(style.width, containingWidth, 0);
  const borderBox =
    style.boxSizing === 'border-box'
      ? Math.max(specified, box.horizontalExtra)
      : specified + box.horizontalExtra;
  return clampWidth(box, borderBox, containingWidth);
}

function clampWidth(box: Box, width: number, containingWidth: number): number {
  const style = box.style;
  const extra = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
  let out = width;
  const max =
    style.maxWidth === 'none'
      ? null
      : resolveOrNull(style.maxWidth, containingWidth);
  if (max !== null) out = Math.min(out, max + extra);
  const min = resolveOrNull(style.minWidth, containingWidth);
  if (min !== null) out = Math.max(out, min + extra);
  return Math.max(0, out);
}

/**
 * Shrink-to-fit: the width a float, an inline-block or a positioned box with
 * `width: auto` takes.
 *
 * CSS says `min(max(preferred-minimum, available), preferred)`, where the two
 * preferred widths are the max-content and min-content sizes. This computes
 * the max-content size by laying the box out unconstrained and skips the
 * min-content one, which costs a second full pass and only changes the answer
 * when a single unbreakable word is wider than the space — where the box
 * overflows either way. The measured pass is thrown away; the caller lays the
 * box out again at the width this returns.
 */
function shrinkToFitWidth(
  box: Box,
  ctx: LayoutContext,
  available: number,
): number {
  const style = box.style;
  if (style.width !== AUTO) {
    const specified = resolve(style.width, available, 0);
    const borderBox =
      style.boxSizing === 'border-box'
        ? Math.max(specified, box.horizontalExtra)
        : specified + box.horizontalExtra;
    return clampWidth(box, borderBox, available);
  }
  const probe = new FloatContext(0, Infinity);
  const saved = box.lines;
  layoutInternals(box, ctx, Infinity, 0, 0, probe);
  const preferred = intrinsicWidth(box) + box.horizontalExtra;
  box.lines = saved;
  return clampWidth(
    box,
    Math.min(Math.max(preferred, 0), available),
    available,
  );
}

/**
 * The widest thing a laid-out box drew — its max-content width.
 *
 * A block child laid out at an unbounded width *has* an unbounded width (a
 * `width: auto` block fills its containing block, and its containing block
 * was `Infinity`), so its own width says nothing and only what it drew does.
 * Skipping the non-finite ones is what stops the probe from answering
 * `Infinity` for every box that contains a paragraph.
 */
function intrinsicWidth(box: Box): number {
  let widest = 0;
  if (box.lines) {
    for (const line of box.lines) widest = Math.max(widest, line.width);
  }
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.outOfFlow) continue;
    const margins = child.marginLeft + child.marginRight;
    const inner = intrinsicWidth(child) + child.horizontalExtra + margins;
    const own = Number.isFinite(child.width) ? child.width + margins : 0;
    widest = Math.max(widest, inner, own);
  }
  return widest;
}

/** A replaced box's size: the style wins, then the attributes, then the
 *  intrinsic size, and an aspect ratio is kept when only one axis is given. */
function sizeReplaced(box: Box, containingWidth: number): void {
  const style = box.style;
  const intrinsicW = box.intrinsicWidth || 0;
  const intrinsicH = box.intrinsicHeight || 0;
  const ratio = intrinsicW > 0 && intrinsicH > 0 ? intrinsicH / intrinsicW : 0;

  let width = resolveOrNull(style.width, containingWidth);
  let height = resolveOrNull(style.height, NaN);
  if (width === null && height === null) {
    width = intrinsicW;
    height = intrinsicH;
  } else if (width === null) {
    width = ratio ? (height as number) / ratio : intrinsicW;
  } else if (height === null) {
    height = ratio ? width * ratio : intrinsicH;
  }

  const contentW = Math.max(0, width ?? 0);
  const contentH = Math.max(0, height ?? 0);
  const borderBoxW =
    style.boxSizing === 'border-box'
      ? Math.max(contentW, box.horizontalExtra)
      : contentW + box.horizontalExtra;
  const borderBoxH =
    style.boxSizing === 'border-box'
      ? Math.max(contentH, box.verticalExtra)
      : contentH + box.verticalExtra;
  box.width = clampWidth(box, borderBoxW, containingWidth);
  box.height = clampHeight(box, borderBoxH);
  // `hr` has no intrinsic size and its whole appearance is its border, so a
  // zero content height is the right answer rather than a missing one.
  if (box.replaced === 'hr' && box.style.height === AUTO) {
    box.height = box.verticalExtra;
  }
}

/** Place and size a float, and register it with the formatting context. */
function layoutFloat(
  box: Box,
  ctx: LayoutContext,
  floats: FloatContext,
  y: number,
  containingWidth: number,
): void {
  resolveEdges(box, containingWidth);
  if (box.kind === 'replaced') sizeReplaced(box, containingWidth);
  else {
    const width = shrinkToFitWidth(box, ctx, containingWidth);
    layoutInternals(box, ctx, width, 0, 0);
  }
  const outerWidth = box.width + box.marginLeft + box.marginRight;
  const clearance = floats.clearance(box.style.clear);
  const from = Math.max(y, clearance === -Infinity ? y : clearance);
  const top = floats.placeAt(
    from,
    outerWidth,
    box.style.float === 'right' ? 'right' : 'left',
  );
  const band = floats.bandAt(top, 1);
  const x =
    box.style.float === 'right'
      ? band.right - outerWidth + box.marginLeft
      : band.left + box.marginLeft;
  moveTo(box, x, top + box.marginTop);
  floats.add({
    left: x - box.marginLeft,
    right: x - box.marginLeft + outerWidth,
    top,
    bottom: top + box.height + box.marginTop + box.marginBottom,
    side: box.style.float === 'right' ? 'right' : 'left',
  });
}

/**
 * An absolutely positioned box, against its containing block.
 *
 * The static position — where the box would have been in flow — is not
 * tracked: a box with neither `top` nor `bottom` is placed at its containing
 * block's content top rather than where its markup sat. That is the one
 * deliberate simplification in positioning, and it is invisible for the
 * overwhelmingly common `position: absolute` with an explicit offset, which
 * is how a badge, a tooltip and an overlay are all written.
 */
function layoutPositioned(box: Box, containing: Box, ctx: LayoutContext): void {
  const cbWidth = containing.contentWidth;
  const cbHeight = containing.contentHeight;
  const cbX = containing.contentX;
  const cbY = containing.contentY;
  resolveEdges(box, cbWidth);

  const style = box.style;
  const left = resolveOrNull(style.left, cbWidth);
  const right = resolveOrNull(style.right, cbWidth);
  const top = resolveOrNull(style.top, cbHeight);
  const bottom = resolveOrNull(style.bottom, cbHeight);

  let width: number;
  if (style.width !== AUTO) {
    width = blockWidth(box, cbWidth);
  } else if (left !== null && right !== null) {
    width = Math.max(
      0,
      cbWidth - left - right - box.marginLeft - box.marginRight,
    );
  } else {
    width = shrinkToFitWidth(box, ctx, cbWidth);
  }

  if (box.kind === 'replaced') sizeReplaced(box, cbWidth);
  else layoutInternals(box, ctx, width, 0, 0);

  const x =
    left !== null
      ? cbX + left + box.marginLeft
      : right !== null
        ? cbX + cbWidth - right - box.width - box.marginRight
        : cbX;
  const y =
    top !== null
      ? cbY + top + box.marginTop
      : bottom !== null
        ? cbY + cbHeight - bottom - box.height - box.marginBottom
        : cbY;
  moveTo(box, x, y);
}

/** The nearest positioned ancestor, or null for the initial containing
 *  block. Walks the box tree rather than the DOM, so an anonymous box in
 *  between is transparent — which is what the spec means by "the nearest
 *  positioned ancestor". */
function containingBlockFor(box: Box): Box | null {
  let node = box.parent;
  while (node) {
    if (node.style.position !== 'static' || node.parent === null) return node;
    node = node.parent;
  }
  return null;
}

/** Move a box and everything under it, keeping the subtree's shape. */
export function moveTo(box: Box, x: number, y: number): void {
  translate(box, x - box.x, y - box.y);
}

function translate(box: Box, dx: number, dy: number): void {
  if (!dx && !dy) return;
  box.x += dx;
  box.y += dy;
  if (box.lines) {
    for (const line of box.lines) {
      line.x += dx;
      line.y += dy;
      for (const text of line.texts) {
        text.drawX += dx;
        text.drawY += dy;
      }
      for (const placed of line.atomics) {
        placed.x += dx;
        placed.y += dy;
      }
    }
  }
  for (const child of box.children) translate(child, dx, dy);
}

/** Resolve the margin, border and padding edges against a containing width.
 *  Percentages on *every* one of them are of the containing block's width,
 *  vertical padding included — which surprises everyone once. */
export function resolveEdges(box: Box, containingWidth: number): void {
  const style = box.style;
  box.borderTop =
    style.borderTopStyle === 'none' || style.borderTopStyle === 'hidden'
      ? 0
      : style.borderTopWidth;
  box.borderRight =
    style.borderRightStyle === 'none' || style.borderRightStyle === 'hidden'
      ? 0
      : style.borderRightWidth;
  box.borderBottom =
    style.borderBottomStyle === 'none' || style.borderBottomStyle === 'hidden'
      ? 0
      : style.borderBottomWidth;
  box.borderLeft =
    style.borderLeftStyle === 'none' || style.borderLeftStyle === 'hidden'
      ? 0
      : style.borderLeftWidth;
  box.padTop = edge(style.paddingTop, containingWidth);
  box.padRight = edge(style.paddingRight, containingWidth);
  box.padBottom = edge(style.paddingBottom, containingWidth);
  box.padLeft = edge(style.paddingLeft, containingWidth);
  box.marginTop = edge(style.marginTop, containingWidth);
  box.marginRight = edge(style.marginRight, containingWidth);
  box.marginBottom = edge(style.marginBottom, containingWidth);
  box.marginLeft = edge(style.marginLeft, containingWidth);
}

function edge(len: Len, containingWidth: number): number {
  if (len === AUTO) return 0;
  if (isPct(len))
    return Number.isFinite(containingWidth)
      ? (len.pct / 100) * containingWidth
      : 0;
  return len;
}

/** Whether every in-flow child is inline-level, which is what makes this box
 *  an inline formatting context rather than a block one. */
function establishesInlineContext(box: Box): boolean {
  if (box.kind === 'table' || box.kind === 'flex') return false;
  let sawInline = false;
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    switch (child.kind) {
      case 'text':
      case 'inline':
      case 'break':
        sawInline = true;
        break;
      case 'replaced':
        sawInline = true;
        break;
      default:
        if (isInlineLevel(child)) sawInline = true;
        else return false;
        break;
    }
  }
  return sawInline;
}

function isInlineLevel(box: Box): boolean {
  const d = box.style.display;
  return (
    d === 'inline' ||
    d === 'inline-block' ||
    d === 'inline-flex' ||
    d === 'inline-table'
  );
}

/** Whether a box establishes a block formatting context — contains its own
 *  floats, and does not collapse margins through its edges. */
export function establishesBFC(box: Box): boolean {
  const style = box.style;
  if (style.overflowX !== 'visible' || style.overflowY !== 'visible')
    return true;
  if (style.float !== 'none') return true;
  if (style.position === 'absolute' || style.position === 'fixed') return true;
  if (
    style.display === 'inline-block' ||
    style.display === 'flex' ||
    style.display === 'inline-flex'
  ) {
    return true;
  }
  if (box.kind === 'table-cell' || box.kind === 'table') return true;
  return box.parent === null;
}

/** What a box's `position: relative` offset moves it by, applied after
 *  layout so it does not affect anything else's position — which is the
 *  whole of what makes it *relative*. */
export function applyRelativeOffsets(box: Box): void {
  for (const child of box.children) applyRelativeOffsets(child);
  const style = box.style;
  if (style.position !== 'relative' && style.position !== 'sticky') return;
  const parentWidth = box.parent ? box.parent.contentWidth : 0;
  const parentHeight = box.parent ? box.parent.contentHeight : 0;
  const left = resolveOrNull(style.left, parentWidth);
  const right = resolveOrNull(style.right, parentWidth);
  const top = resolveOrNull(style.top, parentHeight);
  const bottom = resolveOrNull(style.bottom, parentHeight);
  const dx = left ?? (right !== null ? -right : 0);
  const dy = top ?? (bottom !== null ? -bottom : 0);
  translate(box, dx, dy);
}
