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
import { AUTO, isTransparent, resolve, resolveOrNull } from '../css/values.js';
import type { Len } from '../css/values.js';
import type { BorderStyle, ComputedStyle, ContentSize } from '../css/style.js';
import {
  Box,
  CUT_BLOCKS,
  FIRST_LINE,
  INLINE_OFFSETS,
  SHIFTED_LINES,
  TEXT_SHIFTS,
} from './boxes.js';
import type { BoxTree, Intrinsic, LineBox, Marker } from './boxes.js';
import { FloatContext } from './floats.js';
import {
  faceExtentOf,
  layoutInline,
  lineHeightMultiplier,
  strutOf,
} from './inline.js';
import type { FontsLike } from './inline.js';
import { layoutFlex } from './flex.js';
import { finishCaptions, layoutTable } from './table.js';
import { collapseEdges } from './collapse.js';
import { computePaintBounds, hoistNegative } from '../paint.js';

export interface LayoutContext {
  fonts: FontsLike | null;
  /** Whether any block has a `::first-line` (`BoxTree.firstLine`). */
  firstLine?: boolean;
  /** Whether a float or an out-of-flow box is in an inline box
   *  (`BoxTree.nestedOutOfLine`). */
  nestedOutOfLine?: boolean;
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
    firstLine: tree.firstLine,
    nestedOutOfLine: tree.nestedOutOfLine,
  };
  const root = tree.root;
  root.x = 0;
  root.y = 0;
  root.width = viewportWidth;
  // The root box stands in for `<body>` when the document has none (see
  // `Cascade.rootStyle`), so it may carry a margin — and a margin on the
  // initial containing block has nothing to sit inside. Folded into the
  // padding at the sides and the bottom, which keeps `contentX` the one
  // thing layout reads. Not at the top: a body's top margin collapses with
  // its first block's, `<html>` being the formatting context's root and
  // `<body>` not, so it is handed to the flow as the margin already pending
  // there — or `<p>hi</p>` would stand 8px lower than the same paragraph in
  // `<body>`.
  resolveEdges(root, viewportWidth);
  const leading = root.marginTop;
  root.padRight += root.marginRight;
  root.padBottom += root.marginBottom;
  root.padLeft += root.marginLeft;
  root.marginTop = 0;
  root.marginRight = 0;
  root.marginBottom = 0;
  root.marginLeft = 0;

  const contentWidth = Math.max(0, viewportWidth - root.horizontalExtra);
  const floats = new FloatContext(root.contentX, root.contentX + contentWidth);
  // the initial containing block is the viewport's size, which a percentage
  // height on the root element resolves against (CSS 2.1 10.1, 10.5); a
  // fragment has no root element, and the box standing in for its body has
  // the body's `auto` height to give
  for (const child of root.children) {
    if (child.el?.name === 'html') child.percentHeightBase = viewportHeight;
  }
  const flow = layoutChildren(
    root,
    ctx,
    floats,
    root.contentY,
    contentWidth,
    leading,
  );
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
  if (tree.relative) applyRelativeOffsets(root);
  const reach = computePaintBounds(root, tree.movedInline);
  if (tree.negative) hoistNegative(root);

  // The document is as tall as what overflows the root, not the root: an
  // `html, body { height: 100% }` a window tall holds a message longer than
  // the window, and the element sizes to all of it.
  let bottom = Math.max(root.height, reach);
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

/**
 * A block's top margin as its placement uses it: its own, collapsed with
 * every margin that adjoins it (CSS 2.1 8.3.1). That is its first in-flow
 * child's while nothing parts them — no top border, no top padding, no
 * formatting context of its own, no line of text first — and that child's
 * first child's, down the chain; and past a child that is empty, its bottom
 * margin and the next child's top, because an empty block's two margins
 * adjoin each other. The children the chain went through are marked, so
 * their own layout does not apply the margin a second time. Without it
 * `<div><p>` stood a paragraph's margin lower than `<p>`, and a `<div>`
 * holding only an absolute image stood the rest of a document a body's
 * margin lower than a browser does.
 */
function collapsedTopMargin(box: Box, containingWidth: number): number {
  floatsPassed = false;
  floatsLeft = 0;
  floatsRight = 0;
  return absorbChildren(box, containingWidth, box.marginTop);
}

/** Whether the last `absorbChildren` went through every child in flow of
 *  its box, each empty and absorbed whole — which is what lets the caller
 *  take that box's bottom margin too. Read straight after the call. */
let throughAll = false;
/** Whether the walk has passed a float, and how wide the floats it passed
 *  on each side are, their margin boxes as their styles state them — NaN
 *  once one does not. Such a float is placed where the margin ends, so it
 *  moves with the margin, and a new formatting context the margin reaches
 *  next has to be able to sit beside it. */
let floatsPassed = false;
let floatsLeft = 0;
let floatsRight = 0;

/**
 * Collapse into `margin` the margins of `at`'s children that adjoin its top
 * edge, marking each child it takes, and return it. The walk stops at the
 * first child something parts from the margin — a line, a clearance, a
 * border, padding or height, a formatting context of its own — and counts
 * a child empty only where its layout is sure to agree, since this runs
 * before anything is laid out and the parent is placed by what it answers:
 * an inline box with an edge, or a percentage, stops it where it might have
 * gone on.
 */
function absorbChildren(at: Box, width: number, margin: number): number {
  let whole = true;
  /** `at`'s content width, worked out when a child first needs it: most
   *  blocks start with text, and never do. */
  let inner = -1;
  for (const child of at.children) {
    if (child.outOfFlow) continue;
    if (child.kind === 'text') {
      if (makesNoLine(child)) continue;
      // a line box stops a margin
      whole = false;
      break;
    }
    const floated = child.isFloat;
    const inLine =
      !floated &&
      (child.kind === 'inline' ||
        child.kind === 'break' ||
        isInlineLevel(child));
    if (inLine) {
      const made = phantom(child);
      if (made === 0) {
        whole = false;
        break;
      }
      if (made === 1) continue;
    }
    if (inner < 0) {
      if (!topOpen(at)) {
        whole = false;
        break;
      }
      inner = Math.max(0, blockWidth(at, width) - at.horizontalExtra);
    }
    if (floated) {
      passFloat(child, inner);
      continue;
    }
    if (inLine) {
      passFloatsIn(child, inner);
      continue;
    }
    if (child.style.clear !== 'none') {
      child.topAbsorbed = 0;
      whole = false;
      break;
    }
    resolveEdges(child, inner);
    if (
      floatsPassed &&
      (child.kind === 'replaced' || establishesBFC(child)) &&
      !fitsBeside(child, inner)
    ) {
      // it would be pushed below the floats the margin carries, so it
      // separates from them as clearance does: the margin stops above it,
      // and it sits under the floats rather than a margin under them
      child.topAbsorbed = 3;
      whole = false;
      break;
    }
    margin = collapseMargins(margin, child.marginTop);
    margin = absorbChildren(child, inner, margin);
    if (!throughAll || !bottomOpen(child)) {
      child.topAbsorbed = 1;
      whole = false;
      break;
    }
    child.topAbsorbed = 2;
    margin = collapseMargins(margin, child.marginBottom);
  }
  throughAll = whole && (inner >= 0 || topOpen(at));
  return margin;
}

/** Whether a box's top margin adjoins its first child's: a block, with no
 *  border or padding at the top and no formatting context of its own. */
function topOpen(box: Box): boolean {
  return (
    box.kind === 'block' &&
    box.borderTop === 0 &&
    box.padTop === 0 &&
    !establishesBFC(box)
  );
}

/** Whether nothing at an empty block's bottom holds its margins apart: no
 *  border, padding or height there, and no marker to stand a line tall. A
 *  percentage says no, whatever it resolves to. */
function bottomOpen(box: Box): boolean {
  const { height, minHeight } = box.style;
  return (
    box.borderBottom === 0 &&
    box.padBottom === 0 &&
    !box.marker &&
    (height === AUTO || height === 0) &&
    (minHeight === AUTO || minHeight === 0)
  );
}

/** Whether a text makes no line of its own: white space that collapses
 *  away. A no-break space is not white space to CSS, though `\s` says it
 *  is, and white space that is kept makes a line. */
function makesNoLine(text: Box): boolean {
  const ws = text.style.whiteSpace;
  return (ws === 'normal' || ws === 'nowrap') && COLLAPSIBLE.test(text.text);
}
const COLLAPSIBLE = /^[ \t\n\r\f]*$/;

/** Whether an inline box makes no line either — nothing in it that does,
 *  and no margin, border or padding on any side: the phantom line of CSS
 *  2.1 9.4.2, which a margin collapses through. `0` where it makes one,
 *  `1` where it does not, and `2` where it does not and holds a float, which
 *  the walk has to pass. The children go first: most inline boxes hold text,
 *  and that answers without a look at their edges. */
function phantom(box: Box): 0 | 1 | 2 {
  if (box.kind !== 'inline' || box.style.display !== 'inline') return 0;
  let made: 1 | 2 = 1;
  for (const child of box.children) {
    if (child.outOfFlow) continue;
    if (child.isFloat) {
      made = 2;
      continue;
    }
    if (child.kind === 'text') {
      if (makesNoLine(child)) continue;
      return 0;
    }
    const inner = phantom(child);
    if (inner === 0) return 0;
    if (inner === 2) made = 2;
  }
  const style = box.style;
  return noLength(style.marginLeft) &&
    noLength(style.marginRight) &&
    noLength(style.marginTop) &&
    noLength(style.marginBottom) &&
    noLength(style.paddingLeft) &&
    noLength(style.paddingRight) &&
    noLength(style.paddingTop) &&
    noLength(style.paddingBottom) &&
    !hasBorder(style.borderLeftStyle, style.borderLeftWidth) &&
    !hasBorder(style.borderRightStyle, style.borderRightWidth) &&
    !hasBorder(style.borderTopStyle, style.borderTopWidth) &&
    !hasBorder(style.borderBottomStyle, style.borderBottomWidth)
    ? made
    : 0;
}

/** Pass the floats in a phantom inline box, at any depth. */
function passFloatsIn(box: Box, width: number): void {
  for (const child of box.children) {
    if (child.isFloat) passFloat(child, width);
    else if (child.kind === 'inline') passFloatsIn(child, width);
  }
}

function noLength(len: Len): boolean {
  return len === 0 || len === AUTO;
}

function hasBorder(style: BorderStyle, width: number): boolean {
  return style !== 'none' && style !== 'hidden' && width !== 0;
}

/** Count a float the walk passes toward the room a new formatting context
 *  after it would have beside it. */
function passFloat(float: Box, width: number): void {
  resolveEdges(float, width);
  floatsPassed = true;
  if (float.style.float === 'right') {
    floatsRight += statedOuterWidth(float, width);
  } else floatsLeft += statedOuterWidth(float, width);
}

/** Whether a new formatting context fits beside the floats the walk passed
 *  (CSS 2.1 9.5), as `layoutBesideFloats` places it: where its width and
 *  theirs are stated, whether its border box, set in from its margins or
 *  the floats, ends before them or the room does; where the floats' are
 *  not, yes, and a box of `width: auto` there shrinks to the room it has. */
function fitsBeside(box: Box, width: number): boolean {
  const stated =
    statedOuterWidth(box, width) - box.marginLeft - box.marginRight;
  const lo = floatsLeft ? floatsLeft : -Infinity;
  const hi = floatsRight ? width - floatsRight : Infinity;
  const [start, end] = besideFloats(box, 0, width, lo, hi);
  const across = Number.isNaN(stated)
    ? Math.max(box.horizontalExtra, end - start)
    : stated;
  return box.parent?.style.direction === 'rtl'
    ? !(end - across < Math.max(Math.min(0, box.marginLeft), lo) - 0.01)
    : !(
        start + across >
        Math.min(width - Math.min(0, box.marginRight), hi) + 0.01
      );
}

/** A box's margin-box width as its style states it, before it is laid out:
 *  NaN for `width: auto`, which only layout can answer. */
function statedOuterWidth(box: Box, containingWidth: number): number {
  const { width, boxSizing } = box.style;
  if (width === AUTO) return NaN;
  const set = resolve(width, containingWidth, NaN);
  const border =
    boxSizing === 'border-box'
      ? Math.max(set, box.horizontalExtra)
      : set + box.horizontalExtra;
  return border + box.marginLeft + box.marginRight;
}

/**
 * Whether a box's top and bottom margins collapse through it: a block with
 * no height, no border or padding, no line in it and no formatting context
 * of its own, whose blocks are all the same (CSS 2.1 8.3.1). An empty
 * `<div>` between two paragraphs is the case: its margins and theirs are
 * one margin, where they were stacked.
 */
function collapsesThrough(box: Box): boolean {
  if (box.kind !== 'block' || box.height !== 0) return false;
  if (box.lines?.length || establishesBFC(box)) return false;
  const min = resolveOrNull(box.style.minHeight, box.percentHeightBase);
  if (min !== null && min > 0) return false;
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    // what is in line made a line or did not, and the lines said which
    if (
      child.kind === 'text' ||
      child.kind === 'inline' ||
      child.kind === 'break' ||
      isInlineLevel(child)
    ) {
      continue;
    }
    if (!collapsesThrough(child)) return false;
  }
  return true;
}

/** Whether a text is white space alone, as `!text.trim()` says, without
 *  copying the text to find out — which `trim` does to a paragraph's text
 *  that ends in a space, on every pass. */
function isBlank(text: string): boolean {
  return BLANK.test(text);
}
const BLANK = /^\s*$/;

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
  leading = 0,
): FlowResult {
  const contentLeft = box.contentX;
  if (establishesInlineContext(box)) {
    // a line box stops a margin: the leading one is spent above the lines
    const height = layoutInlineContent(
      box,
      ctx,
      floats,
      contentTop + leading,
      contentWidth,
      contentLeft,
    );
    return { height: height + leading, hanging: 0 };
  }

  let y = contentTop;
  /** The margin left hanging by the previous sibling — or, before the first
   *  child, the one `leading` hands down — for collapsing. */
  let pendingMargin = leading;
  let first = true;
  /** Whether every child in flow so far was absorbed whole into this box's
   *  top margin: the walk that marked the next child reached it only
   *  through them, so past any other its mark is an earlier pass's. Asked
   *  of the box only once a child carries a mark, which few do. */
  let open: boolean | null = null;
  /** Whether the margin still hanging collapsed with a top margin that has
   *  clearance, an empty block cleared past a float's, and the margin that
   *  makes: the block's own two and what the empty blocks after it add to
   *  them. It stays in this box rather than escape its bottom (CSS 2.1
   *  8.3.1, 10.6.3). */
  let cleared = false;
  let afterClear = 0;
  /** The cleared block's own top margin: its top border edge is that far
   *  inside the margin its margins and the ones after it collapse to. */
  let clearTop = 0;
  // this box's first formatted line is its first child's in flow (CSS 2.1
  // 5.12.1), which its `::first-line` is handed to
  let firstLine = ctx.firstLine ? firstLineOf(box) : null;

  for (const child of box.children) {
    if (child.kind === 'text' && isBlank(child.text)) continue;
    if (firstLine && !child.outOfFlow && !child.isFloat) {
      if (!FIRST_LINE.has(child)) HANDED.set(child, firstLine);
      firstLine = null;
    }
    if (child.outOfFlow) {
      placeStatic(child, box, contentLeft, contentWidth, y + pendingMargin);
      ctx.positioned.push({
        box: child,
        containing: containingBlockFor(child) ?? box,
      });
      continue;
    }
    if (child.isFloat) {
      layoutFloat(
        child,
        ctx,
        floats,
        y + pendingMargin,
        contentLeft,
        contentWidth,
      );
      continue;
    }

    resolveEdges(child, contentWidth);
    // A child whose margin this box already spent — collapsed through its
    // top edge — sits at the content top; any other brings its own margin,
    // collapsed with its first descendants' where nothing parts them.
    let absorbed = child.topAbsorbed;
    if (absorbed !== 0 && !(open ??= topOpen(box))) absorbed = 0;
    const top = absorbed ? 0 : collapsedTopMargin(child, contentWidth);
    const collapsed = collapseMargins(pendingMargin, top);
    let childY = y + collapsed;
    const clearance = floats.clearance(child.style.clear);
    if (clearance > -Infinity && clearance > childY) childY = clearance;

    if (
      !floats.isEmpty &&
      (child.kind === 'replaced' || establishesBFC(child))
    ) {
      layoutBesideFloats(child, ctx, floats, contentLeft, childY, contentWidth);
    } else {
      layoutBlockLevel(child, ctx, floats, contentLeft, childY, contentWidth);
    }
    first = false;
    const moved = childY !== y + collapsed;
    if (!moved && collapsesThrough(child)) {
      // nothing in it parts its margins: they and the ones either side of
      // it are one (CSS 2.1 8.3.1), still hanging for what comes next —
      // or, where the walk took them all into this box's top margin, spent
      if (absorbed === 2) {
        pendingMargin = collapsed;
        continue;
      }
      open = false;
      pendingMargin = collapseMargins(collapsed, child.marginBottom);
      if (cleared) {
        afterClear = collapseMargins(
          collapseMargins(afterClear, top),
          child.marginBottom,
        );
      }
      continue;
    }
    open = false;
    y = child.y + child.height;
    pendingMargin = child.marginBottom;
    // cleared, and empty: its margins collapse together, and what follows
    // collapses with them, a top margin that has clearance (CSS 2.1 8.3.1)
    cleared = moved && collapsesThrough(child);
    afterClear = cleared ? collapseMargins(top, child.marginBottom) : 0;
    clearTop = cleared ? top : 0;
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
    !cleared &&
    !box.borderBottom &&
    !box.padBottom &&
    box.style.height === AUTO &&
    !establishesBFC(box)
  ) {
    const height = y - contentTop;
    // A minimum height that makes the box taller parts the margin from its
    // bottom, and spends it: the margin neither escapes nor makes the box
    // taller still. 8.3.1 has it collapse only through a box of no
    // `min-height`; browsers part it only where the minimum is what sets
    // the height, and the suite has it so. A maximum leaves it to collapse
    // through, as 8.3.1 has it, where the suite has a test either way
    const parted =
      box.style.minHeight !== AUTO &&
      clampHeight(box, height + box.verticalExtra) > height + box.verticalExtra;
    return { height, hanging: parted ? 0 : pendingMargin };
  }
  // The cleared block's top border edge is where it would be with a border
  // at its bottom, its top margin's depth inside the margin they all make:
  // the box ends where that margin does, below the edge by what exceeds
  // the top margin (8.3.1, 10.6.3)
  if (cleared) {
    return {
      height: y + Math.max(0, afterClear - clearTop) - contentTop,
      hanging: 0,
    };
  }
  return { height: y + pendingMargin - contentTop, hanging: 0 };
}

/**
 * A block that makes its own formatting context — a table, a box that
 * clips its overflow — or a block-level image does not flow round the
 * floats beside it: it is a rectangle beside them (CSS 2.1 9.5), in the
 * room they leave at its top, or lower down where it does not fit there.
 * An image floated left with an `overflow: hidden` block of text beside it
 * is the layout this is for; the block ran under the image.
 */
function layoutBesideFloats(
  box: Box,
  ctx: LayoutContext,
  floats: FloatContext,
  contentLeft: number,
  y: number,
  contentWidth: number,
): void {
  const right = contentLeft + contentWidth;
  const style = box.style;
  // auto margins, and HTML's alignment, place the box in the room the
  // floats leave, as browsers do
  const inRoom =
    style.marginLeft === AUTO ||
    style.marginRight === AUTO ||
    !!box.parent?.style.alignBlocks;
  const rtl = box.parent?.style.direction === 'rtl';
  // Otherwise its margins are its containing block's, and may overlap a
  // float on their own side; its border box may not. So a column beside a
  // 200px sidebar with a margin of 220px starts 220px in, not 420px. A
  // float is looked for as far out as a negative margin takes the box
  resolveEdges(box, contentWidth);
  const reachLeft = inRoom
    ? contentLeft
    : Math.min(contentLeft, contentLeft + box.marginLeft);
  const reachRight = inRoom ? right : Math.max(right, right - box.marginRight);
  let at = y;
  for (let tries = 0; tries < 64; tries += 1) {
    let band = floats.bandAt(at, 1, reachLeft, reachRight, !inRoom);
    let fits = false;
    // The room is what the floats leave over the box's whole height, not at
    // its top: a float that starts lower down, beside the box, narrows it
    // too (CSS 2.1 9.5). Known only once the box is laid out, so a box
    // that runs into one is laid out again in what is left.
    for (let settle = 0; settle < 8; settle += 1) {
      const room = band.right - band.left;
      const lo = band.left > reachLeft ? band.left : -Infinity;
      const hi = band.right < reachRight ? band.right : Infinity;
      if (inRoom) layoutBlockLevel(box, ctx, floats, band.left, at, room);
      else {
        const [start, end] = besideFloats(box, contentLeft, right, lo, hi);
        layoutBlockLevel(
          box,
          ctx,
          floats,
          start - box.marginLeft,
          at,
          end - start + box.marginLeft + box.marginRight,
          contentWidth,
        );
      }
      const tall = box.marginTop + box.height + box.marginBottom;
      const over = floats.bandAt(at, tall, reachLeft, reachRight, !inRoom);
      if (over.left > band.left + 0.5 || over.right < band.right - 0.5) {
        band = over;
        continue;
      }
      // What is too wide overflows at the end of the line, as far as a
      // negative margin there takes it, but no further into a float or
      // past the room; at the start it would run into the floats, and
      // waits below them (the suite's floats-wrap-bfc-with-margin tests)
      if (inRoom) {
        fits = box.marginLeft + box.width + box.marginRight <= room + 0.5;
      } else if (rtl) {
        const limit = Math.max(contentLeft + Math.min(0, box.marginLeft), lo);
        fits = box.x >= limit - 0.5;
      } else {
        const limit = Math.min(right - Math.min(0, box.marginRight), hi);
        fits = box.x + box.width <= limit + 0.5;
      }
      break;
    }
    if (fits) return;
    const below = floats.nextEdgeBelow(at, 1);
    if (below === null || below <= at) break;
    at = below;
  }
  layoutBlockLevel(box, ctx, floats, contentLeft, at, contentWidth);
}

/**
 * The left and right edges a block with a formatting context of its own
 * has for its border box beside floats that reach `lo` from the left and
 * `hi` from the right (infinite where none does): each margin set in from
 * its containing block's edge, or the float's where that is further in.
 */
function besideFloats(
  box: Box,
  left: number,
  right: number,
  lo: number,
  hi: number,
): [number, number] {
  return [
    Math.max(left + box.marginLeft, lo),
    Math.min(right - box.marginRight, hi),
  ];
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
  placeOutOfLine(box, box, ctx, floats, contentTop, contentWidth, contentLeft);
  // Atomics have to be sized before the line breaker can place them.
  sizeAtomics(box, ctx, contentWidth);

  const options = {
    fonts: ctx.fonts,
    width: contentWidth,
    startY: contentTop,
    floats,
    originX: contentLeft,
  };
  let result = layoutInline(box, options);
  const firstLine = ctx.firstLine ? firstLineOf(box) : null;
  if (firstLine && firstLine.color !== box.style.color && result.lines.length) {
    // the first line's text in its `::first-line` colour, laid out again
    // with its runs cut where the line ends (CSS 2.1 5.12.1)
    result = layoutInline(box, {
      ...options,
      firstLine: {
        color: firstLine.color,
        from: box.style.color,
        end: result.lines[0].textEnd,
      },
    });
  }
  if (
    firstLine &&
    ctx.fonts &&
    result.lines.length &&
    !isTransparent(firstLine.backgroundColor)
  ) {
    result.lines[0].background = {
      style: firstLine,
      ...faceExtentOf(ctx.fonts, firstLine),
    };
  }
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
    for (const edge of line.edges ?? []) edge.x += contentLeft;
  }
  box.lines = result.lines;
  return result.height;
}

/** `::first-line` styles handed down to the first child in flow of a box
 *  that has one, whose first line is the box's (`layoutChildren`). */
const HANDED = new WeakMap<Box, ComputedStyle>();

/** The `::first-line` style a box's first line takes: its own, or one an
 *  ancestor handed it. */
function firstLineOf(box: Box): ComputedStyle | null {
  return FIRST_LINE.get(box) ?? HANDED.get(box) ?? null;
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
  /** What percentages are of: the containing block's width, where the
   *  room is narrower than it beside floats */
  percentBase = containingWidth,
): void {
  resolveEdges(box, percentBase);

  if (box.kind === 'replaced') {
    sizeReplaced(box, percentBase);
    placeBlock(box, contentLeft, y, containingWidth);
    return;
  }

  const width = blockWidth(box, containingWidth, percentBase, ctx);
  box.width = width;
  placeBlock(box, contentLeft, y, containingWidth);
  layoutInternals(box, ctx, width, box.x, box.y, outerFloats);
  if (
    box.kind === 'table' &&
    box.width !== width &&
    Number.isFinite(containingWidth)
  ) {
    // a table shrinks to its columns once it is laid out, where it was
    // placed as wide as its room: placed again, its auto margins centre it
    // — in a room that has a width, and not in the unbounded one a
    // shrink-to-fit probe lays it out in
    const x = box.x;
    placeBlock(box, contentLeft, y, containingWidth);
    const dx = box.x - x;
    box.x = x;
    translate(box, dx, 0);
  }
}

/**
 * Lay a block-level box out as a block in a containing block of a width,
 * at its own `width` or at the room its margins leave, with the offset its
 * margins give it; the caller moves it into place. What a table's caption
 * is, in the box around the table.
 */
export function layoutBlockIn(
  box: Box,
  ctx: LayoutContext,
  containingWidth: number,
): void {
  resolveEdges(box, containingWidth);
  const width = blockWidth(box, containingWidth, containingWidth, ctx);
  box.width = width;
  placeBlock(box, 0, 0, containingWidth);
  layoutInternals(box, ctx, width, box.x, 0);
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
  givePercentBase(box, percentBaseInside(box));

  if (box.kind === 'flex') {
    const height = layoutFlex(box, ctx, contentWidth);
    finishHeight(box, height);
    return;
  }
  if (box.kind === 'table') {
    const height = layoutTable(box, ctx, contentWidth);
    finishHeight(box, height);
    finishCaptions(box);
    return;
  }

  const ownFloats = establishesBFC(box) || !outerFloats;
  const floats = ownFloats
    ? new FloatContext(box.contentX, box.contentX + contentWidth)
    : outerFloats;
  // the line a pass before gave a marker, which this one may not
  if (box.marker) box.lines = null;
  const flow = layoutChildren(box, ctx, floats, box.contentY, contentWidth);
  // A list item with a marker and no line holds one, the marker's, a line
  // of its own face tall: an empty `<li>` is a line tall in a browser, and
  // an inline-block around one sits on its marker's baseline.
  let height = flow.height;
  if (box.marker && ctx.fonts && !firstLineIn(box)) {
    const strut = strutOf(ctx.fonts, box.style);
    const line = strut.ascent + strut.descent;
    box.lines = [
      {
        x: box.contentX,
        y: box.contentY,
        width: 0,
        height: line,
        baseline: strut.ascent,
        texts: [],
        textStart: box.subtreeTextStart,
        textEnd: box.subtreeTextStart,
        atomics: [],
      },
    ];
    height = Math.max(height, line);
  }
  // A box that establishes a formatting context contains its own floats, so
  // it has to be at least as tall as they are. One that does not, does not —
  // that is the classic "collapsed parent" every author has met.
  const withFloats = ownFloats
    ? Math.max(
        height,
        floats.bottom === -Infinity ? 0 : floats.bottom - box.contentY,
      )
    : height;
  finishHeight(box, withFloats);
  // The margin that escaped through this box's bottom edge becomes part of
  // its own: the parent's flow loop reads `child.marginBottom` for the next
  // sibling's collapse, which is exactly where an escaped margin goes.
  if (flow.hanging) {
    box.marginBottom = collapseMargins(box.marginBottom, flow.hanging);
  }
  if (box.marker) layoutMarker(box, box.marker, ctx);
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
function layoutMarker(box: Box, marker: Marker, ctx: LayoutContext): void {
  const fonts = ctx.fonts;
  if (!fonts) return;
  const style = box.style;
  // in its own style where a `::marker` rule gives it one — the colour and
  // the face a bullet or a number is set in — and the item's where not
  const set = marker.style ?? style;
  const face = {
    family: set.fontFamily,
    size: set.fontSize,
    color: set.color,
    ...(marker.style
      ? {
          weight: set.fontWeight,
          style:
            set.fontStyle === 'normal'
              ? ('normal' as const)
              : ('italic' as const),
        }
      : null),
  };
  // set in a line of the item's own height, so that where the item has no
  // line of its own the marker stands where its first would have been
  const layout = fonts.layout([{ text: marker.text, ...face }], face, {
    lineHeight: lineHeightMultiplier(fonts, style),
  });
  marker.layout = layout;
  const gap = Math.round(style.fontSize * 0.4);
  // The marker sits on the first line of the item's *content*, which is not
  // always the item's own: an `<li>` holding a paragraph, or one holding text
  // and a nested list, has its inline content in an anonymous block. Looking
  // only at `box.lines` puts the marker of every such item at the content
  // top, which reads as a missing bullet rather than a misplaced one. An
  // empty item is still a list item, and its marker a line at its top.
  const first = firstLineIn(box);
  const own = layout.lines[0];
  marker.y = first
    ? first.y + first.baseline - (own ? own.baseline : style.fontSize)
    : box.contentY;
  marker.x =
    style.listStylePosition === 'inside'
      ? box.contentX
      : box.contentX - gap - layout.width;
}

/**
 * The height a percentage `height` inside a box resolves against: its own
 * content height, where that is set rather than grown from its content —
 * a length, or a percentage that itself resolved (CSS 2.1 10.5). NaN, and
 * so `auto`, where it is not. An anonymous box is no containing block for
 * this (9.2.1.1) and hands on its parent's.
 *
 * The root element's is the viewport's height, so `html, body { height:
 * 100% }` — which mail sets as often as not — is a window tall, as in a
 * browser; the document is as tall as what overflows it, so a message
 * longer than the window is not cut off (`layoutDocument`).
 */
export function percentBaseInside(box: Box): number {
  if (!box.el && !box.pseudo) return box.percentHeightBase;
  const resolved = resolveOrNull(box.style.height, box.percentHeightBase);
  if (resolved === null) {
    // a height `aspect-ratio` gives from a width is as definite as the width
    const ratio = ratioHeight(box);
    if (ratio === null) return NaN;
    return Math.max(
      0,
      clampHeight(box, ratio + box.verticalExtra) - box.verticalExtra,
    );
  }
  const set = Math.max(0, resolved);
  const borderBox =
    box.style.boxSizing === 'border-box'
      ? Math.max(set, box.verticalExtra)
      : set + box.verticalExtra;
  return Math.max(0, clampHeight(box, borderBox) - box.verticalExtra);
}

/**
 * Hand a box's children the height their percentages resolve against —
 * through inline boxes, which are no containing block, to the inline-block
 * or image in them. Nearly every box has none to give, and its children
 * hold NaN until it has, so it visits them only when there is a height, or
 * was one on the last pass: visiting every child of every block on every
 * pass cost more than laying out a table.
 */
function givePercentBase(box: Box, base: number): void {
  const given = !Number.isNaN(base);
  if (!given && !box.gavePercentBase) return;
  box.gavePercentBase = given;
  handPercentBase(box, base);
}

function handPercentBase(box: Box, base: number): void {
  for (const child of box.children) {
    child.percentHeightBase = base;
    if (child.kind === 'inline') handPercentBase(child, base);
  }
}

/**
 * The content height `aspect-ratio` gives a box whose height is `auto`, from
 * its width (CSS Sizing 4, 5.1): the ratio is of the box its `box-sizing`
 * names, which is the border box in everything Tailwind writes. Null where
 * it has none, or a height of its own; a replaced box is sized apart.
 */
export function ratioHeight(box: Box): number | null {
  const aspect = box.style.aspectRatio;
  if (!aspect || box.kind === 'replaced') return null;
  if (resolveOrNull(box.style.height, box.percentHeightBase) !== null) {
    return null;
  }
  return box.style.boxSizing === 'border-box'
    ? Math.max(0, box.width / aspect.ratio - box.verticalExtra)
    : Math.max(0, box.contentWidth / aspect.ratio);
}

function finishHeight(box: Box, contentHeight: number): void {
  const set = resolveOrNull(box.style.height, box.percentHeightBase);
  // at least zero: a `calc()` may come to less
  const specified = set === null ? null : Math.max(0, set);
  if (specified === null && box.style.aspectRatio) {
    const ratio = ratioHeight(box);
    if (ratio !== null) {
      // the ratio's height, grown to what the box holds unless it clips it
      // (5.2: the automatic minimum of a box with a ratio is its content)
      const clips =
        box.style.overflowX !== 'visible' || box.style.overflowY !== 'visible';
      contentHeight = clips ? ratio : Math.max(ratio, contentHeight);
    }
  }
  const height = specified ?? contentHeight;
  const borderBox =
    box.style.boxSizing === 'border-box' && specified !== null
      ? Math.max(height, box.verticalExtra)
      : height + box.verticalExtra;
  box.height = clampHeight(box, borderBox);
}

export function clampHeight(box: Box, height: number): number {
  let out = height;
  const base = box.percentHeightBase;
  // a percentage of a height nothing sets is zero for a minimum (CSS 2.1
  // 10.7), which leaves a `calc()` its pixels
  const min =
    box.style.minHeight === AUTO
      ? null
      : resolve(box.style.minHeight, Number.isFinite(base) ? base : 0);
  const max =
    box.style.maxHeight === 'none'
      ? null
      : resolveOrNull(box.style.maxHeight, base);
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
  // what the width and the margins do not add up to goes to the margin at
  // the end: the right one, or in a right-to-left containing block the
  // left one, and a box too wide overflows there (CSS 2.1 10.3.3)
  const rtl = box.parent?.style.direction === 'rtl';
  // an alignment around it places a box its margins do not (HTML's
  // `<center>` and `align`)
  const aligned = leftAuto || rightAuto ? null : box.parent?.style.alignBlocks;
  let left = contentLeft + box.marginLeft;
  if (slack > 0) {
    if (leftAuto && rightAuto) left = contentLeft + slack / 2 + box.marginLeft;
    else if (aligned) {
      if (aligned === 'center') left += slack / 2;
      else if (aligned === 'right') left += slack;
    } else if (leftAuto || (rtl && !rightAuto)) {
      left = contentLeft + slack + box.marginLeft;
    }
  } else if (rtl) {
    left = contentLeft + slack + box.marginLeft;
  }
  box.x = left;
  box.y = y;
}

/** The border-box width of an in-flow block-level box: the room its
 *  margins leave, a length, or an intrinsic size where `ctx` is there to
 *  measure it with. */
function blockWidth(
  box: Box,
  containingWidth: number,
  percentBase = containingWidth,
  ctx?: LayoutContext,
): number {
  const style = box.style;
  const available = containingWidth - box.marginLeft - box.marginRight;
  if (style.width === AUTO) {
    const room = Math.max(0, available);
    const width =
      style.widthKeyword && ctx
        ? contentSizedWidth(box, ctx, style.widthKeyword, room, percentBase)
        : room;
    return clampWidth(box, width, percentBase, ctx);
  }
  // at least zero: a `calc()` may come to less
  const specified = Math.max(0, resolve(style.width, percentBase, 0));
  const borderBox =
    style.boxSizing === 'border-box'
      ? Math.max(specified, box.horizontalExtra)
      : specified + box.horizontalExtra;
  return clampWidth(box, borderBox, percentBase, ctx);
}

/** A width within `min-width` and `max-width` — the minimum winning — the
 *  intrinsic ones among them where `ctx` is there to measure them. */
function clampWidth(
  box: Box,
  width: number,
  containingWidth: number,
  ctx?: LayoutContext,
): number {
  const style = box.style;
  const extra = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
  let out = width;
  const max =
    style.maxWidth === 'none'
      ? null
      : resolveOrNull(style.maxWidth, containingWidth);
  if (max !== null) out = Math.min(out, max + extra);
  const room = (): number =>
    Math.max(0, containingWidth - box.marginLeft - box.marginRight);
  if (style.maxWidthKeyword && ctx) {
    out = Math.min(
      out,
      contentSizedWidth(
        box,
        ctx,
        style.maxWidthKeyword,
        room(),
        containingWidth,
      ),
    );
  }
  const min = resolveOrNull(style.minWidth, containingWidth);
  if (min !== null) out = Math.max(out, min + extra);
  if (style.minWidthKeyword && ctx) {
    out = Math.max(
      out,
      contentSizedWidth(
        box,
        ctx,
        style.minWidthKeyword,
        room(),
        containingWidth,
      ),
    );
  }
  return Math.max(0, out);
}

/**
 * A box's border-box width from an intrinsic size (CSS Sizing 3, 3.1): its
 * max-content width, its min-content width, or `fit-content` — the
 * max-content width where `available` holds it, and `available` where it
 * does not, but never less than the min-content width. Each is measured
 * once a box, as a table cell's are, and by laying the box out on its own,
 * which resolves its edges against nothing: they are resolved again
 * against `percentBase`, as its caller had them.
 */
export function contentSizedWidth(
  box: Box,
  ctx: LayoutContext,
  size: ContentSize,
  available: number,
  percentBase: number,
): number {
  let probed = false;
  if (box.intrinsicMaxContent < 0) {
    box.intrinsicMaxContent = measureIntrinsicWidth(box, ctx, Infinity);
    probed = true;
  }
  if (size !== 'max-content' && box.intrinsicMinContent < 0) {
    box.intrinsicMinContent = measureIntrinsicWidth(box, ctx, 1);
    probed = true;
  }
  if (probed) resolveEdges(box, percentBase);
  const max = box.intrinsicMaxContent;
  if (size === 'max-content') return max;
  const min = box.intrinsicMinContent;
  if (size === 'min-content') return min;
  return Math.min(max, Math.max(min, available));
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
    const specified = Math.max(0, resolve(style.width, available, 0));
    const borderBox =
      style.boxSizing === 'border-box'
        ? Math.max(specified, box.horizontalExtra)
        : specified + box.horizontalExtra;
    return clampWidth(box, borderBox, available, ctx);
  }
  // `fit-content` is what shrink-to-fit is; the other two are not bounded
  // by the room, or not by the longest line
  const keyword = style.widthKeyword;
  if (keyword === 'max-content' || keyword === 'min-content') {
    const width = contentSizedWidth(box, ctx, keyword, available, available);
    return clampWidth(box, width, available, ctx);
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
    ctx,
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
  // a grid laid out at no width limit has its columns at their widest, and
  // is as wide as where its items end
  if (box.style.grid) {
    let right = 0;
    for (const child of box.children) {
      if (child.outOfFlow || child.kind === 'text') continue;
      right = Math.max(
        right,
        child.x - box.contentX + child.width + child.marginRight,
      );
    }
    return right;
  }
  let widest = 0;
  // A row of flex items is as wide as all of them side by side, and gaps
  // between them; any other box is as wide as the widest thing in it
  const display = box.style.display;
  const row =
    (display === 'flex' || display === 'inline-flex') &&
    box.style.flexDirection.startsWith('row');
  let total = 0;
  let items = 0;
  const lines = box.lines;
  if (lines) {
    for (const line of lines) widest = Math.max(widest, line.width);
  }
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.outOfFlow) continue;
    // what sits in the lines is measured with them, indent and all: an
    // inline-block after a negative `text-indent` ends where its line does
    if (lines && isInlineLevel(child)) continue;
    const margins = child.marginLeft + child.marginRight;
    const own = Number.isFinite(child.width) ? child.width + margins : 0;
    const style = child.style;
    // a minimum's percentage is of zero here (CSS Sizing 3 5.2.1), which
    // leaves a `calc()` its pixels
    const min =
      style.minWidth === 0
        ? 0
        : resolve(style.minWidth, 0) + contentExtra(child);
    let contribution: number;
    // A width of its own is what a child contributes, whatever its content
    // does past it (CSS Sizing 3 5.1); a percentage one is cyclic here and
    // counts as `auto`, so its content decides.
    if (typeof style.width === 'number') {
      contribution = Math.max(own, min + margins);
    } else {
      let inner = intrinsicWidth(child) + child.horizontalExtra;
      if (typeof style.maxWidth === 'number') {
        inner = Math.min(inner, style.maxWidth + contentExtra(child));
      }
      if (min > inner) inner = min;
      contribution = Math.max(inner + margins, own);
    }
    if (row) {
      total += contribution;
      items += 1;
    } else widest = Math.max(widest, contribution);
  }
  if (row && items) {
    widest = Math.max(widest, total + box.style.columnGap * (items - 1));
  }
  return widest;
}

/** What a box's own width leaves out of its border box: its padding and
 *  border, unless `box-sizing` puts them in. */
function contentExtra(box: Box): number {
  return box.style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
}

/**
 * A replaced box's size, from its style and what it has of an intrinsic
 * width, height and ratio (CSS 2.1 10.3.2 and 10.6.2), within its minimum
 * and maximum (10.4, 10.7).
 *
 * An image has all three, a frame and a control their default size and no
 * ratio — so the axis the style does not set keeps its own, and a text field
 * `width: 100%` is not stretched to twice its height. An SVG may have any of
 * them: a height and nothing else is 300 pixels wide, a ratio and nothing
 * else fills its containing block, and nothing at all is 300 by 150 — the
 * default object size, which the builder leaves in `Intrinsic` for an axis
 * its `missing` names.
 *
 * A limit applied to one axis carries to the other through the ratio: an
 * image `max-width: 100%` narrower than itself keeps its proportions, where
 * clamping each axis alone squashed it — the `<img width="600">` of every
 * mail template, in a narrow column.
 */
function sizeReplaced(box: Box, containingWidth: number): void {
  const style = box.style;
  const base = box.percentHeightBase;
  // everything below is the content box's; a `border-box` length is not
  const hx = style.boxSizing === 'border-box' ? box.horizontalExtra : 0;
  const vx = style.boxSizing === 'border-box' ? box.verticalExtra : 0;
  const across = (len: Len): number | null => {
    const v = resolveOrNull(len, containingWidth);
    return v === null ? null : Math.max(0, v - hx);
  };
  const down = (len: Len): number | null => {
    const v = resolveOrNull(len, base);
    return v === null ? null : Math.max(0, v - vx);
  };
  const width = across(style.width);
  const height = down(style.height);
  const minW = across(style.minWidth) ?? 0;
  const minH = down(style.minHeight) ?? 0;
  // a maximum below the minimum is the minimum (10.4)
  const maxW = Math.max(
    minW,
    style.maxWidth === 'none' ? Infinity : (across(style.maxWidth) ?? Infinity),
  );
  const maxH = Math.max(
    minH,
    style.maxHeight === 'none' ? Infinity : (down(style.maxHeight) ?? Infinity),
  );
  const own = box.intrinsic ?? NO_INTRINSIC;
  const iw = own.missing & 1 ? null : own.width;
  const ih = own.missing & 2 ? null : own.height;
  // `aspect-ratio` over its own, unless written `auto` and it has one
  const aspect = style.aspectRatio;
  const ratio =
    aspect && !(aspect.auto && own.ratio > 0) ? aspect.ratio : own.ratio;
  // the width a block would have here: what a ratio with no size fills, and
  // an `hr`, whose whole appearance is its border across the line
  const room = (): number => {
    const w =
      containingWidth - box.marginLeft - box.marginRight - box.horizontalExtra;
    return Number.isFinite(w) ? Math.max(0, w) : 0;
  };

  let w: number;
  let h: number;
  if (width === null && height === null && ratio > 0) {
    // both auto, with a ratio: the size it asks for, then the table in 10.4,
    // which moves both axes together
    if (iw !== null) {
      w = iw;
      h = ih ?? iw / ratio;
    } else if (ih !== null) {
      h = ih;
      w = ih * ratio;
    } else {
      // a ratio and no size: CSS 2.1 leaves it undefined and suggests the
      // width a block would have, which is what browsers do — or, where the
      // containing block waits on this box, the default object size
      w = Number.isFinite(containingWidth) ? room() : own.width;
      h = w / ratio;
    }
    [w, h] = constrained(w, h, minW, maxW, minH, maxH);
  } else {
    // one axis set, or no ratio: the width, clamped, and then the height
    // from the width that was used (10.3.2's "the rules above are applied
    // again" for a limit)
    const usedHeight = height === null ? null : clamp(height, minH, maxH);
    if (width !== null) w = width;
    else if (usedHeight !== null && ratio > 0) w = usedHeight * ratio;
    else if (box.replaced === 'hr') w = room();
    else w = own.width;
    w = clamp(w, minW, maxW);
    if (usedHeight !== null) h = usedHeight;
    else if (ratio > 0) h = clamp(w / ratio, minH, maxH);
    else h = clamp(own.height, minH, maxH);
  }
  box.width = w + box.horizontalExtra;
  box.height = h + box.verticalExtra;
}

/** What a replaced box with nothing to say about its size has: `hr`. */
const NO_INTRINSIC: Intrinsic = { width: 0, height: 0, missing: 0, ratio: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * CSS 2.1 10.4's table, for a replaced box sized by its ratio alone: a
 * limit on either axis is met by scaling both, and where the two axes' limits
 * disagree, the one that asks for more change wins.
 */
function constrained(
  w: number,
  h: number,
  minW: number,
  maxW: number,
  minH: number,
  maxH: number,
): [number, number] {
  if (!(w > 0 && h > 0)) return [clamp(w, minW, maxW), clamp(h, minH, maxH)];
  if (w > maxW && h > maxH) {
    return maxW / w <= maxH / h
      ? [maxW, Math.max(minH, (maxW * h) / w)]
      : [Math.max(minW, (maxH * w) / h), maxH];
  }
  if (w < minW && h < minH) {
    return minW / w <= minH / h
      ? [Math.min(maxW, (minH * w) / h), minH]
      : [minW, Math.min(maxH, (minW * h) / w)];
  }
  if (w < minW && h > maxH) return [minW, maxH];
  if (w > maxW && h < minH) return [maxW, minH];
  if (w > maxW) return [maxW, Math.max((maxW * h) / w, minH)];
  if (w < minW) return [minW, Math.min((minW * h) / w, maxH)];
  if (h > maxH) return [Math.max((maxH * w) / h, minW), maxH];
  if (h < minH) return [Math.min((minH * w) / h, maxW), minH];
  return [w, h];
}

/**
 * Place and size a float, and register it with the formatting context.
 *
 * The formatting context holds every float in it, and its band is as wide
 * as its root; a float is placed within its own containing block's content
 * box, which may be narrower (CSS 2.1 9.5.1, rules 1 and 7). Floats placed
 * earlier still push it over wherever they reach into that box. Placed in
 * the formatting context's band, a float in a nested block sat at the
 * root's edge — outside its parent's padding and the body's margin.
 */
function layoutFloat(
  box: Box,
  ctx: LayoutContext,
  floats: FloatContext,
  y: number,
  containingLeft: number,
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
  const left = containingLeft;
  const right = containingLeft + containingWidth;
  const top = floats.placeAt(
    from,
    outerWidth,
    box.style.float === 'right' ? 'right' : 'left',
    left,
    right,
  );
  const band = floats.bandAt(top, 1, left, right);
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
  // the containing block is the positioned box's padding box (CSS 2.1
  // 10.1), not its content box: `left: 0` in a padded box is at its
  // padding edge, and at the viewport's edge where nothing is positioned
  const cbX = containing.x + containing.borderLeft;
  const cbY = containing.y + containing.captionTop + containing.borderTop;
  const cbWidth = Math.max(
    0,
    containing.width - containing.borderLeft - containing.borderRight,
  );
  // with nothing positioned around it the containing block is the initial
  // one, as tall as the viewport rather than as the document (10.1), and a
  // fixed box's is the viewport itself
  const cbHeight = !containing.parent
    ? ctx.viewportHeight
    : Math.max(
        0,
        containing.height -
          containing.captionTop -
          containing.captionBottom -
          containing.borderTop -
          containing.borderBottom,
      );
  resolveEdges(box, cbWidth);
  box.percentHeightBase = cbHeight;

  const style = box.style;
  const left = resolveOrNull(style.left, cbWidth);
  const right = resolveOrNull(style.right, cbWidth);
  const top = resolveOrNull(style.top, cbHeight);
  const bottom = resolveOrNull(style.bottom, cbHeight);

  let width: number;
  if (style.width !== AUTO) {
    width = blockWidth(box, cbWidth, cbWidth, ctx);
  } else if (style.widthKeyword) {
    // an intrinsic size, which both offsets do not stretch
    width = shrinkToFitWidth(box, ctx, cbWidth);
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

  // with neither offset on an axis, the box is where the flow would have
  // put it (CSS 2.1 10.3.7, 10.6.4): against its start edge, which is the
  // right one in a right-to-left flow
  const at = box.staticPosition;
  const rtl = (at?.from ?? containing).style.direction === 'rtl';
  let x: number;
  if (
    left !== null &&
    right !== null &&
    (style.width !== AUTO ||
      style.widthKeyword !== null ||
      box.kind === 'replaced')
  ) {
    // Both offsets and a width: what is left over goes to the margins that
    // are `auto`, shared where both are, and where none is, the end offset
    // gives way (10.3.7, 10.3.8).
    const rest = cbWidth - left - right - box.width;
    const autoLeft = style.marginLeft === AUTO;
    const autoRight = style.marginRight === AUTO;
    const endRtl = containing.style.direction === 'rtl';
    if (autoLeft && autoRight) {
      if (rest >= 0) {
        box.marginLeft = rest / 2;
        box.marginRight = rest / 2;
      } else if (endRtl) {
        box.marginRight = 0;
        box.marginLeft = rest;
      } else {
        box.marginLeft = 0;
        box.marginRight = rest;
      }
    } else if (autoLeft) {
      box.marginLeft = rest - box.marginRight;
    } else if (autoRight) {
      box.marginRight = rest - box.marginLeft;
    }
    x =
      endRtl && !autoLeft && !autoRight
        ? cbX + cbWidth - right - box.width - box.marginRight
        : cbX + left + box.marginLeft;
  } else {
    x =
      left !== null
        ? cbX + left + box.marginLeft
        : right !== null
          ? cbX + cbWidth - right - box.width - box.marginRight
          : rtl
            ? (at ? at.from.x + at.right : cbX + cbWidth) -
              box.width -
              box.marginRight
            : (at ? at.from.x + at.x : cbX) + box.marginLeft;
  }
  let y: number;
  if (top !== null && bottom !== null) {
    if (style.height === AUTO && box.kind !== 'replaced') {
      // both offsets and no height: the box fills what they leave, its
      // `auto` margins nothing (10.6.4, rule 5)
      box.height = clampHeight(
        box,
        Math.max(0, cbHeight - top - bottom - box.marginTop - box.marginBottom),
      );
    } else {
      // and a height: the `auto` margins share the rest, and where none
      // is `auto`, `bottom` gives way (10.6.4, 10.6.5)
      const rest = cbHeight - top - bottom - box.height;
      const autoTop = style.marginTop === AUTO;
      const autoBottom = style.marginBottom === AUTO;
      if (autoTop && autoBottom) {
        box.marginTop = rest / 2;
        box.marginBottom = rest / 2;
      } else if (autoTop) {
        box.marginTop = rest - box.marginBottom;
      } else if (autoBottom) {
        box.marginBottom = rest - box.marginTop;
      }
    }
    y = cbY + top + box.marginTop;
  } else {
    y =
      top !== null
        ? cbY + top + box.marginTop
        : bottom !== null
          ? cbY + cbHeight - bottom - box.height - box.marginBottom
          : (at ? at.from.y + at.y : cbY) + box.marginTop;
  }
  moveTo(box, x, y);
}

/**
 * Lay out the floats in a block's inline content and give its positioned
 * boxes their static positions — at any depth of inline box, which lays
 * nothing out of its own: a float or an absolute box inside a `<span>` is
 * the paragraph's as much as one beside it. Met only among the block's own
 * children, one in an inline box was never laid out at all, and stood at
 * the page's corner with no size.
 */
function placeOutOfLine(
  parent: Box,
  block: Box,
  ctx: LayoutContext,
  floats: FloatContext,
  contentTop: number,
  contentWidth: number,
  contentLeft: number,
): void {
  for (const child of parent.children) {
    if (child.outOfFlow) {
      placeStatic(child, block, contentLeft, contentWidth, contentTop);
      ctx.positioned.push({
        box: child,
        containing: containingBlockFor(child) ?? block,
      });
    } else if (child.isFloat) {
      layoutFloat(child, ctx, floats, contentTop, contentLeft, contentWidth);
    } else if (child.kind === 'inline' && ctx.nestedOutOfLine) {
      placeOutOfLine(
        child,
        block,
        ctx,
        floats,
        contentTop,
        contentWidth,
        contentLeft,
      );
    }
  }
}

/** Where an out-of-flow box would have gone in its parent's flow: its
 *  margin edge's, at either side, kept from the parent's corner, which may
 *  yet move. */
function placeStatic(
  box: Box,
  parent: Box,
  x: number,
  width: number,
  y: number,
): void {
  box.staticPosition = {
    from: parent,
    x: x - parent.x,
    right: x + width - parent.x,
    y: y - parent.y,
  };
}

/** The nearest positioned ancestor, or null for the initial containing
 *  block. Walks the box tree rather than the DOM, so an anonymous box in
 *  between is transparent — which is what the spec means by "the nearest
 *  positioned ancestor". */
function containingBlockFor(box: Box): Box | null {
  // a fixed box's is the viewport, whatever is positioned around it — but
  // a transformed box is one for it too
  const fixed = box.style.position === 'fixed';
  let node = box.parent;
  while (node) {
    if (
      (!fixed && node.style.position !== 'static') ||
      transformed(node.style) ||
      node.parent === null
    ) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

/** Move a box and everything under it, keeping the subtree's shape. */
export function moveTo(box: Box, x: number, y: number): void {
  translate(box, x - box.x, y - box.y);
}

/** Move what a box holds down, and not the box: a table cell's content
 *  sits where its `vertical-align` puts it, in a box that fills the row. */
export function moveContent(box: Box, dy: number): void {
  translate(box, 0, dy);
  box.y -= dy;
}

function translate(box: Box, dx: number, dy: number): void {
  if (!dx && !dy) return;
  box.x += dx;
  box.y += dy;
  // a list item's marker is placed in the same coordinates as its lines
  if (box.marker) {
    box.marker.x += dx;
    box.marker.y += dy;
  }
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
      for (const edge of line.edges ?? []) edge.x += dx;
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
  // at least zero: a `calc()` may come to less
  box.padTop = Math.max(0, edge(style.paddingTop, containingWidth));
  box.padRight = Math.max(0, edge(style.paddingRight, containingWidth));
  box.padBottom = Math.max(0, edge(style.paddingBottom, containingWidth));
  box.padLeft = Math.max(0, edge(style.paddingLeft, containingWidth));
  box.marginTop = edge(style.marginTop, containingWidth);
  box.marginRight = edge(style.marginRight, containingWidth);
  box.marginBottom = edge(style.marginBottom, containingWidth);
  box.marginLeft = edge(style.marginLeft, containingWidth);
  if (box.kind === 'table' || box.kind === 'table-cell') collapseEdges(box);
}

function edge(len: Len, containingWidth: number): number {
  if (len === AUTO) return 0;
  return resolve(len, containingWidth, 0);
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
  if (style.flowRoot) return true;
  if (style.float !== 'none') return true;
  if (style.position === 'absolute' || style.position === 'fixed') return true;
  if (
    style.display === 'inline-block' ||
    style.display === 'flex' ||
    style.display === 'inline-flex'
  ) {
    return true;
  }
  if (
    box.kind === 'table-cell' ||
    box.kind === 'table-caption' ||
    box.kind === 'table'
  ) {
    return true;
  }
  // The root element establishes the document's formatting context. Here it
  // is a box below the synthetic initial containing block, so it is named:
  // without it, <html>'s own margin collapsed with <body>'s first block's.
  if (box.el?.name === 'html') return true;
  return box.parent === null;
}

/** What a box's `position: relative` offset moves it by, applied after
 *  layout so it does not affect anything else's position — which is the
 *  whole of what makes it *relative* — and its translation with it. */
export function applyRelativeOffsets(box: Box): void {
  for (const child of box.children) applyRelativeOffsets(child);
  const style = box.style;
  if (transformed(style) && box.kind !== 'inline') {
    // a transform moves the box it is on, and an inline box is none
    const [dx, dy] = translationOf(box);
    if (dx || dy) translate(box, dx, dy);
  }
  if (style.position !== 'relative' && style.position !== 'sticky') return;
  const [dx, dy] = relativeOffset(box);
  translate(box, dx, dy);
  if (box.kind !== 'inline' || !(dx || dy)) return;
  offsetInline(box, dx, dy);
  // the blocks it was broken around move with it (9.2.1.1)
  const blocks = box.cut ? CUT_BLOCKS.get(box) : undefined;
  if (blocks) for (const block of blocks) translate(block, dx, dy);
}

/** Whether a box is transformed, which is what makes it a containing
 *  block and a layer as a positioned box is (CSS Transforms 1, 2). */
export function transformed(style: ComputedStyle): boolean {
  return style.translate !== null || style.transformTranslate !== null;
}

/** How far `translate` and a `transform` move a box: a percentage is of
 *  its own border box (CSS Transforms 1, 7). */
function translationOf(box: Box): [number, number] {
  let dx = 0;
  let dy = 0;
  for (const moved of [box.style.translate, box.style.transformTranslate]) {
    if (!moved) continue;
    dx += resolve(moved[0], box.width, 0);
    dy += resolve(moved[1], box.height, 0);
  }
  return [dx, dy];
}

/** How far `position: relative` moves a box. */
function relativeOffset(box: Box): [number, number] {
  const style = box.style;
  const parentWidth = box.parent ? box.parent.contentWidth : 0;
  const left = resolveOrNull(style.left, parentWidth);
  const right = resolveOrNull(style.right, parentWidth);
  // a percentage down is of a height the containing block sets, as a
  // percentage height is, and `auto` where its content decides it
  const top = resolveOrNull(style.top, box.percentHeightBase);
  const bottom = resolveOrNull(style.bottom, box.percentHeightBase);
  // both set is over-constrained, and the containing block's direction
  // says which wins: `left` left to right, `right` right to left (9.4.3)
  const rtl = box.parent?.style.direction === 'rtl';
  const dx = right !== null && (left === null || rtl) ? -right : (left ?? 0);
  const dy = top ?? (bottom !== null ? -bottom : 0);
  return [dx, dy];
}

/**
 * Move an inline box's text where `position: relative` puts the box. Its
 * text is on its block's lines, laid out apart from the text around it
 * (`collect`), and those fragments are what move; the lines stay where
 * they are (CSS 2.1 9.4.3). A box inside it has moved its own already, so
 * a text in both moves by the two together.
 */
function offsetInline(box: Box, dx: number, dy: number): void {
  let block = box.parent;
  while (block && block.kind === 'inline') block = block.parent;
  const lines = block?.lines;
  if (!lines) return;
  INLINE_OFFSETS.set(box, { x: dx, y: dy });
  for (const line of lines) {
    for (const text of line.texts) {
      const owner = text.spans.boxAt?.(text.layoutStart);
      if (!owner || !holds(box, owner)) continue;
      text.drawX += dx;
      text.drawY += dy;
      const was = TEXT_SHIFTS.get(text);
      TEXT_SHIFTS.set(text, {
        x: (was?.x ?? 0) + dx,
        y: (was?.y ?? 0) + dy,
      });
      SHIFTED_LINES.add(line);
    }
  }
}

/** Whether `inner` is `outer` or inside it. */
function holds(outer: Box, inner: Box): boolean {
  for (let at: Box | null = inner; at; at = at.parent) {
    if (at === outer) return true;
  }
  return false;
}
