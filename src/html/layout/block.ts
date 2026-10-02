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
import {
  AUTO,
  gapOf,
  isPct,
  isTransparent,
  resolve,
  resolveOrNull,
} from '../css/values.js';
import type { Len } from '../css/values.js';
import type {
  BorderStyle,
  ComputedStyle,
  ContentSize,
  GridLine,
} from '../css/style.js';
import {
  CONTAIN_INLINE_SIZE,
  CONTAIN_LAYOUT,
  CONTAIN_PAINT,
  CONTAIN_SIZE,
  INLINE_BEFORE_ABSOLUTE,
  scrolls,
} from '../css/style.js';
import { about, linearOf, matrixOf, transformed } from '../css/transform.js';
import type { Matrix } from '../css/transform.js';
import { lineOf, spanToName } from './grid-lines.js';
import type { GridLines } from './grid-lines.js';
import {
  columnsOf,
  forgetColumns,
  layoutColumns,
  spansColumns,
} from './multicol.js';
import type { Columns } from './multicol.js';
import {
  BOX_RAISES,
  Box,
  CLAMPED,
  CLEARED_FROM,
  COLUMN_PIECES,
  CUT_BLOCKS,
  GRID_TRACKS,
  FIRST_LINE,
  INLINE_OFFSETS,
  MOVED_OFF_LINES,
  LINE_BOX_RAISES,
  SHIFTED_LINES,
  TEXT_SHIFTS,
  columned,
  isBlank,
} from './boxes.js';
import type {
  BoxTree,
  FirstLineStyler,
  Intrinsic,
  InlineDecoration,
  LineBox,
  MarginStrut,
  Marker,
} from './boxes.js';
import { FloatContext } from './floats.js';
import {
  emptyLinePoint,
  faceExtentOf,
  isButton,
  joinsBefore,
  layoutInline,
  lineHeightMultiplier,
  spaceBreaksOnly,
  strutOf,
  widestWord,
} from './inline.js';
import type { FontsLike, InlineOptions, InlineResult } from './inline.js';
import type { TextRun } from '../../richtext/index.js';
import { layoutFlex } from './flex.js';
import { finishCaptions, givenHeight, layoutTable } from './table.js';
import { collapseEdges } from './collapse.js';
import {
  clipsFor,
  computePaintBounds,
  FIXED_BOXES,
  fixedToViewport,
  hoistNegative,
  OUT_OF_FLOW_REACH,
  stackLayers,
} from '../paint.js';

export interface LayoutContext {
  fonts: FontsLike | null;
  /** Whether any block has a `::first-line` (`BoxTree.firstLine`). */
  firstLine?: boolean;
  /** Each box's style on a first line (`BoxTree.firstLineStyler`). */
  firstLineStyler?: FirstLineStyler | null;
  /** Whether a float or an out-of-flow box is in an inline box
   *  (`BoxTree.nestedOutOfLine`). */
  nestedOutOfLine?: boolean;
  /** Whether any box paints its background through its text
   *  (`BoxTree.clipText`). */
  clipText?: boolean;
  viewportWidth: number;
  viewportHeight: number;
  /** Set once a box is placed against the initial containing block, whose
   *  height is the viewport's (`LayoutResult.readsViewportHeight`). */
  readViewportHeight?: boolean;
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
   *
   * `containing` is the width of the box's containing block where `width`
   * is the box's own, as a flex layout sized it: what the percentages in
   * its padding, its margins and its width limits are of (CSS 2.1 8.3,
   * 8.4, 10.4). Left out, `width` is both — a box probed at the room there
   * is for it. For a table cell it is the width of its row, which its
   * padding's percentages are of, and it says the cell is laid out in its
   * columns: at `width`, whatever its limits say.
   */
  layoutSubtree(box: Box, width: number, containing?: number): void;
  /** How many flex boxes' Yoga passes are running, one inside the last's
   *  measure (`layoutFlex`). */
  flexDepth?: number;
  /** The clamp of the line-clamp container whose formatting context is
   *  being laid out, if any (`layoutInternals`). */
  clamp?: Clamp | null;
}

/**
 * A line-clamp container's clamp, carried through its formatting context as
 * the lines in it are laid out (CSS Overflow 4, 5.2 and 5.3.1). Only the
 * lines of that formatting context count: a box that makes one of its own
 * is laid out with none, and counts as a block.
 */
interface Clamp {
  /** The line-clamp container. */
  box: Box;
  /** How many more lines show before the clamp point. */
  left: number;
  /** Whether the clamp point is passed: every box after it in the flow is
   *  invisible, and takes no room (`CLAMPED`). */
  done: boolean;
  /**
   * For `line-clamp: auto`, whose clamp point is after as many lines as
   * the box's height holds: the first pass lays the content out whole and
   * counts the lines that end above `floor` — the box's content bottom, in
   * document coordinates — with what closes below each. `over` once one
   * does not; null where the lines are cut rather than counted.
   */
  fit: { floor: number; lines: number; over: boolean } | null;
}

export interface LayoutResult {
  width: number;
  height: number;
  /**
   * Whether the layout read the viewport's height: a percentage height on
   * the root element, or a box positioned against the initial containing
   * block. A document that did lays out differently in a viewport of
   * another height, and one that did not — most — lays out the same.
   */
  readsViewportHeight: boolean;
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
    layoutSubtree: (box, width, containing) =>
      layoutSubtree(box, ctx, width, containing),
    firstLine: tree.firstLine,
    firstLineStyler: tree.firstLineStyler,
    nestedOutOfLine: tree.nestedOutOfLine,
    clipText: tree.clipText,
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
  const own = standInHeight(tree, viewportHeight);
  const leading = root.marginTop;
  const trailing = root.marginBottom;
  root.padRight += root.marginRight;
  root.padBottom += root.marginBottom;
  root.padLeft += root.marginLeft;
  root.marginTop = 0;
  root.marginRight = 0;
  root.marginBottom = 0;
  root.marginLeft = 0;
  if (own) handPercentBase(root, own.inner);

  const contentWidth = Math.max(0, viewportWidth - root.horizontalExtra);
  const floats = new FloatContext(root.contentX, root.contentX + contentWidth);
  // the initial containing block is the viewport's size, which a percentage
  // height on the root element resolves against (CSS 2.1 10.1, 10.5); a
  // fragment has no root element, and the box standing in for its body has
  // the body's `auto` height to give, and a root box standing in for the
  // root element took its height of the viewport above
  let readsViewportHeight = own?.viewport === true;
  for (const child of root.children) {
    if (child.el?.name !== 'html') continue;
    child.percentHeightBase = viewportHeight;
    if (readsPercentHeight(child.style)) readsViewportHeight = true;
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
  root.height = own
    ? leading + own.outer + trailing
    : Math.max(flow.height, floatBottom) + root.verticalExtra;

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
  if (tree.relative) applyRelativeOffsets(root, viewportWidth, viewportHeight);
  const reach = computePaintBounds(root, tree.movedInline);
  if (tree.negative) hoistNegative(root);
  stackLayers(root);

  // The document is as tall as what overflows the root, not the root: an
  // `html, body { height: 100% }` a window tall holds a message longer than
  // the window, and the element sizes to all of it. Not what a box that
  // clips its overflow holds: that is its own to scroll, and the root's
  // scrollable overflow takes in a positioned box only where no box on the
  // way to it clips it (CSS Overflow 3, 2.2): an absolute box 900px down
  // an `overflow: hidden` card made a page a browser shows 400px tall run
  // on to 980, blank
  let bottom = Math.max(root.height, reach);
  let fixed: Box[] | null = null;
  for (const { box } of ctx.positioned) {
    if (box.style.position === 'fixed') {
      if (fixedToViewport(box)) (fixed ??= []).push(box);
      continue;
    }
    if (clipsFor(box, root).length) continue;
    // and what it holds, where it does not clip it: a page set in an
    // absolute wrapper 497px tall runs on below it, and the document with
    // it — design 094 was a window tall and no taller, its text past the
    // end of the scroll
    bottom = Math.max(bottom, OUT_OF_FLOW_REACH.get(box) ?? box.y + box.height);
  }
  if (fixed) FIXED_BOXES.set(tree, fixed);
  else FIXED_BOXES.delete(tree);
  return {
    width: viewportWidth,
    height: bottom,
    readsViewportHeight: readsViewportHeight || ctx.readViewportHeight === true,
  };
}

/**
 * How tall the element the root box stands in for says it is, where that
 * is definite (CSS 2.1 10.5). A fragment's root box stands in for its
 * body: a length, `100vh` among them, or a percentage of the `<html>`
 * implied around it where that has a height of its own — a length, or a
 * percentage of the viewport, as `html, body { height: 100% }` fills a
 * window. A document with a `<body>` and no `<html>` has it standing in
 * for the `<html>` implied around the body, which is the root element:
 * its percentages are of the viewport (10.1), as an `<html>` written in
 * the markup has them. Its border box, and its content box, which what it
 * holds takes its percentages of; `viewport` where the answer read the
 * viewport's height. Null where the document has an `<html>` of its own,
 * and where the height is `auto`, and the box is as tall as what is in
 * it. Measured before its margins are folded into its padding.
 */
function standInHeight(
  tree: BoxTree,
  viewportHeight: number,
): { outer: number; inner: number; viewport: boolean } | null {
  const html = tree.impliedHtml;
  if (!html && !tree.impliedRoot) return null;
  const root = tree.root;
  const style = root.style;
  const base = html
    ? resolveOrNull(html.height, viewportHeight)
    : viewportHeight;
  const set = resolveOrNull(style.height, base ?? NaN);
  if (set === null) return null;
  root.percentHeightBase = base ?? NaN;
  const extra = root.verticalExtra;
  const outer = clampHeight(
    root,
    style.boxSizing === 'border-box' ? Math.max(set, extra) : set + extra,
  );
  return {
    outer,
    inner: Math.max(0, outer - extra),
    viewport: readsPercentHeight(style) && (!html || isPct(html.height)),
  };
}

/** Whether a box's height, or a limit on it, is a percentage. */
function readsPercentHeight(style: ComputedStyle): boolean {
  const { height, minHeight, maxHeight } = style;
  return (
    isPct(height) ||
    isPct(minHeight) ||
    (maxHeight !== 'none' && isPct(maxHeight))
  );
}

/** No margin at all, shared: most joins leave a strut as it was. */
const NO_MARGIN: MarginStrut = Object.freeze({ pos: 0, neg: 0 });

/** One margin, as a strut to collapse others with. */
function marginStrut(margin: number): MarginStrut {
  if (margin > 0) return { pos: margin, neg: 0 };
  if (margin < 0) return { pos: 0, neg: margin };
  return NO_MARGIN;
}

/**
 * A strut with one more margin collapsed into it: the largest positive
 * and the most negative stay apart, and add up only where the margin is
 * read (`marginOf`) — CSS 8.3.1's rule, whole. A `-8px` pull still works
 * against a `40px` push and comes out at `32`, and a third margin after
 * them collapses with the two, not with their sum.
 */
function join(strut: MarginStrut, margin: number): MarginStrut {
  if (margin > strut.pos) return { pos: margin, neg: strut.neg };
  if (margin < strut.neg) return { pos: strut.pos, neg: margin };
  return strut;
}

/** Two sets of adjoining margins collapsed into one. */
function joinStruts(a: MarginStrut, b: MarginStrut): MarginStrut {
  if (b.pos <= a.pos && b.neg >= a.neg) return a;
  if (a.pos <= b.pos && a.neg >= b.neg) return b;
  return { pos: Math.max(a.pos, b.pos), neg: Math.min(a.neg, b.neg) };
}

/** The margin a strut comes to. */
function marginOf(strut: MarginStrut): number {
  return strut.pos + strut.neg;
}

/** A box's bottom margin as the next sibling's collapses with it, with
 *  what came out through its bottom edge where anything did. */
function bottomOf(box: Box): MarginStrut {
  return box.bottomStrut ?? marginStrut(box.marginBottom);
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
function collapsedTopMargin(
  box: Box,
  containingWidth: number,
  floats: FloatContext | null = null,
  y = 0,
  pending: MarginStrut = NO_MARGIN,
): MarginStrut {
  floatsPassed = false;
  floatsLeft = 0;
  floatsRight = 0;
  passedLeft = false;
  passedRight = false;
  walkFloats = floats;
  walkY = y;
  walkPending = pending;
  return absorbChildren(box, containingWidth, marginStrut(box.marginTop));
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
/** Which sides the floats the walk passed are on. */
let passedLeft = false;
let passedRight = false;
/** Where the margin the walk collapses starts, and the floats placed before
 *  it: what says whether a cleared child in it has clearance. */
let walkFloats: FloatContext | null = null;
let walkY = 0;
let walkPending: MarginStrut = NO_MARGIN;

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
function absorbChildren(
  at: Box,
  width: number,
  margin: MarginStrut,
): MarginStrut {
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
    resolveEdges(child, inner);
    /** The margin that collapses up through the child's top edge, where
     *  it had to be worked out before the child was taken. */
    let through: MarginStrut | null = null;
    if (child.style.clear !== 'none') {
      // Where it would be with `clear: none` is where its top margin and
      // every one that comes up through its top edge put it: a large
      // margin inside it takes it past the floats as surely as its own
      // (CSS 2.1 9.5.2). The walk into it is undone where it has
      // clearance, which it passes no float for.
      const passed = passedFloats(child.style.clear);
      const walked = passed ? null : saveWalk();
      if (!passed) {
        through = absorbChildren(child, inner, join(margin, child.marginTop));
      }
      if (passed || hasClearance(child, through!)) {
        if (walked) restoreWalk(walked);
        child.topAbsorbed = 0;
        whole = false;
        break;
      }
    }
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
    margin =
      through ?? absorbChildren(child, inner, join(margin, child.marginTop));
    if (!throughAll || !bottomOpen(child)) {
      child.topAbsorbed = 1;
      whole = false;
      break;
    }
    child.topAbsorbed = 2;
    margin = join(margin, child.marginBottom);
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
 *  border, padding or height there — nor a height its ratio gives it from
 *  its width — and no marker to stand a line tall. A percentage says no,
 *  whatever it resolves to. */
function bottomOpen(box: Box): boolean {
  const { height, minHeight, aspectRatio } = box.style;
  return (
    box.borderBottom === 0 &&
    box.padBottom === 0 &&
    !box.marker &&
    (height === 0 ||
      (height === AUTO &&
        !aspectRatio &&
        box.style.heightKeyword !== 'stretch')) &&
    (minHeight === AUTO || minHeight === 0) &&
    box.style.minHeightKeyword !== 'stretch'
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
    passedRight = true;
  } else {
    floatsLeft += statedOuterWidth(float, width);
    passedLeft = true;
  }
}

/** Whether the walk passed a float that a `clear` clears, which the margin
 *  carries down with it: a child that clears one has clearance whatever
 *  its margin is. */
function passedFloats(clear: Box['style']['clear']): boolean {
  return (
    ((clear === 'left' || clear === 'both') && passedLeft) ||
    ((clear === 'right' || clear === 'both') && passedRight)
  );
}

/**
 * Whether a cleared child in the margin the walk collapses has clearance
 * from a float placed before the walk, which parts it from that margin
 * (CSS 2.1 9.5.2): where `through`, the margin that collapses up through
 * its top edge, does not take it below the float already. A child with none
 * is like any other, and the margin goes on up through it: stopped there, a
 * large margin under a float was spent inside its parent, whose background
 * showed above it.
 */
function hasClearance(child: Box, through: MarginStrut): boolean {
  if (!walkFloats) return true;
  const floor = walkFloats.clearance(child.style.clear);
  if (floor === -Infinity) return false;
  return walkY + marginOf(joinStruts(walkPending, through)) < floor;
}

/** What the walk has passed, to be put back where a look ahead into a
 *  child is undone. */
function saveWalk(): [boolean, number, number, boolean, boolean] {
  return [floatsPassed, floatsLeft, floatsRight, passedLeft, passedRight];
}

function restoreWalk([passed, left, right, onLeft, onRight]: ReturnType<
  typeof saveWalk
>): void {
  floatsPassed = passed;
  floatsLeft = left;
  floatsRight = right;
  passedLeft = onLeft;
  passedRight = onRight;
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

/** What a box's children came to: their height, and the margin still hanging
 *  past the last of them when the box's own bottom edge does not stop it. */
interface FlowResult {
  height: number;
  hanging: MarginStrut;
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
    return { height: height + leading, hanging: NO_MARGIN };
  }

  let y = contentTop;
  /** The margin left hanging by the previous sibling — or, before the first
   *  child, the one `leading` hands down — for collapsing. */
  let pendingMargin = marginStrut(leading);
  /** How many floats were placed before this box's content began, while
   *  nothing has yet fixed where the content is: a margin that collapses
   *  up through its top edge would take the ones placed since down with
   *  it (`clearanceSince`). Infinity once a child in flow has fixed it,
   *  and from the start where a border, padding or a formatting context
   *  of its own does. */
  let openFloats = topOpen(box) ? floats.count : Infinity;
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
  let afterClear = NO_MARGIN;
  /** The cleared block's own top margin: its top border edge is that far
   *  inside the margin its margins and the ones after it collapse to. */
  let clearTop = 0;
  // this box's first formatted line is its first child's in flow (CSS 2.1
  // 5.12.1), which its `::first-line` is handed to
  let firstLine = ctx.firstLine ? firstLineOf(box) : null;
  // and the room a list item's marker takes on it (`MARKER_ROOM`): an
  // inside marker's is handed down to the line it is on, and an outside
  // one's is room above the baseline of the first child that has a line,
  // which goes lower where the marker reaches higher (`MARKER_ASCENT`)
  let pushed = MARKER_ASCENT.get(box) ?? null;
  let marked = pushed === null ? (MARKER_ROOM.get(box) ?? null) : null;
  const clamp = ctx.clamp ?? null;

  for (const child of box.children) {
    if (child.kind === 'text' && isBlank(child.text)) continue;
    // Past a line-clamp container's clamp point, a box in flow or floating
    // is invisible and takes no room (CSS Overflow 4, 5.3.1); a positioned
    // box keeps its place, invisible only where its containing block is.
    if (clamp !== null && !child.outOfFlow) {
      if (clamp.done) {
        hideClamped(child);
        continue;
      }
      CLAMPED.delete(child);
    }
    if (firstLine && !child.outOfFlow && !child.isFloat) {
      if (!FIRST_LINE.has(child)) HANDED.set(child, firstLine);
      firstLine = null;
    }
    if (marked && !child.outOfFlow && !child.isFloat) {
      MARKER_ROOM.set(child, marked);
      marked = null;
    }
    if (child.outOfFlow) {
      const top = y + marginOf(pendingMargin);
      if (INLINE_BEFORE_ABSOLUTE.has(child.style)) {
        // one that was inline-level is on a line of its own, beside the
        // floats there, where the line's alignment puts what it holds
        const band = floats.bandAt(
          top,
          1,
          contentLeft,
          contentLeft + contentWidth,
        );
        const at = emptyLinePoint(box.style, band.left, band.right);
        placeStatic(child, box, at, 0, top);
      } else placeStatic(child, box, contentLeft, contentWidth, top);
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
        y + marginOf(pendingMargin),
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
    const top = absorbed
      ? NO_MARGIN
      : collapsedTopMargin(child, contentWidth, floats, y, pendingMargin);
    const collapsed = joinStruts(pendingMargin, top);
    // After an empty block cleared past a float, what collapses with its
    // margins is placed from its top border edge, less its own top
    // margin, which is above that edge: the depth the margin they make
    // reaches below it (CSS 2.1 8.3.1), as the box's bottom is below it
    // where the block is the last in it
    const at: number = cleared
      ? y + Math.max(0, marginOf(joinStruts(afterClear, top)) - clearTop)
      : y + marginOf(collapsed);
    let childY = at;
    const clear = child.style.clear;
    const clearance = floats.clearance(clear);
    if (clearance > -Infinity) {
      // A float placed before anything fixed where this box's content is
      // goes down with the margin where `clear` is none, so the child is
      // never below it there: it has clearance, and its border edge goes
      // under the floats whatever its margin is, which may take it back
      // up (CSS 2.1 9.5.2, as the browsers read it). A margin under a
      // float in an empty block put a block that cleared it the margin
      // below the float, and its parent's background showed between.
      // And one the walk that placed this box reached through every child
      // before it, and stopped at for its clearance, has it too: where
      // it would have been with `clear: none`, its margin collapsed up
      // through this box's top, is above the floats, so its border edge
      // goes under them, and its own margin, held apart there, may not
      // take it lower. The clearance is negative then.
      if (
        (openFloats !== Infinity &&
          floats.clearanceSince(clear, openFloats) > -Infinity) ||
        (child.topAbsorbed === 0 && (open ?? topOpen(box)))
      ) {
        childY = clearance;
      } else if (clearance > childY) childY = clearance;
    }

    const counted = clamp?.fit?.lines ?? 0;
    const floatMark = floats.count;
    if (
      !floats.isEmpty &&
      (child.kind === 'replaced' || establishesBFC(child))
    ) {
      layoutBesideFloats(child, ctx, floats, contentLeft, childY, contentWidth);
    } else {
      layoutBlockLevel(child, ctx, floats, contentLeft, childY, contentWidth);
    }
    if (pushed !== null) {
      const line = firstLineIn(child);
      if (line) {
        const push = pushed - (line.y + line.baseline - child.y);
        if (push > 0) {
          translate(child, 0, push);
          floats.moveSince(floatMark, push);
        }
        pushed = null;
      }
    }
    // a block with none of the flow's lines in it — an image, a box of a
    // formatting context of its own — puts the clamp point of an `auto`
    // clamp before it where it ends below the room
    const fit = clamp?.fit;
    if (fit && !fit.over && fit.lines === counted) {
      const bottom =
        child.y +
        child.height -
        child.padBottom -
        child.borderBottom +
        closingBelow(child, clamp!.box);
      if (bottom > fit.floor) fit.over = true;
    }
    first = false;
    const moved = childY !== at;
    if (moved) CLEARED_FROM.set(child, at);
    else CLEARED_FROM.delete(child);
    if (!moved && collapsesThrough(child)) {
      // nothing in it parts its margins: they and the ones either side of
      // it are one (CSS 2.1 8.3.1), still hanging for what comes next —
      // or, where the walk took them all into this box's top margin, spent
      if (absorbed === 2) {
        pendingMargin = collapsed;
        continue;
      }
      open = false;
      pendingMargin = joinStruts(collapsed, bottomOf(child));
      if (cleared) {
        afterClear = joinStruts(joinStruts(afterClear, top), bottomOf(child));
      }
      continue;
    }
    open = false;
    y = child.y + child.height;
    pendingMargin = bottomOf(child);
    openFloats = Infinity;
    // cleared, and empty: its margins collapse together, and what follows
    // collapses with them, a top margin that has clearance (CSS 2.1 8.3.1)
    cleared = moved && collapsesThrough(child);
    afterClear = cleared ? joinStruts(top, bottomOf(child)) : NO_MARGIN;
    clearTop = cleared ? marginOf(top) : 0;
  }

  // The last child's bottom margin collapses through the parent's bottom
  // edge unless a border, padding, a specified height or a formatting
  // context of its own stops it — which is why a `<div>` around a `<p>` is
  // not 16px taller than the paragraph. The margin is not *lost*, though: it
  // escapes, and the caller merges it into the box's own bottom margin so
  // the next sibling still sees it. Dropping it here was the bug that made
  // `<div><p>…</p></div><p>…</p>` set the two paragraphs solid.
  // A percentage of a height that depends on content computes to `auto`
  // (CSS 2.1 10.5), and lets it through as `auto` does: a `height: 100%`
  // wrapper in an `auto` body kept its last child's margin inside it
  if (
    !first &&
    !cleared &&
    !box.borderBottom &&
    !box.padBottom &&
    specifiedHeight(box) === null &&
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
    return { height, hanging: parted ? NO_MARGIN : pendingMargin };
  }
  // The cleared block's top border edge is where it would be with a border
  // at its bottom, its top margin's depth inside the margin they all make:
  // the box ends where that margin does, below the edge by what exceeds
  // the top margin (8.3.1, 10.6.3)
  if (cleared) {
    return {
      height: y + Math.max(0, marginOf(afterClear) - clearTop) - contentTop,
      hanging: NO_MARGIN,
    };
  }
  return {
    height: y + marginOf(pendingMargin) - contentTop,
    hanging: NO_MARGIN,
  };
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
      // its border box, from its top: its margins may overlap a float, and
      // a negative top margin takes the box up past one it then meets
      const over = floats.bandAt(
        at,
        box.height,
        reachLeft,
        reachRight,
        !inRoom,
      );
      if (over.left > band.left + 0.5 || over.right < band.right - 0.5) {
        band = over;
        continue;
      }
      // Where no float narrows the room on either side, the box is where
      // it would be were there none, and one too wide for its containing
      // block overflows it here: below the floats it would be the same box
      // in the same room. Blink tests a fit only against a side a float is
      // on (`can_expand_outside_opportunity`, BlockLayoutAlgorithm::
      // LayoutNewFormattingContext). Design 209's 247px heading, which
      // clips its overflow, in a 240px column beside a float that ends
      // left of the column, went under the float, 555px down.
      if (lo === -Infinity && hi === Infinity) fits = true;
      // What is too wide overflows at the end of the line, as far as a
      // negative margin there takes it, but no further into a float or
      // past the room; at the start it would run into the floats, and
      // waits below them (the suite's floats-wrap-bfc-with-margin tests)
      else if (inRoom) {
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
    // under the float it meets, which may start below its top
    const below = floats.nextEdgeBelow(at, Math.max(1, box.height));
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
  // Where a float narrows the containing block's room on either side, a
  // negative margin takes the box no further out than the containing
  // block's edge, as every engine has it; where none does, the margins
  // are the containing block's in full. The suite's
  // floats-wrap-bfc-with-margin-006 to -009 propose otherwise, and pass in
  // no browser.
  const beside = lo > left || hi < right;
  const ml = beside ? Math.max(0, box.marginLeft) : box.marginLeft;
  const mr = beside ? Math.max(0, box.marginRight) : box.marginRight;
  return [Math.max(left + ml, lo), Math.min(right - mr, hi)];
}

function layoutInlineContent(
  box: Box,
  ctx: LayoutContext,
  floats: FloatContext,
  contentTop: number,
  contentWidth: number,
  contentLeft: number,
): number {
  // a line-clamp container whose clamp point is at its start shows none of
  // its own lines
  const clamp = ctx.clamp ?? null;
  if (clamp !== null && (clamp.done || clamp.left <= 0)) {
    box.lines = [];
    box.floatRow = 0;
    return 0;
  }
  // An absolute box's static position is the block's; a float is placed
  // on the line it is on, as the lines reach it (`floatBoxes`).
  const floated = placeOutOfLine(
    box,
    box,
    ctx,
    contentTop,
    contentWidth,
    contentLeft,
  );
  // Atomics have to be sized before the line breaker can place them.
  sizeAtomics(box, ctx, contentWidth);

  const options = {
    fonts: ctx.fonts,
    width: contentWidth,
    startY: contentTop,
    floats,
    originX: contentLeft,
    clipText: ctx.clipText,
    firstStrut: MARKER_ROOM.get(box),
    floatBoxes: floated
      ? {
          size: (child: Box) => sizeFloat(child, ctx, contentWidth),
          place: (child: Box, y: number) =>
            placeFloat(child, floats, y, contentLeft, contentWidth),
        }
      : undefined,
    // the lines the clamp leaves, where it cuts rather than counts
    clamp:
      clamp !== null && clamp.fit === null && clamp.left !== Infinity
        ? {
            lines: clamp.left,
            ellipsis: box.style.blockEllipsis,
            follows: followsInFlow(box, clamp.box),
          }
        : undefined,
  };
  const firstLine = ctx.firstLine ? firstLineOf(box) : null;
  // A `::first-line` that sets the line's fonts moves where it breaks, so
  // the line is found in them (`InlineOptions.firstLineStyle`); its text
  // takes the pseudo-element's colour there too
  const restyled =
    firstLine && ctx.firstLineStyler && setsFonts(firstLine, box.style)
      ? { style: firstLine, styler: ctx.firstLineStyler }
      : undefined;
  let result = layoutInline(
    box,
    restyled ? { ...options, firstLineStyle: restyled } : options,
  );
  if (
    firstLine &&
    !restyled &&
    firstLine.color !== box.style.color &&
    result.lines.length
  ) {
    // the first line's text in its `::first-line` colour, laid out again
    // with its runs cut where the line ends (CSS 2.1 5.12.1), beside the
    // floats the first pass placed — and measured with them
    const placed = result;
    result = layoutInline(box, {
      ...options,
      floatBoxes: undefined,
      firstLine: {
        color: firstLine.color,
        from: box.style.color,
        end: result.lines[0].textEnd,
      },
    });
    if (placed.lines.length === result.lines.length) {
      placed.lines.forEach((line, i) => {
        if (line.floats) result.lines[i].floats = line.floats;
      });
    }
    result.floatRow = placed.floatRow;
  }
  box.floatRow = result.floatRow ?? 0;
  if (clamp !== null) countLines(clamp, box, result, contentTop, options.clamp);
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

/**
 * A block's lines, counted against the clamp: the ones left, or for an
 * `auto` clamp's first pass, the ones that end above its floor. The clamp
 * point is passed where they were cut, or where they were all the lines
 * left and more of the container follows them.
 */
function countLines(
  clamp: Clamp,
  box: Box,
  result: InlineResult,
  contentTop: number,
  cut: InlineOptions['clamp'],
): void {
  const fit = clamp.fit;
  if (fit !== null) {
    if (fit.over) return;
    const below = closingBelow(box, clamp.box);
    for (const line of result.lines) {
      if (contentTop + line.y + line.height + below > fit.floor) {
        fit.over = true;
        return;
      }
      fit.lines += 1;
    }
    return;
  }
  clamp.left -= result.lines.length;
  if (result.cut || (clamp.left <= 0 && cut?.follows)) clamp.done = true;
}

/** Mark a box past a clamp point, and take from everything in it the lines
 *  a layout before gave it: a hidden box is not laid out, and nothing —
 *  a selection, a caret — may find text in it where it stood. */
function hideClamped(box: Box): void {
  CLAMPED.add(box);
  const stack = [box];
  while (stack.length) {
    const at = stack.pop()!;
    at.lines = null;
    for (const child of at.children) stack.push(child);
  }
}

/**
 * How far below a box's content a line-clamp container's content ends,
 * where the clamp point is just after it: the bottom padding, border and
 * margin of the box and of each block around it in the container, the
 * margins collapsed where nothing parts them.
 */
function closingBelow(box: Box, container: Box): number {
  let below = 0;
  let margin = 0;
  for (let at: Box | null = box; at && at !== container; at = at.parent) {
    const edge = at.padBottom + at.borderBottom;
    if (edge) {
      below += margin + edge;
      margin = 0;
    }
    margin = Math.max(margin, at.marginBottom);
  }
  return below + margin;
}

/**
 * Whether anything in flow follows a block in a line-clamp container — a
 * block after it, or after a block around it. Then a clamp point is just
 * after its last line, which ends in an ellipsis (CSS Overflow 4, 4.2);
 * where nothing does, the lines end where the content does.
 */
function followsInFlow(box: Box, container: Box): boolean {
  for (let at = box; at !== container && at.parent; at = at.parent) {
    const siblings = at.parent.children;
    for (let i = siblings.indexOf(at) + 1; i < siblings.length; i += 1) {
      const next = siblings[i];
      if (next.outOfFlow || next.isFloat || makesNothing(next)) continue;
      return true;
    }
  }
  return false;
}

/** Whether a box in flow makes neither a line nor a height of its own: a
 *  block of phantom lines — the rest of an inline box a block broke — with
 *  no edge or height to part it, which puts no clamp point after the line
 *  before it. */
function makesNothing(box: Box): boolean {
  if (box.kind === 'text') return makesNoLine(box);
  if (box.kind === 'inline') return phantom(box) !== 0;
  if (box.kind !== 'block' || establishesBFC(box)) return false;
  const style = box.style;
  if (
    style.height !== AUTO ||
    style.minHeight !== AUTO ||
    !noLength(style.paddingTop) ||
    !noLength(style.paddingBottom) ||
    hasBorder(style.borderTopStyle, style.borderTopWidth) ||
    hasBorder(style.borderBottomStyle, style.borderBottomWidth)
  ) {
    return false;
  }
  for (const child of box.children) {
    if (child.outOfFlow || child.isFloat) continue;
    if (!makesNothing(child)) return false;
  }
  return true;
}

/** Whether a `::first-line` style sets its line's text otherwise than its
 *  block's: in another face, size or line height, spaced apart, or in
 *  capitals. */
function setsFonts(line: ComputedStyle, block: ComputedStyle): boolean {
  return (
    line.fontFamily !== block.fontFamily ||
    line.fontSize !== block.fontSize ||
    line.fontWeight !== block.fontWeight ||
    line.fontStyle !== block.fontStyle ||
    line.fontStretch !== block.fontStretch ||
    line.lineHeight !== block.lineHeight ||
    line.lineHeightIsLength !== block.lineHeightIsLength ||
    line.letterSpacing !== block.letterSpacing ||
    line.fontVariantCaps !== block.fontVariantCaps ||
    line.fontVariantNumeric !== block.fontVariantNumeric ||
    line.fontVariantLigatures !== block.fontVariantLigatures ||
    line.fontVariantPosition !== block.fontVariantPosition ||
    line.fontKerning !== block.fontKerning ||
    line.fontFeatureSettings !== block.fontFeatureSettings ||
    line.textTransform !== block.textTransform
  );
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
  layoutOwn(box, ctx, width);
}

/**
 * Lay out a box that sizes itself — a float, an inline-block, an absolute
 * box — at its own width, where nothing outside it reaches in: or, where
 * this pass has already laid it out at that width with the same edges,
 * leave it as it was and move it back to where a layout puts it.
 *
 * Measuring a box's content lays its content out, and so a float in a
 * float was laid out twice a level — as its parent measured, and as its
 * parent was laid out at the width it measured — and a hundred of them,
 * the markup of a broken page, never finished. What a caller does to the
 * box after its layout is move it, and stretch its height, which is put
 * back; its own, and its content's, are the layout's.
 */
function layoutOwn(box: Box, ctx: LayoutContext, width: number): void {
  const laid = LAID_OWN.get(box);
  if (
    laid !== undefined &&
    laid.ctx === ctx &&
    // and nothing, a probe of its content, has laid it out since
    laid.serial === box.layoutSerial &&
    laid.width === width &&
    // NaN where no height is a base, which `===` would never find again
    Object.is(laid.base, box.percentHeightBase) &&
    laid.padTop === box.padTop &&
    laid.padRight === box.padRight &&
    laid.padBottom === box.padBottom &&
    laid.padLeft === box.padLeft &&
    // and was put somewhere it can be moved back from: a right float in a
    // content measured at no width limit stands at an infinite x, and
    // moved back by it, came out at NaN
    Number.isFinite(box.x) &&
    Number.isFinite(box.y)
  ) {
    box.height = laid.height;
    moveTo(box, 0, 0);
    return;
  }
  layoutInternals(box, ctx, width, 0, 0);
  LAID_OWN.set(box, {
    ctx,
    serial: box.layoutSerial,
    width,
    base: box.percentHeightBase,
    padTop: box.padTop,
    padRight: box.padRight,
    padBottom: box.padBottom,
    padLeft: box.padLeft,
    height: box.height,
  });
}

/** Every box's layout counted, for `Box.layoutSerial`. */
let layoutSerial = 0;

/**
 * Whether a box's layout is one this pass made at `width`, with the same
 * edges and the same height to take percentages of, and nothing has laid
 * it out since (`keep`): what a table in a table in a table is asked for
 * again at every level, and at the same width each time. Its height is put
 * back, where a caller may have stretched it; where it stands is the
 * caller's to move it to.
 */
function kept(box: Box, ctx: LayoutContext, width: number): boolean {
  const laid = LAID_OWN.get(box);
  if (
    laid === undefined ||
    laid.ctx !== ctx ||
    laid.serial !== box.layoutSerial ||
    laid.width !== width ||
    !Object.is(laid.base, box.percentHeightBase) ||
    laid.padTop !== box.padTop ||
    laid.padRight !== box.padRight ||
    laid.padBottom !== box.padBottom ||
    laid.padLeft !== box.padLeft ||
    !Number.isFinite(box.x) ||
    !Number.isFinite(box.y)
  ) {
    return false;
  }
  box.height = laid.height;
  return true;
}

/** Note the layout a box was just given, at `width`, for `kept`. */
function keep(box: Box, ctx: LayoutContext, width: number): void {
  LAID_OWN.set(box, {
    ctx,
    serial: box.layoutSerial,
    width,
    base: box.percentHeightBase,
    padTop: box.padTop,
    padRight: box.padRight,
    padBottom: box.padBottom,
    padLeft: box.padLeft,
    height: box.height,
  });
}

/** What `layoutOwn` laid each box out at, and in which pass. */
const LAID_OWN = new WeakMap<
  Box,
  {
    ctx: LayoutContext;
    serial: number;
    width: number;
    base: number;
    padTop: number;
    padRight: number;
    padBottom: number;
    padLeft: number;
    height: number;
  }
>();

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
    sizeReplaced(box, percentBase, containingWidth);
    placeBlock(box, contentLeft, y, containingWidth);
    return;
  }

  const width = blockWidth(box, containingWidth, percentBase, ctx);
  if (box.kind === 'table' && kept(box, ctx, width)) {
    // laid out at this width earlier in the pass, and not since: put where
    // a layout would put it, and moved there whole
    const laid = box.width;
    const x = box.x;
    const top = box.y;
    box.width = width;
    placeBlock(box, contentLeft, y, containingWidth);
    if (laid !== width && Number.isFinite(containingWidth)) {
      box.width = laid;
      placeBlock(box, contentLeft, y, containingWidth);
    }
    box.width = laid;
    const to = { x: box.x, y: box.y };
    box.x = x;
    box.y = top;
    moveTo(box, to.x, to.y);
    return;
  }
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
  if (box.kind === 'table') keep(box, ctx, width);
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
 * The width a min-content probe lays a box out at: none at all. Every line
 * breaks at every opportunity there, and the widest is the longest word —
 * which is what both text engines answer at zero; react-x11's CoreText
 * engine answers it at zero only, and at a pixel breaks inside words, so a
 * probe a pixel wide gave every table cell on macOS a min-content a
 * character or two wide.
 */
export const MIN_CONTENT_PROBE = 0;

/**
 * Lay a box out at a width and report the widest thing it drew.
 *
 * This is what a table column asks twice — once unbounded for max-content,
 * once at a hair's width for min-content — and it exists rather than the
 * caller reading `box.width` because a `width: auto` box laid out unbounded
 * *is* unbounded: it fills its containing block, and its containing block was
 * `Infinity`. The answer has to come from what the content came to, which is
 * exactly what `intrinsicWidth` walks.
 *
 * A box with a width of its own answers with it, as its contribution to
 * whatever is sizing it — unless `content` asks for what the content
 * alone came to, which is how a table cell's is taken: its `width` is
 * weighed apart, and answered with the width the probe laid it out at,
 * a cell set to 10% measured no wider than its padding.
 */
export function measureIntrinsicWidth(
  box: Box,
  ctx: LayoutContext,
  available: number,
  content = false,
): number {
  // not through `ctx.layoutSubtree`, which is this and one frame more on
  // the stack for every level of a document that measures what it holds
  // (`layoutTable`)
  layoutSubtree(box, ctx, available, undefined, true);
  const specified = box.style.width;
  if (!content && specified !== AUTO && Number.isFinite(box.width)) {
    return box.width;
  }
  return (
    intrinsicWidth(box, undefined, available === MIN_CONTENT_PROBE) +
    box.horizontalExtra
  );
}

/**
 * Lay a box and everything under it out at a width, at the origin — what
 * `LayoutContext.layoutSubtree` hands to `flex.ts` and `css-grid.ts`, and
 * what the shrink-to-fit probe and a table's cells use. A replaced box is
 * sized rather than laid out, because there is nothing inside it to lay out.
 */
export function layoutSubtree(
  box: Box,
  ctx: LayoutContext,
  width: number,
  /** Its containing block's width, where `width` is the box's own. */
  containing?: number,
  /** Whether this lays it out to measure it (`measureIntrinsicWidth`). */
  measuring = false,
): void {
  const base = containing ?? width;
  resolveEdges(box, Number.isFinite(base) ? base : 0);
  if (box.kind === 'replaced') {
    sizeReplaced(box, width);
    box.x = 0;
    box.y = 0;
    return;
  }
  // Within its limits, a percentage among them of its containing block's
  // width and not of its own: a flex item `max-width: 50%` that the flex
  // layout made half its row was laid out at a quarter of it. An
  // intrinsic limit is among them, as it is in a block's flow: without it,
  // a flex or grid item `min-width: max-content` that its layout made as
  // wide as its content was laid out at a smaller `max-width`, where the
  // minimum wins (CSS Sizing 3, 3.1). Not where the box is laid out to be
  // measured, since that is what an intrinsic limit is measured from.
  //
  // A table cell laid out in its columns, which hand it its row's width,
  // is as wide as they are (CSS Tables 3, 3.10.2): its limits are theirs
  // to weigh (3.8.2), and have been. Clamped again, `td { max-width:
  // 50px }` in a column 200 wide set its text in 50 of it. Probed for
  // what it asks of them, at none, it keeps within its length limits as
  // any box does; a percentage one is of nothing and does not hold it.
  let borderBox = Infinity;
  if (Number.isFinite(width)) {
    if (box.kind !== 'table-cell') {
      borderBox = clampWidth(box, width, base, measuring ? undefined : ctx);
    } else if (containing !== undefined) borderBox = width;
    else borderBox = clampWidth(box, width, NaN);
  }
  layoutInternals(box, ctx, borderBox, 0, 0);
}

/**
 * Lay a box's inside out and give it a height. `outerFloats` is the parent's
 * float context, passed only when this box does *not* establish one of its
 * own — which is the difference between text flowing beside a float that
 * started in an earlier sibling and text that starts below it.
 *
 * A line-clamp container's clamp is carried through its formatting context
 * (`Clamp`), and a box that makes one of its own is laid out outside it.
 */
function layoutInternals(
  box: Box,
  ctx: LayoutContext,
  borderBoxWidth: number,
  x: number,
  y: number,
  outerFloats?: FloatContext,
): void {
  const outer = ctx.clamp ?? null;
  const lines = box.style.lineClamp;
  if (lines === null && (outer === null || !establishesBFC(box))) {
    layoutBox(box, ctx, borderBoxWidth, x, y, outerFloats);
    return;
  }
  if (lines === null) {
    ctx.clamp = null;
    layoutBox(box, ctx, borderBoxWidth, x, y, outerFloats);
  } else {
    layoutClamped(box, ctx, lines, borderBoxWidth, x, y, outerFloats);
  }
  ctx.clamp = outer;
}

/**
 * A line-clamp container, laid out with its clamp. `line-clamp: auto`'s
 * clamp point is after the lines its height holds, where it has a height
 * of its own (CSS Overflow 4, 5.3.1): the content is laid out whole to
 * count them, and again cut after them, where they are not all of it.
 */
function layoutClamped(
  box: Box,
  ctx: LayoutContext,
  lines: number,
  borderBoxWidth: number,
  x: number,
  y: number,
  outerFloats?: FloatContext,
): void {
  const floor = lines === Infinity ? autoFloor(box, y) : Infinity;
  if (floor === Infinity) {
    // counted against the number, or where `auto` has no height to fill,
    // against none: the boxes a clamp hid before show again
    ctx.clamp = { box, left: lines, done: false, fit: null };
    layoutBox(box, ctx, borderBoxWidth, x, y, outerFloats);
    return;
  }
  const fit = { floor, lines: 0, over: false };
  ctx.clamp = { box, left: Infinity, done: false, fit };
  const positioned = ctx.positioned.length;
  layoutBox(box, ctx, borderBoxWidth, x, y, outerFloats);
  if (!fit.over) return;
  ctx.positioned.length = positioned;
  ctx.clamp = { box, left: fit.lines, done: fit.lines === 0, fit: null };
  layoutBox(box, ctx, borderBoxWidth, x, y, outerFloats);
}

/** Where an `auto` clamp's lines have to end by, in document coordinates:
 *  the content bottom of a box as tall as its `height`, or `max-height`,
 *  lets it be — Infinity where neither is set. */
function autoFloor(box: Box, y: number): number {
  const set = resolveOrNull(box.style.height, box.percentHeightBase);
  const outer =
    set === null
      ? Infinity
      : box.style.boxSizing === 'border-box'
        ? Math.max(set, box.verticalExtra)
        : set + box.verticalExtra;
  const height = clampHeight(box, outer);
  return Number.isFinite(height)
    ? y + height - box.padBottom - box.borderBottom
    : Infinity;
}

function layoutBox(
  box: Box,
  ctx: LayoutContext,
  borderBoxWidth: number,
  x: number,
  y: number,
  outerFloats?: FloatContext,
): void {
  box.layoutSerial = ++layoutSerial;
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

  // A multicol container's content is laid out as one column, all of it,
  // and then set in the columns there are (`layoutColumns`)
  const columns = columnsOf(box, contentWidth);
  const flowWidth = columns ? columns.width : contentWidth;
  const ownFloats = establishesBFC(box) || !outerFloats;
  const floats = ownFloats
    ? new FloatContext(box.contentX, box.contentX + flowWidth)
    : outerFloats;
  // the line a pass before gave a marker, which this one may not
  if (box.marker) box.lines = null;
  if (box.marker && ctx.fonts) {
    const room = markerRoom(box, box.marker, ctx.fonts);
    if (room) MARKER_ROOM.set(box, room);
    else MARKER_ROOM.delete(box);
    if (box.style.listStylePosition === 'inside') MARKER_ASCENT.delete(box);
    else MARKER_ASCENT.set(box, markerAscent(box, box.marker, ctx.fonts));
  }
  // a column wide while its content is laid out, for what reads the box
  // it is in rather than the width it is handed
  // and about a box that spans them, in rows of columns (`layoutRows`)
  const rows =
    columns && columns.count > 1 && box.children.some(spansColumns)
      ? layoutRows(box, ctx, columns, contentWidth, borderBoxWidth)
      : null;
  if (columns) box.width = columns.width + box.horizontalExtra;
  const flow =
    rows === null
      ? layoutChildren(box, ctx, floats, box.contentY, flowWidth)
      : { height: rows, hanging: NO_MARGIN };
  box.width = borderBoxWidth;
  // A list item with a marker and no line holds one, the marker's, a line
  // of its own face tall: an empty `<li>` is a line tall in a browser, and
  // an inline-block around one sits on its marker's baseline.
  let height = flow.height;
  if (box.marker && ctx.fonts && !firstLineIn(box)) {
    const own = strutOf(ctx.fonts, box.style);
    // as tall as the marker on it, as a first line with text is
    const room = MARKER_ROOM.get(box);
    const strut = room
      ? {
          ascent: Math.max(own.ascent, room.ascent),
          descent: Math.max(own.descent, room.descent),
        }
      : own;
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
  // Past a clamp point, a line-clamp container clips its floats rather
  // than holding them (CSS Overflow 4, 5.3.1).
  const clamped = ctx.clamp?.box === box && ctx.clamp.done;
  const withFloats =
    ownFloats && !clamped
      ? Math.max(
          height,
          floats.bottom === -Infinity ? 0 : floats.bottom - box.contentY,
        )
      : height;
  if (rows !== null) finishHeight(box, rows);
  else if (columns) {
    finishHeight(
      box,
      layoutColumns(box, columns, withFloats, columnLimit(box)),
    );
  } else {
    if (box.style.columns) forgetColumns(box);
    finishHeight(box, withFloats);
  }
  // The margin that escaped through this box's bottom edge becomes part of
  // its own: the parent's flow loop reads `child.marginBottom` for the next
  // sibling's collapse, which is exactly where an escaped margin goes.
  // Kept as a strut too, for the next sibling's margins to collapse with
  // all of the ones it came to rather than with their sum.
  if (flow.hanging.pos || flow.hanging.neg) {
    const bottom = join(flow.hanging, box.marginBottom);
    box.bottomStrut = bottom;
    box.marginBottom = marginOf(bottom);
  } else box.bottomStrut = null;
  if (box.marker) layoutMarker(box, box.marker, ctx);
  if (isButtonBlock(box)) {
    BUTTON_CONTENT.set(box, { height: withFloats, down: 0 });
    centreButton(box);
  }
}

/**
 * A multicol container's content about the boxes that span its columns
 * (`column-span: all`, CSS Multi-column 1, 6): what comes before one is set
 * in columns of its own, balanced, the spanner under them across the whole
 * container, and what comes after in columns under that. A spanner is a
 * formatting context of its own and its margins collapse with no column
 * content's, only with the spanner's next to it. Answers the content's
 * height.
 */
function layoutRows(
  box: Box,
  ctx: LayoutContext,
  columns: Columns,
  contentWidth: number,
  borderBoxWidth: number,
): number {
  const all = box.children;
  const limit = columnLimit(box);
  const top = box.contentY;
  let y = top;
  /** The bottom margin of the spanner just before, which the next thing
   *  comes under: all of it, or what the next spanner's does not cover. */
  let margin: number | null = null;
  let from = 0;
  try {
    for (let i = 0; i <= all.length; i += 1) {
      const child = all[i];
      if (child && !spansColumns(child)) continue;
      const row = all.slice(from, i);
      from = i + 1;
      if (row.length) {
        const set = row.some(
          (in_) =>
            in_.kind !== 'text' && in_.kind !== 'break' && !in_.outOfFlow,
        );
        if (set && margin !== null) {
          y += margin;
          margin = null;
        }
        // the row's content as a strip a column wide, and then in columns,
        // no taller than the container has left
        box.children = row;
        box.width = columns.width + box.horizontalExtra;
        const floats = new FloatContext(
          box.contentX,
          box.contentX + columns.width,
        );
        const flow = layoutChildren(box, ctx, floats, y, columns.width);
        box.width = borderBoxWidth;
        const strip = Math.max(
          flow.height,
          floats.bottom === -Infinity ? 0 : floats.bottom - y,
        );
        y += layoutColumns(
          box,
          columns,
          strip,
          Math.max(0, limit - (y - top)),
          y,
        );
      }
      if (!child) break;
      resolveEdges(child, contentWidth);
      y +=
        margin === null ? child.marginTop : Math.max(margin, child.marginTop);
      layoutBlockLevel(
        child,
        ctx,
        new FloatContext(box.contentX, box.contentX + contentWidth),
        box.contentX,
        y,
        contentWidth,
      );
      y = child.y + child.height;
      margin = child.marginBottom;
    }
  } finally {
    box.children = all;
    box.width = borderBoxWidth;
  }
  return y + (margin ?? 0) - top;
}

/** The tallest a multicol container's columns may be: its own height where
 *  it has one, and its `max-height`; no limit where it has neither. */
function columnLimit(box: Box): number {
  const height = box.height;
  finishHeight(box, specifiedHeight(box) === null ? Infinity : 0);
  const limit = box.height - box.verticalExtra;
  box.height = height;
  return Math.max(0, limit);
}

/**
 * The room a list item's marker takes about its first line's baseline,
 * handed to the box that line is in: an image's height above it, its
 * bottom on the baseline as an inline image's is, and a marker in a face
 * of its own — a `::marker` rule's — its face at its line height. CSS 2.1
 * (12.5.1) leaves where an outside marker goes to the user agent; Blink
 * and Gecko both set it on the item's first line and make the line as tall
 * as it, and design 032's bullets, images taller than its 10px text, set
 * every item's first line lower than ours did.
 */
const MARKER_ROOM = new WeakMap<Box, InlineDecoration>();

function markerRoom(
  box: Box,
  marker: Marker,
  fonts: FontsLike,
): InlineDecoration | null {
  if (marker.image) {
    return marker.image.height > 0
      ? { ascent: marker.image.height, descent: 0 }
      : null;
  }
  return marker.style && marker.style !== box.style
    ? strutOf(fonts, marker.style)
    : null;
}

/**
 * How far an outside marker reaches above the baseline it sits on. The
 * marker is a line of its own face, the item's or a `::marker` rule's, so a
 * bullet or a number reaches its face's ascent on that line, and an image,
 * set on the line bottom on the baseline, the higher of that and its own
 * height. Where the item's first line is in a block inside it — a link set
 * `display: block`, a paragraph — and the block's first baseline is nearer
 * its top than that, the block goes lower by the difference, and its line
 * stays the height it was: CSS 2.1 (12.5.1) leaves this to the user agent,
 * and Blink aligns the marker's baseline with the block's and pushes the
 * block down (`UnpositionedListMarker::AddToBox`). Its first line grew
 * instead, and design 196's links, under 18px bullets, were 21px tall where
 * Chrome has them 14px, 7px lower. On the item's own line the two come to
 * the same: the line grows by what the push would have moved it.
 */
const MARKER_ASCENT = new WeakMap<Box, number>();

function markerAscent(box: Box, marker: Marker, fonts: FontsLike): number {
  const ascent = strutOf(fonts, marker.style ?? box.style).ascent;
  return marker.image ? Math.max(marker.image.height, ascent) : ascent;
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
const MARKER_GAPS = new WeakMap<FontsLike, Map<string, number>>();

/**
 * The gap after a marker, a space's width in its face: kept per face and
 * fonts, since a list is a column of markers set alike, and laying the
 * space out for each of them was most of what a long document's markers
 * cost.
 */
function markerGap(fonts: FontsLike, face: Omit<TextRun, 'text'>): number {
  let gaps = MARKER_GAPS.get(fonts);
  if (!gaps) MARKER_GAPS.set(fonts, (gaps = new Map()));
  const key = `${face.family}\u0001${face.size}\u0001${String(face.weight ?? '')}\u0001${String(face.style ?? '')}`;
  let gap = gaps.get(key);
  if (gap === undefined) {
    gap = fonts.layout([{ text: '\u00a0', ...face }], face, {}).width;
    gaps.set(key, gap);
  }
  return gap;
}

function layoutMarker(box: Box, marker: Marker, ctx: LayoutContext): void {
  const fonts = ctx.fonts;
  if (!fonts) return;
  const style = box.style;
  if (marker.image) {
    // an image: its bottom on the first line's baseline, as an inline
    // image's is, and its own gap before the content (`MARKER_IMAGE_GAP`)
    const first = firstLineIn(box);
    marker.y = first
      ? first.y + first.baseline - marker.image.height
      : box.contentY;
    const { gap } = marker.image;
    // at the start of the line, which is its right in a right-to-left item
    marker.x =
      style.direction === 'rtl'
        ? box.contentX + box.contentWidth + gap
        : box.contentX - gap - marker.image.width;
    return;
  }
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
  // in the item's direction, which puts a number's full stop on its left
  // in a right-to-left list, as the bidi algorithm has it
  const layout = fonts.layout([{ text: marker.text, ...face }], face, {
    lineHeight: lineHeightMultiplier(fonts, style),
    direction: style.direction,
  });
  marker.layout = layout;
  // a space between it and the content — the one its style's suffix ends
  // in, or its own text's — in its own face: a line measures without the
  // spaces it ends in, and with a no-break space, which `content: "1.\a0"`
  // writes and which was a second gap on top of its own
  const trailing = marker.flush
    ? (/[ \t\n\r\f]*$/.exec(marker.text)?.[0].length ?? 0)
    : 1;
  const gap = trailing ? trailing * markerGap(fonts, face) : 0;
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
      : style.direction === 'rtl'
        ? box.contentX + box.contentWidth + gap
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
  const flexed = FLEXED_HEIGHT.get(box);
  if (flexed !== undefined) return flexed;
  if (!box.el && !box.pseudo) return box.percentHeightBase;
  const resolved = specifiedHeight(box);
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

/** Whether anything in a box takes a percentage of a height: what a height
 *  a flex or grid layout makes definite changes. Kept for the tree's life. */
export function percentHeightsIn(box: Box): boolean {
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

/**
 * A box's own height, where it has one, as `box-sizing` measures it: a
 * length, a percentage of a height that resolves, or `stretch`'s, and else
 * none, which is `auto`.
 */
function specifiedHeight(box: Box): number | null {
  const style = box.style;
  if (style.heightKeyword === 'stretch') {
    const outer = stretchHeight(box);
    if (outer === null) return null;
    return style.boxSizing === 'border-box'
      ? outer
      : Math.max(0, outer - box.verticalExtra);
  }
  return resolveOrNull(style.height, box.percentHeightBase);
}

/** Where an absolutely positioned box's `stretch` height starts in its
 *  containing block: its `top`, or its static position where it has
 *  neither offset (`layoutPositioned`). */
const STRETCH_TOP = new WeakMap<Box, number>();

/**
 * A replaced box's `stretch` sizes, which `sizeReplaced` knows nothing of:
 * the width it was given for one across, the height its offsets leave for
 * one down, and through its ratio, the other where that is `auto`.
 */
function stretchReplaced(
  box: Box,
  across: number | null,
  containingWidth: number,
): void {
  const style = box.style;
  const down = style.heightKeyword === 'stretch' ? stretchHeight(box) : null;
  if (across === null && down === null) return;
  if (across !== null) box.width = across;
  if (down !== null) box.height = clampHeight(box, down);
  if (across !== null && down === null && style.height === AUTO) {
    const tall = heightThroughRatio(box, across);
    if (tall !== null) box.height = clampHeight(box, tall);
  } else if (down !== null && across === null && style.width === AUTO) {
    const wide = widthThroughRatio(box, box.height);
    if (wide !== null) box.width = clampWidth(box, wide, containingWidth);
  }
}

/**
 * The border-box height `stretch` makes of a box (CSS Sizing 3, 4.2): what
 * its margins leave of the height its percentages are of, where that is
 * definite, and else none. A margin of an in-flow block that its parent's
 * border or padding does not part from the parent's edge, in a parent that
 * is no formatting context of its own, counts as none, as the margin would
 * collapse with the parent's.
 */
function stretchHeight(box: Box): number | null {
  const base = box.percentHeightBase;
  if (!Number.isFinite(base)) return null;
  const style = box.style;
  if (style.position === 'absolute' || style.position === 'fixed') {
    // what its offsets leave of its containing block, an `auto` one none
    // — or its static position, where both are (`layoutPositioned`)
    const top = STRETCH_TOP.get(box) ?? resolveOrNull(style.top, base) ?? 0;
    const bottom = resolveOrNull(style.bottom, base) ?? 0;
    return Math.max(
      box.verticalExtra,
      base - top - bottom - box.marginTop - box.marginBottom,
    );
  }
  const parent = box.parent;
  const inFlow =
    parent !== null &&
    !box.outOfFlow &&
    !box.isFloat &&
    box.kind !== 'replaced' &&
    !isInlineLevel(box) &&
    !establishesBFC(parent);
  const top = inFlow && !parent.borderTop && !parent.padTop ? 0 : box.marginTop;
  const bottom =
    inFlow && !parent.borderBottom && !parent.padBottom ? 0 : box.marginBottom;
  return Math.max(box.verticalExtra, base - top - bottom);
}

/**
 * The content height a flex or grid layout made definite for an item — a
 * stretched item's, a flexed one's in a container of a definite height (CSS
 * Flexbox 9.8), a grid item's stretched down its area (CSS Grid 1, 11.1) —
 * which what is in it takes its percentages of, and which an item that is
 * a flex or grid container itself lays its own items out in, and a table
 * shares out among its rows. Set by `flex.ts` and `css-grid.ts` for the
 * item's own layout alone.
 */
export const FLEXED_HEIGHT = new WeakMap<Box, number>();

/**
 * The content height a flex layout gave an item without making it definite:
 * flexed along a column that has no height of its own, which 9.8 leaves
 * indefinite. An item that is a flex or grid container lays its own items
 * out in it all the same — it is its used size (9.7) — as a table shares
 * it among its rows, and nothing in it takes a percentage of it. Set by
 * `flex.ts` for the item's own layout alone.
 */
export const USED_HEIGHT = new WeakMap<Box, number>();

/**
 * A table a grid or a flex layout gives its width, whose `auto` width is
 * then the one it is laid out at. `normal` stretches any grid item but a
 * replaced one across its area (CSS Grid 1, 6.2), and a flex item across a
 * column's line (CSS Flexbox 9.4, step 11), a table among them; and a flex
 * item along a row is the size the line flexed it to (9.7) — where in a
 * block's flow a table's `auto` width is its columns' (CSS 2.1 17.5.2;
 * Blink leaves tables out of the boxes a block stretches, `space_utils.cc`,
 * and stretches them in a grid, `grid_item.cc`, and a flex box). Set by
 * `css-grid.ts` and `flex.ts` for the item's own layout alone, and never
 * while its widths are measured.
 */
export const STRETCHED_ACROSS = new WeakSet<Box>();

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
  const ratio = boxRatio(box);
  if (!ratio) return null;
  if (resolveOrNull(box.style.height, box.percentHeightBase) !== null) {
    return null;
  }
  return ratio.border
    ? Math.max(0, box.width / ratio.ratio - box.verticalExtra)
    : Math.max(0, box.contentWidth / ratio.ratio);
}

/**
 * A box's `aspect-ratio` where it is not replaced, and whether it is of its
 * border box — a ratio written alone under `box-sizing: border-box` — or
 * of its content box, as one written `auto` with it is whatever the
 * `box-sizing` (CSS Sizing 4, 5.1).
 */
export function boxRatio(box: Box): { ratio: number; border: boolean } | null {
  const aspect = box.style.aspectRatio;
  if (!aspect || box.kind === 'replaced' || !(aspect.ratio > 0)) return null;
  return {
    ratio: aspect.ratio,
    border: box.style.boxSizing === 'border-box' && !aspect.auto,
  };
}

/** A border-box height through a box's ratio into its border-box width,
 *  or null where the box has no ratio of its own. */
export function widthFromHeight(box: Box, height: number): number | null {
  const ratio = boxRatio(box);
  return ratio ? acrossRatio(box, ratio, height) : null;
}

/** A replaced element's ratio: its `aspect-ratio`, unless that says `auto`
 *  and it has one of its own, as `sizeReplaced` takes it. */
export function replacedRatio(box: Box): number {
  const own = box.intrinsic;
  const aspect = box.style.aspectRatio;
  const natural = own ? own.ratio : 0;
  return aspect && !(aspect.auto && natural > 0) ? aspect.ratio : natural;
}

/** A border-box height through any box's ratio into its border-box width
 *  — a replaced element's is of its content box — or null where it has
 *  none. */
export function widthThroughRatio(box: Box, height: number): number | null {
  if (box.kind !== 'replaced') return widthFromHeight(box, height);
  const ratio = replacedRatio(box);
  return ratio > 0
    ? Math.max(0, height - box.verticalExtra) * ratio + box.horizontalExtra
    : null;
}

/** A border-box width through any box's ratio into its border-box height,
 *  or null where it has none. */
export function heightThroughRatio(box: Box, width: number): number | null {
  if (box.kind !== 'replaced') return heightFromWidth(box, width);
  const ratio = replacedRatio(box);
  return ratio > 0
    ? Math.max(0, width - box.horizontalExtra) / ratio + box.verticalExtra
    : null;
}

/** A border-box width through a box's ratio into its border-box height,
 *  or null where the box has no ratio of its own. */
export function heightFromWidth(box: Box, width: number): number | null {
  const ratio = boxRatio(box);
  if (!ratio) return null;
  return ratio.border
    ? width / ratio.ratio
    : Math.max(0, width - box.horizontalExtra) / ratio.ratio +
        box.verticalExtra;
}

/** A border-box height through a box's ratio into its border-box width. */
function acrossRatio(
  box: Box,
  ratio: { ratio: number; border: boolean },
  height: number,
): number {
  return ratio.border
    ? height * ratio.ratio
    : Math.max(0, height - box.verticalExtra) * ratio.ratio +
        box.horizontalExtra;
}

/**
 * The border-box width `aspect-ratio` gives a box whose width is `auto`
 * from a height of its own, within its least and greatest heights (CSS
 * Sizing 4, 5.1): a block is that wide, not as wide as its room — and so
 * is one whose width is its content's, `min-content` or `fit-content`, as
 * its content is that height through its ratio (5.3). Null where it has
 * no ratio, no height or a length for a width.
 */
export function ratioWidth(box: Box): number | null {
  const ratio = boxRatio(box);
  const style = box.style;
  if (!ratio || style.width !== AUTO) return null;
  const set = resolveOrNull(style.height, box.percentHeightBase);
  if (set === null) return null;
  const outer = clampHeight(
    box,
    style.boxSizing === 'border-box'
      ? Math.max(set, box.verticalExtra)
      : set + box.verticalExtra,
  );
  return acrossRatio(box, ratio, outer);
}

/**
 * A width its ratio gave a box, no narrower than its content at its
 * narrowest where its least width is `auto` and it shows what overflows
 * it — the automatic minimum of a box with a ratio (5.2) — though no
 * wider for that than its greatest width.
 */
function ratioMinimum(
  box: Box,
  width: number,
  containingWidth: number,
  ctx?: LayoutContext,
): number {
  const style = box.style;
  if (
    !ctx ||
    style.minWidth !== AUTO ||
    style.minWidthKeyword ||
    scrolls(style)
  ) {
    return width;
  }
  if (box.intrinsicMinContent < 0) {
    const saved = box.lines;
    box.intrinsicMinContent = measureIntrinsicWidth(
      box,
      ctx,
      MIN_CONTENT_PROBE,
    );
    box.lines = saved;
    resolveEdges(box, containingWidth);
  }
  const max =
    style.maxWidth === 'none'
      ? Infinity
      : (resolveOrNull(style.maxWidth, containingWidth) ?? Infinity) +
        (style.boxSizing === 'border-box' ? 0 : box.horizontalExtra);
  return Math.max(width, Math.min(box.intrinsicMinContent, max));
}

/** A table cell's height as its content came to, border box, apart from a
 *  height it sets: what `vertical-align` moves in the cell (`table.ts`). */
export const CELL_CONTENT = new WeakMap<Box, number>();

function finishHeight(box: Box, contentHeight: number): void {
  // as though it held nothing, under size containment
  if (contained(box, CONTAIN_SIZE)) {
    contentHeight = box.style.containIntrinsicHeight ?? 0;
  }
  if (box.kind === 'table-cell') {
    CELL_CONTENT.set(box, contentHeight + box.verticalExtra);
  }
  // A table a flex or grid layout gave a height is as tall as that, or as
  // its rows where they need more, which `layoutTable` has shared it out
  // among — whatever height it has of its own, which the flex layout
  // started from (`layoutTable`)
  if (box.kind === 'table' && Number.isFinite(givenHeight(box))) {
    box.height = contentHeight + box.verticalExtra;
    return;
  }
  const set = specifiedHeight(box);
  // at least zero: a `calc()` may come to less
  const specified = set === null ? null : Math.max(0, set);
  if (specified !== null && box.kind === 'table') {
    // A table's height is a least one, which `layoutTable` has shared out
    // to its rows: one set shorter than they are leaves them their height
    // (CSS 2.1 17.5.3). Taken as the table's, it ended its background
    // over its rows, and a float after it went up beside them.
    const outer =
      box.style.boxSizing === 'border-box'
        ? specified
        : specified + box.verticalExtra;
    box.height = Math.max(
      clampHeight(box, outer),
      contentHeight + box.verticalExtra,
    );
    return;
  }
  if (specified === null && box.style.aspectRatio) {
    const ratio = ratioHeight(box);
    if (ratio !== null) {
      // the ratio's height, grown to what the box holds unless it clips it
      // or has a least height of its own (5.2: the automatic minimum of a
      // box with a ratio is its content, and `min-height: 0` is none)
      const automatic =
        box.style.minHeight === AUTO &&
        box.style.minHeightKeyword === null &&
        !scrolls(box.style);
      contentHeight = automatic ? Math.max(ratio, contentHeight) : ratio;
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
  // 10.7), which leaves a `calc()` its pixels; so is `stretch`, which is a
  // border-box height where it is one
  if (box.style.maxHeightKeyword === 'stretch') {
    out = Math.min(out, stretchHeight(box) ?? Infinity);
  }
  if (box.style.minHeightKeyword === 'stretch') {
    out = Math.max(out, stretchHeight(box) ?? 0);
  }
  const min =
    box.style.minHeight === AUTO
      ? 0
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
  // no shorter than its padding and borders, as `clampWidth` is no
  // narrower
  return Math.max(box.verticalExtra, out);
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
  // In the unbounded room a shrink-to-fit probe lays a box out in, there is
  // no slack to share: half of an infinite one put an auto-margined box at
  // x = Infinity, and the pass after moved it from there by a finite amount
  // — NaN, which went up every ink bound above it and left a whole article
  // unpainted.
  if (!Number.isFinite(slack)) {
    box.x = left;
    box.y = y;
    return;
  }
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
  if (style.width === AUTO || cyclicWidth(style, percentBase)) {
    // a width its height gives it through its ratio
    const fromRatio = ratioWidth(box);
    if (fromRatio !== null) {
      const clamped = clampWidth(box, fromRatio, percentBase, ctx);
      return ratioMinimum(box, clamped, percentBase, ctx);
    }
    const room = Math.max(0, available);
    const keyword =
      style.widthKeyword ?? (fitsContent(box) ? 'fit-content' : null);
    const width =
      keyword && ctx
        ? contentSizedWidth(box, ctx, keyword, room, percentBase)
        : room;
    return clampWidth(
      box,
      transferredWidth(box, width),
      percentBase,
      ctx,
      containingWidth,
    );
  }
  // at least zero: a `calc()` may come to less
  const specified = Math.max(0, resolve(style.width, percentBase, 0));
  const borderBox =
    style.boxSizing === 'border-box'
      ? Math.max(specified, box.horizontalExtra)
      : specified + box.horizontalExtra;
  return clampWidth(box, borderBox, percentBase, ctx, containingWidth);
}

/**
 * Whether a block-level box's `width: auto` is `fit-content` and not the
 * room its margins leave: a `<button>`'s, of which HTML's rendering section
 * says "If the computed value of 'inline-size' is 'auto', then the used
 * value is the fit-content inline size" (button layout, 15.5.3) — whatever
 * it is laid out as inside, a block, a flex box or a grid, as Blink leaves
 * it out of the boxes whose `auto` stretches
 * (`ShouldBlockContainerChildStretchAutoInlineSize`). Set `display: block`
 * to stand on a line of its own, a button was as wide as the line, where it
 * is as wide as its label. Not one a flex box, a grid or a pair of offsets
 * sizes, which stretch it still.
 *
 * Asked of every block: most are told from a button by the length of their
 * name.
 */
function fitsContent(box: Box): boolean {
  return box.el !== null && box.el.name.length === 6 && isButton(box);
}

/**
 * Whether a box's `width` is a percentage of a width that is not there to
 * take it of: its containing block's, while that is being found from what
 * it holds — a float's, an inline-block's, a flex item's or a table cell's
 * content measured at its widest. The percentage is cyclic, and the box is
 * measured as though its width were `auto` (CSS Sizing 3, 5.2.1); it is a
 * share of the width that comes to once there is one.
 *
 * Taken as a share of nothing, the box was no width at all, and its content
 * wrapped at every word in it: a float around a `width: 100%` block was as
 * wide as the block's longest word, and one around a `width: 100%` flex box
 * of a label that clips — the branch button of a GitHub repository — as
 * wide as nothing, its label gone.
 */
export function cyclicWidth(style: ComputedStyle, base: number): boolean {
  return isPct(style.width) && !Number.isFinite(base);
}

/**
 * A width a box with a ratio and no height of its own works out for itself
 * within the least and greatest widths its least and greatest heights make
 * through its ratio (CSS Sizing 4, 5.2) — those of its own winning where
 * the two disagree, as `clampWidth` after this makes them. A block the
 * room would stretch is no wider than its greatest height lets it be. A
 * width a flex box or a grid gives an item is not, which is theirs.
 */
export function transferredWidth(box: Box, width: number): number {
  const style = box.style;
  const ratio = boxRatio(box);
  if (!ratio || resolveOrNull(style.height, box.percentHeightBase) !== null) {
    return width;
  }
  const heightOf = (len: Len) => {
    const px = resolveOrNull(len, box.percentHeightBase);
    if (px === null || !Number.isFinite(px)) return null;
    return style.boxSizing === 'border-box'
      ? Math.max(px, box.verticalExtra)
      : px + box.verticalExtra;
  };
  const maxH = style.maxHeight === 'none' ? null : heightOf(style.maxHeight);
  const minH = style.minHeight === AUTO ? null : heightOf(style.minHeight);
  let out = width;
  if (maxH !== null) out = Math.min(out, acrossRatio(box, ratio, maxH));
  if (minH !== null) out = Math.max(out, acrossRatio(box, ratio, minH));
  return out;
}

/**
 * A border-box height within what a box's ratio makes of its least and
 * greatest widths: how a flex item's content size suggestion down a
 * column is held (CSS Flexbox 4.5). Unchanged where it has no ratio.
 */
export function transferredHeight(
  box: Box,
  height: number,
  containingWidth: number,
): number {
  const ratio = boxRatio(box);
  if (!ratio) return height;
  const style = box.style;
  const extra = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
  const down = (width: number) => heightFromWidth(box, width + extra)!;
  let out = height;
  if (style.maxWidth !== 'none') {
    const most = resolveOrNull(style.maxWidth, containingWidth);
    if (most !== null) out = Math.min(out, down(most));
  }
  const least =
    style.minWidth === AUTO
      ? null
      : resolveOrNull(style.minWidth, containingWidth);
  if (least !== null && least > 0) out = Math.max(out, down(least));
  return out;
}

/** A width within `min-width` and `max-width` — the minimum winning — the
 *  intrinsic ones among them where `ctx` is there to measure them. */
export function clampWidth(
  box: Box,
  width: number,
  containingWidth: number,
  ctx?: LayoutContext,
  /** The room a `stretch` limit fills, where it is less than the
   *  containing block beside floats. */
  room = containingWidth,
): number {
  const style = box.style;
  const extra = style.boxSizing === 'border-box' ? 0 : box.horizontalExtra;
  let out = width;
  const max =
    style.maxWidth === 'none'
      ? null
      : resolveOrNull(style.maxWidth, containingWidth);
  if (max !== null) out = Math.min(out, max + extra);
  if (style.maxWidthKeyword && ctx) {
    out = Math.min(
      out,
      keywordWidth(box, ctx, style.maxWidthKeyword, containingWidth, room),
    );
  }
  // `auto` is 0 but for a flex item, which `flex.ts` answers
  const min =
    style.minWidth === AUTO
      ? 0
      : resolveOrNull(style.minWidth, containingWidth);
  if (min !== null) out = Math.max(out, min + extra);
  if (style.minWidthKeyword && ctx) {
    out = Math.max(
      out,
      keywordWidth(box, ctx, style.minWidthKeyword, containingWidth, room),
    );
  }
  // and no narrower than its padding and borders: a `border-box` length
  // less than them leaves its content box none wide, and not less (CSS
  // Sizing 3, 3.3)
  return Math.max(box.horizontalExtra, out);
}

/** An intrinsic `min-width` or `max-width` in the room a box's margins
 *  leave it. Apart from `clampWidth`, which every block is sized through,
 *  so that it makes nothing for the ones that have none. */
function keywordWidth(
  box: Box,
  ctx: LayoutContext,
  keyword: ContentSize,
  containingWidth: number,
  stretchRoom = containingWidth,
): number {
  const of = keyword === 'stretch' ? stretchRoom : containingWidth;
  const room = Math.max(0, of - box.marginLeft - box.marginRight);
  return contentSizedWidth(box, ctx, keyword, room, containingWidth);
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
  // `stretch` is the room, whatever the content (CSS Sizing 4)
  if (size === 'stretch') return Math.max(0, available);
  // a height of its own through a ratio is its content's width at any size
  const fromRatio = ratioWidth(box);
  if (fromRatio !== null) return fromRatio;
  // the content's sizes, whatever width the box has of its own: a
  // `min-width: max-content` beside a `width` is its content's widest,
  // and a probe of the box at no width answered the probe's width
  if (box.intrinsicMaxContent < 0) {
    box.intrinsicMaxContent = measureIntrinsicWidth(box, ctx, Infinity, true);
  }
  if (size !== 'max-content' && box.intrinsicMinContent < 0) {
    box.intrinsicMinContent = measureIntrinsicWidth(
      box,
      ctx,
      MIN_CONTENT_PROBE,
      true,
    );
  }
  // The probes resolved a percentage of the box's padding or border
  // against nothing, which is how the sizes are kept, whatever the width
  // around the box: what one comes to against `percentBase` goes on top.
  // Left out, `width: max-content; padding-left: 10%` was as wide as its
  // content, the padding inside it.
  resolveEdges(box, 0);
  const bare = box.horizontalExtra;
  resolveEdges(box, Number.isFinite(percentBase) ? percentBase : 0);
  const extra = box.horizontalExtra - bare;
  const max = box.intrinsicMaxContent + extra;
  if (size === 'max-content') return max;
  const min = box.intrinsicMinContent + extra;
  if (size === 'min-content') return min;
  return Math.min(
    max,
    Math.max(min, fitRoom(box, size, available, percentBase)),
  );
}

/** The room `fit-content` fits a box's content in: what its margins leave,
 *  or `fit-content()`'s argument as a width of its own, of `percentBase`
 *  where it is a percentage — an indefinite one leaving the content its
 *  widest. */
function fitRoom(
  box: Box,
  size: ContentSize,
  available: number,
  percentBase: number,
): number {
  if (typeof size !== 'object') return available;
  const fit = Math.max(0, resolve(size.fit, percentBase, 0));
  return box.style.boxSizing === 'border-box'
    ? Math.max(fit, box.horizontalExtra)
    : fit + box.horizontalExtra;
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
  /** How far into the containing block the box's room starts: an
   *  absolute box's offset, or its static position. */
  offset = 0,
): number {
  const style = box.style;
  if (style.width !== AUTO && !cyclicWidth(style, available)) {
    const specified = Math.max(0, resolve(style.width, available, 0));
    const borderBox =
      style.boxSizing === 'border-box'
        ? Math.max(specified, box.horizontalExtra)
        : specified + box.horizontalExtra;
    return clampWidth(box, borderBox, available, ctx);
  }
  // `stretch` fills the room its margins leave, as a block's `auto` does
  if (style.widthKeyword === 'stretch') {
    const room = available - offset - box.marginLeft - box.marginRight;
    return clampWidth(box, Math.max(0, room), available, ctx);
  }
  // a width its height gives it through its ratio, as a block's
  const fromRatio = ratioWidth(box);
  if (fromRatio !== null) {
    const clamped = clampWidth(box, fromRatio, available, ctx);
    return ratioMinimum(box, clamped, available, ctx);
  }
  // `fit-content` is what shrink-to-fit is; the other two are not bounded
  // by the room, or not by the longest line, and `fit-content()` by a room
  // of its own
  const keyword = style.widthKeyword;
  if (keyword !== null && keyword !== 'fit-content') {
    const width = contentSizedWidth(box, ctx, keyword, available, available);
    return clampWidth(box, transferredWidth(box, width), available, ctx);
  }
  const probe = new FloatContext(0, Infinity);
  const saved = box.lines;
  // Its content's width with no limit on it is the same at every width, so
  // it is probed once in the box's life, as a cell's is. Probed every time
  // it was asked, a float in a float was probed as often as there were
  // floats around it, and each probe laid out all of the floats inside.
  let content = PREFERRED.get(box);
  let probed = false;
  if (content === undefined) {
    layoutInternals(box, ctx, Infinity, 0, 0, probe);
    content = intrinsicWidth(box);
    PREFERRED.set(box, content);
    probed = true;
  }
  const preferred = content + box.horizontalExtra;
  // the room is the containing block's, less the box's margins and where
  // it starts (CSS 2.1 10.3.5, 10.3.7, 10.3.9): a float with side margins
  // was as wide as its containing block, and stood out of it by them
  const room = Math.max(
    0,
    available - offset - box.marginLeft - box.marginRight,
  );
  let width = Math.max(preferred, 0);
  if (
    width > room &&
    box.intrinsicMinContent < 0 &&
    ctx.fonts !== null &&
    !probed
  ) {
    // the words the floor is read from are the probe's
    layoutInternals(box, ctx, Infinity, 0, 0, probe);
  }
  // and where its content does not fit the room, its longest word is the
  // least it comes to: `min(max(min-content, room), max-content)`. That
  // matters only for a word wider than the room, which the widest word
  // between spaces bounds, from the probe just laid out; only past the
  // room is the min-content width measured — a second probe, at a width
  // every line breaks at — and it is kept on the box, as a cell's is
  const fonts = ctx.fonts;
  const floored =
    width > room &&
    box.intrinsicMinContent < 0 &&
    fonts !== null &&
    wordBound(box, fonts, false) + box.horizontalExtra > room &&
    wordBound(box, fonts, true) + box.horizontalExtra > room;
  box.lines = saved;
  if (floored) {
    box.intrinsicMinContent = measureIntrinsicWidth(
      box,
      ctx,
      MIN_CONTENT_PROBE,
    );
    box.lines = saved;
    // the probe resolved the box's edges against the width it was given
    resolveEdges(box, available);
  }
  if (width > room)
    width = Math.min(width, Math.max(box.intrinsicMinContent, room));
  return clampWidth(box, transferredWidth(box, width), available, ctx);
}

/** A shrink-to-fit box's content width at no width limit, the once
 *  (`shrinkToFitWidth`); a box's lifetime is the cache's, as for
 *  `Box.intrinsicMaxContent`. */
const PREFERRED = new WeakMap<Box, number>();

/**
 * A box's min-content width as its words give it, laid out at no width
 * limit, and null where they may not: blocks and plain text that breaks
 * only at its spaces (`spaceBreaksOnly`) are as narrow as their widest
 * word (`widestWord`) with the edges of the blocks between, which is what
 * the probe finds (`MIN_CONTENT_PROBE`) — for a fifteenth of the cost on
 * ntk, which searches every word of that probe for a place to cut it, as
 * none fits in no width at all. Anything else
 * is left to the probe: another kind of break, an inline box's edges, a
 * box on a line, a float, a table or a flex box, text that does not wrap
 * or is indented, a block with widths of its own.
 */
export function exactMinContent(box: Box, fonts: FontsLike): number | null {
  // a flex row's is its items' side by side, a grid's its columns', and a
  // replaced element has no words: read as its widest word, a row of two
  // in a flex column's item was as narrow as the wider of them
  if (box.kind !== 'block' && box.kind !== 'table-cell') return null;
  if (hasWidths(box.style) || contained(box, CONTAIN_WIDTH)) return null;
  const inner = exactWords(box, fonts);
  return inner === null ? null : inner + box.horizontalExtra;
}

/** Whether a style sets its box's width, or its least or greatest width. */
function hasWidths(style: ComputedStyle): boolean {
  return (
    style.width !== AUTO ||
    style.widthKeyword !== null ||
    (style.minWidth !== 0 && style.minWidth !== AUTO) ||
    style.minWidthKeyword !== null ||
    style.maxWidth !== 'none' ||
    style.maxWidthKeyword !== null
  );
}

function exactWords(box: Box, fonts: FontsLike): number | null {
  const style = box.style;
  if (style.whiteSpace !== 'normal' || style.textIndent !== 0) return null;
  let widest = 0;
  if (box.lines) {
    let last: object | null = null;
    for (const line of box.lines) {
      if (line.atomics.length || line.edges?.length) return null;
      for (const text of line.texts) {
        if (text.layout === last) continue;
        last = text.layout;
        if (!spaceBreaksOnly(text.layout)) return null;
        widest = Math.max(widest, widestWord(fonts, text.layout));
      }
    }
  }
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.kind === 'inline') {
      if (!plainInline(child)) return null;
      continue;
    }
    if (child.kind !== 'block' || child.isFloat) return null;
    if (child.outOfFlow) continue;
    if (hasWidths(child.style)) return null;
    const inner = exactWords(child, fonts);
    if (inner === null) return null;
    widest = Math.max(
      widest,
      inner + child.horizontalExtra + child.marginLeft + child.marginRight,
    );
  }
  return widest;
}

/** Whether an inline box and what is in it are text that wraps. */
function plainInline(box: Box): boolean {
  if (box.style.whiteSpace !== 'normal') return false;
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.kind !== 'inline' || !plainInline(child)) return false;
  }
  return true;
}

/**
 * An upper bound of a laid-out block's min-content width inside its edges:
 * the widest word of its lines (`widestWord`, measured or estimated from
 * its characters), the widest box on them, and the same of each block in
 * it with that block's edges. A table, a flex
 * box and anything else not laid out as blocks and lines is as wide as the
 * probe made it, which is more than it has to be; a box that is itself one
 * has no bound.
 */
function wordBound(box: Box, fonts: FontsLike, measured: boolean): number {
  if (box.kind !== 'block') return Infinity;
  let widest = 0;
  // a line that does not wrap is one word: a `nowrap` tooltip in a narrow
  // containing block was cut to its width, the rest of the line out of it
  const unbroken =
    box.style.whiteSpace === 'nowrap' || box.style.whiteSpace === 'pre';
  if (box.lines) {
    let last: object | null = null;
    for (const line of box.lines) {
      if (unbroken) widest = Math.max(widest, line.width);
      // a word across inline boxes' edges is in two fragments of text, and
      // as wide as its parts in both and the edges between: bound by the
      // widest word of each, a float in a narrow room took a letter of a
      // word of letters in bordered spans for its least width, and was cut
      // to the room (`joinsBefore`)
      let chain = 0;
      for (const text of line.texts) {
        const joins = joinsBefore(text);
        if (joins === undefined && text.layout === last) continue;
        last = text.layout;
        const own = widestWord(fonts, text.layout, measured);
        chain = joins === undefined ? own : chain + joins + own;
        widest = Math.max(widest, chain);
      }
      for (const placed of line.atomics) {
        const b = placed.box;
        widest = Math.max(widest, b.width + b.marginLeft + b.marginRight);
      }
    }
  }
  for (const child of box.children) {
    if (child.outOfFlow) continue;
    if (
      child.kind !== 'block' &&
      child.kind !== 'flex' &&
      child.kind !== 'table' &&
      child.kind !== 'replaced'
    )
      continue;
    const edges = child.marginLeft + child.marginRight;
    const inner =
      child.kind === 'block' && child.style.width === AUTO
        ? wordBound(child, fonts, measured) + child.horizontalExtra
        : child.width;
    widest = Math.max(widest, inner + edges);
  }
  return widest;
}

/**
 * The widest thing a laid-out box drew — its max-content width.
 *
 * A block child laid out at an unbounded width *has* an unbounded width (a
 * `width: auto` block fills its containing block, and its containing block
 * was `Infinity`), so its own width says nothing and only what it drew does.
 * Skipping the non-finite ones is what stops the probe from answering
 * `Infinity` for every box that contains a paragraph.
 *
 * `seen.cut` is set where a line it measured was cut short by
 * `text-overflow`, in a box with a width to cut it at: the line is wider
 * than it was drawn, and the answer is of what was drawn.
 *
 * `narrowest` says the box was laid out by the min-content probe
 * (`MIN_CONTENT_PROBE`), and the answer is its min-content width: the
 * probe lays a box out at no width, but one with a least width of its own
 * at that, and nothing in the layout tells the two apart.
 */
export function intrinsicWidth(
  box: Box,
  seen?: { cut: boolean },
  narrowest = false,
): number {
  // under size containment, as though it held nothing: the size
  // `contain-intrinsic-size` gives it, or none (CSS Containment 2, 3.2)
  if (contained(box, CONTAIN_WIDTH)) {
    return box.style.containIntrinsicWidth ?? 0;
  }
  // a table is as wide as its layout made it: its columns, the spacing
  // either side of them and between, and its captions' least (`layoutTable`)
  // — at no width limit its widest, and at none its narrowest. What it
  // holds says less: its rows run from the first column to the last, the
  // spacing either side outside them, and measured by them a table in a
  // flex row, a grid, a float or an `inline-table` came to that much too
  // narrow, and its columns gave it up
  if (box.kind === 'table' && Number.isFinite(box.width)) {
    return Math.max(0, box.width - box.horizontalExtra);
  }
  // a grid laid out at no width limit has its columns at their widest, and
  // is as wide as they are — an item that runs past its column makes it no
  // wider — or, where it has none, as where its items end
  if (box.style.grid) {
    const cols = GRID_TRACKS.get(box)?.cols;
    if (cols?.length) return cols[cols.length - 1][1] - cols[0][0];
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
  // between them; any other box is as wide as the widest thing in it. So
  // is a row that wraps, at its narrowest: each of its items may be a line
  // of its own, and it is as wide as the widest of them (CSS Flexbox
  // 9.9.1). Summed, a wrapping row of three 30px items made a
  // `width: min-content` box around it 90 wide, the items side by side,
  // where Chrome has 30, one under another
  const display = box.style.display;
  const row =
    (display === 'flex' || display === 'inline-flex') &&
    box.style.flexDirection.startsWith('row');
  const wraps = row && narrowest && box.style.flexWrap !== 'nowrap';
  let total = 0;
  let items = 0;
  const lines = box.lines;
  if (lines) {
    // a float met in a line stands beside what the line holds, at its
    // width, as does a row of them beside no line
    for (const line of lines) {
      widest = Math.max(widest, line.width + (line.floats ?? 0));
    }
    widest = Math.max(widest, box.floatRow);
    // a line `text-overflow` cut short is wider than this finds it
    if (seen && !seen.cut && box.style.textOverflow === 'ellipsis') {
      seen.cut = lines.some((line) =>
        line.texts.some((text) => text.layout.truncated),
      );
    }
  }
  // Floats among blocks stand side by side too, as many as come together,
  // where each block in flow is a line of its own; one with a formatting
  // context of its own stands beside them (as Blink measures them). Taken
  // for the widest of them, a floated menu's items were one under another.
  // That is at the box's widest, laid out at no width limit; at its
  // narrowest each is as narrow as it can be, and one under another.
  const sideBySide = !Number.isFinite(box.width);
  let left = 0;
  let right = 0;
  /** In a multicol container, the widest box that spans its columns. */
  const spanning = box.style.columns !== 0 && box.kind === 'block';
  let across = 0;
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (child.outOfFlow) continue;
    // what sits in the lines is measured with them, indent and all: an
    // inline-block after a negative `text-indent` ends where its line does
    if (lines && (isInlineLevel(child) || child.isFloat)) continue;
    const margins = child.marginLeft + child.marginRight;
    const own = Number.isFinite(child.width) ? child.width + margins : 0;
    const style = child.style;
    // a minimum's percentage is of zero here (CSS Sizing 3 5.2.1), which
    // leaves a `calc()` its pixels
    const min =
      style.minWidth === 0 || style.minWidth === AUTO
        ? 0
        : resolve(style.minWidth, 0) + contentExtra(child);
    let contribution: number;
    // A width of its own is what a child contributes, whatever its content
    // does past it (CSS Sizing 3 5.1); a percentage one is cyclic here and
    // counts as `auto`, so its content decides.
    if (typeof style.width === 'number') {
      contribution = Math.max(own, min + margins);
      // And it is that width where the box was laid out at less. In a row
      // of flex items it was shrunk to fit the width this is measured at,
      // and what an item gives its flex box's own size is its width (CSS
      // Flexbox 9.9.3); under a percentage `max-width` it was cut short,
      // by a percentage of the size being worked out, which is none to
      // what a box contributes (5.2.1). But a replaced box's is of nothing
      // at its least and none at its most: as it was laid out.
      const cyclic = typeof style.maxWidth === 'object';
      if (cyclic ? child.kind !== 'replaced' : row) {
        let stated = style.width + contentExtra(child);
        if (typeof style.maxWidth === 'number') {
          stated = Math.min(stated, style.maxWidth + contentExtra(child));
        }
        stated = Math.max(stated, child.horizontalExtra, min);
        contribution = Math.max(contribution, stated + margins);
      }
    } else {
      let inner =
        intrinsicWidth(child, seen, narrowest) + child.horizontalExtra;
      if (typeof style.maxWidth === 'number') {
        inner = Math.min(inner, style.maxWidth + contentExtra(child));
      }
      if (min > inner) inner = min;
      contribution = Math.max(inner + margins, own);
    }
    if (spanning && spansColumns(child)) {
      // across the columns, and no part of what a column is as wide as
      across = Math.max(across, contribution);
      continue;
    }
    if (row && !wraps) {
      total += contribution;
      items += 1;
    } else if (wraps || !sideBySide) widest = Math.max(widest, contribution);
    else if (child.isFloat) {
      const clear = style.clear;
      if (clear !== 'none') {
        widest = Math.max(widest, left + right);
        if (clear !== 'right') left = 0;
        if (clear !== 'left') right = 0;
      }
      if (style.float === 'right') right += contribution;
      else left += contribution;
    } else {
      const beside = establishesBFC(child) ? left + right : 0;
      widest = Math.max(widest, beside + contribution, left + right);
      left = 0;
      right = 0;
    }
  }
  widest = Math.max(widest, left + right);
  if (row && items) {
    const gap = gapOf(box.style.columnGap, NaN);
    widest = Math.max(widest, total + gap * (items - 1));
  }
  // A multicol container is as wide as its columns side by side, each as
  // wide as its content or as `column-width` where that is wider, and the
  // gaps between them (as Blink measures one,
  // `NGColumnLayoutAlgorithm::ComputeMinMaxSizes`)
  if (box.style.columns && box.kind === 'block') {
    const count = box.style.columnCount ?? 1;
    const gap = box.style.columnGapNormal
      ? box.style.fontSize
      : gapOf(box.style.columnGap, NaN);
    widest = Math.max(widest, box.style.columnWidth ?? 0);
    // and no narrower than a box that spans them
    widest = Math.max(widest * count + gap * (count - 1), across);
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
function sizeReplaced(
  box: Box,
  containingWidth: number,
  /** The room `stretch` fills: the containing block's width, or less of
   *  it beside floats (CSS Sizing 3, 4.2). */
  stretchRoom = containingWidth,
): void {
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
  // `stretch` is what the margins leave of the containing block, as a
  // content box, and of its height where that is definite
  const stretchedHeight =
    style.heightKeyword === 'stretch' ? stretchHeight(box) : null;
  const stretchedWidth = Number.isFinite(stretchRoom)
    ? Math.max(
        0,
        stretchRoom - box.marginLeft - box.marginRight - box.horizontalExtra,
      )
    : null;
  const width =
    style.widthKeyword === 'stretch' && stretchedWidth !== null
      ? stretchedWidth
      : across(style.width);
  const height =
    stretchedHeight !== null
      ? Math.max(0, stretchedHeight - box.verticalExtra)
      : down(style.height);
  const minW =
    (style.minWidthKeyword === 'stretch' ? stretchedWidth : null) ??
    across(style.minWidth) ??
    0;
  const minH = down(style.minHeight) ?? 0;
  // a maximum below the minimum is the minimum (10.4)
  const maxW = Math.max(
    minW,
    style.maxWidthKeyword === 'stretch' && stretchedWidth !== null
      ? stretchedWidth
      : style.maxWidth === 'none'
        ? Infinity
        : (across(style.maxWidth) ?? Infinity),
  );
  const maxH = Math.max(
    minH,
    style.maxHeight === 'none' ? Infinity : (down(style.maxHeight) ?? Infinity),
  );
  // under size containment, as though it had no size or ratio of its own
  // but the one `contain-intrinsic-size` gives it (CSS Containment 2, 3.2)
  const own = contained(box, CONTAIN_SIZE)
    ? {
        width: style.containIntrinsicWidth ?? 0,
        height: style.containIntrinsicHeight ?? 0,
        ratio: 0,
        missing: 0,
      }
    : (box.intrinsic ?? NO_INTRINSIC);
  const iw = own.missing & 1 ? null : own.width;
  const ih = own.missing & 2 ? null : own.height;
  // `aspect-ratio` over its own, unless written `auto` and it has one
  const aspect = style.aspectRatio;
  const pages = aspect !== null && !(aspect.auto && own.ratio > 0);
  const ratio = pages ? aspect.ratio : own.ratio;
  // A ratio of the page's is of the box `box-sizing` names (CSS Sizing 4,
  // 5.1): one axis's content size to the other's goes through the border
  // box there. Written with `auto`, it is of the content box, as the
  // replaced element's own is, whichever it is.
  const outer = pages && !aspect.auto && style.boxSizing === 'border-box';
  const ox = outer ? box.horizontalExtra : 0;
  const oy = outer ? box.verticalExtra : 0;
  const widthOf = (h: number): number => Math.max(0, (h + oy) * ratio - ox);
  const heightOf = (w: number): number => Math.max(0, (w + ox) / ratio - oy);
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
      h = ih ?? heightOf(iw);
    } else if (ih !== null) {
      h = ih;
      w = widthOf(ih);
    } else {
      // a ratio and no size: CSS 2.1 leaves it undefined and suggests the
      // width a block would have, which is what browsers do — or, where the
      // containing block waits on this box, the default object size
      w = Number.isFinite(containingWidth) ? room() : own.width;
      h = heightOf(w);
    }
    [w, h] = constrained(w, h, minW, maxW, minH, maxH);
  } else {
    // one axis set, or no ratio: the width, clamped, and then the height
    // from the width that was used (10.3.2's "the rules above are applied
    // again" for a limit)
    const usedHeight = height === null ? null : clamp(height, minH, maxH);
    if (width !== null) w = width;
    else if (usedHeight !== null && ratio > 0) w = widthOf(usedHeight);
    else if (box.replaced === 'hr') w = room();
    else w = own.width;
    w = clamp(w, minW, maxW);
    if (usedHeight !== null) h = usedHeight;
    else if (ratio > 0) h = clamp(heightOf(w), minH, maxH);
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
  sizeFloat(box, ctx, containingWidth);
  placeFloat(box, floats, y, containingLeft, containingWidth);
}

/** Lay a float out at its own width, and answer its outer width. */
function sizeFloat(
  box: Box,
  ctx: LayoutContext,
  containingWidth: number,
): number {
  resolveEdges(box, containingWidth);
  if (box.kind === 'replaced') sizeReplaced(box, containingWidth);
  else layoutOwn(box, ctx, shrinkToFitWidth(box, ctx, containingWidth));
  return box.width + box.marginLeft + box.marginRight;
}

/** Put a float that is laid out as high as it goes from `y`, and to its
 *  side, and note it in the float context. */
function placeFloat(
  box: Box,
  floats: FloatContext,
  y: number,
  containingLeft: number,
  containingWidth: number,
): void {
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
  // A right float in content measured at no width limit stands at an
  // infinite x, where its box is not put: a box at infinity cannot be moved
  // back, so everything in it was laid out again at its next layout — at
  // every level of a nest of such floats, the innermost as many times as
  // there were levels. What a measure reads of it is its width, and the
  // float context keeps where it stands.
  moveTo(
    box,
    Number.isFinite(x) ? x : band.left + box.marginLeft,
    top + box.marginTop,
  );
  floats.add({
    left: x - box.marginLeft,
    right: x - box.marginLeft + outerWidth,
    top,
    bottom: top + box.height + box.marginTop + box.marginBottom,
    side: box.style.float === 'right' ? 'right' : 'left',
  });
}

/** Whether a box is a form control's: a replaced box for what draws it,
 *  a widget, and an inline block for how it is sized. */
function isControl(box: Box): boolean {
  switch (box.replaced) {
    case 'input':
    case 'textarea':
    case 'select':
    case 'button':
    case 'checkbox':
    case 'radio':
      return true;
    default:
      return false;
  }
}

/**
 * An absolutely positioned box, against its containing block: a box's
 * padding box, or an inline box's fragments (`inlineContainingBlock`). An
 * axis with neither offset takes the static position, where the box would
 * have been in flow (`placeStatic`, and `staticPositions` in a line).
 */
function layoutPositioned(box: Box, containing: Box, ctx: LayoutContext): void {
  // a grid's is the box's grid area (CSS Grid 1, 9.1), whether the box is
  // the grid's child or deeper in it
  const area =
    containing.kind === 'inline' ? null : gridArea(box, containing, ctx);
  const {
    x: cbX,
    y: cbY,
    width: cbWidth,
    height: cbHeight,
  } = containing.kind === 'inline'
    ? inlineContainingBlock(containing, box, ctx)
    : (area ?? containingRect(containing, ctx));
  resolveEdges(box, cbWidth);
  box.percentHeightBase = cbHeight;

  const style = box.style;
  const left = resolveOrNull(style.left, cbWidth);
  const right = resolveOrNull(style.right, cbWidth);
  const top = resolveOrNull(style.top, cbHeight);
  const bottom = resolveOrNull(style.bottom, cbHeight);

  // with neither offset on an axis, the box is where the flow would have
  // put it (CSS 2.1 10.3.7, 10.6.4): against its start edge, which is the
  // right one in a right-to-left flow. A grid's own child is aligned in its
  // grid area instead, where that is its containing block; a box deeper in
  // the grid is where its own flow put it.
  const inArea =
    area !== null &&
    box.staticPosition?.inside !== undefined &&
    box.staticPosition.from === containing;
  const at = inArea ? null : box.staticPosition;
  const rtl = (at?.from ?? containing).style.direction === 'rtl';
  // where the box is as a flex box's or a grid's one item, aligned in it —
  // or in its grid area
  const room = inArea
    ? {
        x: cbX,
        y: cbY,
        width: cbWidth,
        height: cbHeight,
        ...staticAlignment(box, containing, false),
      }
    : at?.inside
      ? { ...insideRect(at.from, at.inside.box), ...at.inside }
      : null;
  // and a shrink-to-fit box's room starts at the offset on the side it has
  // one, or at its static position: `left: 50%` leaves it half the width
  const offset =
    left ??
    right ??
    (!at
      ? 0
      : rtl
        ? cbX + cbWidth - (at.from.x + at.right)
        : at.from.x + at.x - cbX);

  let width: number;
  let stretched = NaN;
  if (style.width !== AUTO) {
    width = blockWidth(box, cbWidth, cbWidth, ctx);
  } else if (style.widthKeyword === 'stretch') {
    // what its offsets and margins leave of its containing block — an
    // `auto` offset leaving all it has, but where both are, the start is
    // its static position (CSS Position 3, 4.1)
    const start = left ?? (right === null ? offset : 0);
    const room =
      cbWidth - start - (right ?? 0) - box.marginLeft - box.marginRight;
    width = clampWidth(box, Math.max(0, room), cbWidth, ctx);
  } else if (style.widthKeyword || ratioWidth(box) !== null) {
    // an intrinsic size, which both offsets do not stretch, or a height of
    // its own through its ratio
    width = shrinkToFitWidth(box, ctx, cbWidth, offset);
  } else if (
    boxRatio(box) &&
    (left === null || right === null) &&
    top !== null &&
    bottom !== null
  ) {
    // the height its offsets leave it through its ratio, where its width
    // has no pair of them to stretch it (CSS Sizing 4, 5.1)
    const fill = clampHeight(
      box,
      Math.max(0, cbHeight - top - bottom - box.marginTop - box.marginBottom),
    );
    width = ratioMinimum(
      box,
      clampWidth(box, widthFromHeight(box, fill)!, cbWidth, ctx),
      cbWidth,
      ctx,
    );
  } else if (left !== null && right !== null) {
    stretched = Math.max(
      0,
      cbWidth - left - right - box.marginLeft - box.marginRight,
    );
    // within its least and greatest width, which make it a width as one
    // set would, and the margins' rules run again with it (CSS 2.1 10.4) —
    // and those of its height, through a ratio (CSS Sizing 4, 5.1)
    width = clampWidth(box, transferredWidth(box, stretched), cbWidth, ctx);
  } else {
    width = shrinkToFitWidth(box, ctx, cbWidth, offset);
  }

  // `stretch` down: what its offsets leave, from its static position where
  // it has neither
  if (
    style.heightKeyword === 'stretch' ||
    style.minHeightKeyword === 'stretch'
  ) {
    STRETCH_TOP.set(
      box,
      top ?? (bottom === null && at ? at.from.y + at.y - cbY : 0),
    );
  }
  // A form control is an inline block to CSS and no replaced element,
  // whatever draws it (HTML's rendering section): with both offsets and no
  // size of its own it fills what they leave, as any box does, where an
  // image keeps its own (10.3.8, 10.6.5). A page lays an invisible
  // `<select>` over a picker it draws, `position: absolute; inset: 0`, to
  // take the press, and it has to cover it.
  const control = isControl(box);
  if (box.kind === 'replaced') {
    sizeReplaced(box, cbWidth);
    stretchReplaced(
      box,
      style.widthKeyword === 'stretch' ||
        (control &&
          style.width === AUTO &&
          style.widthKeyword === null &&
          left !== null &&
          right !== null)
        ? width
        : null,
      cbWidth,
    );
  } else layoutOwn(box, ctx, width);

  let x: number;
  if (
    left !== null &&
    right !== null &&
    (style.width !== AUTO ||
      style.widthKeyword !== null ||
      box.kind === 'replaced' ||
      width !== stretched)
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
          : room
            ? alignedIn(
                room.x,
                room.width,
                room.across,
                box.width + box.marginLeft + box.marginRight,
                rtl,
              ) + box.marginLeft
            : rtl
              ? (at ? at.from.x + at.right : cbX + cbWidth) -
                box.width -
                box.marginRight
              : (at ? at.from.x + at.x : cbX) + box.marginLeft;
  }
  let y: number;
  if (top !== null && bottom !== null) {
    const fill = Math.max(
      0,
      cbHeight - top - bottom - box.marginTop - box.marginBottom,
    );
    // — a box with a ratio has its height from its width, and a table is
    // as tall as its rows, as it is as wide as its columns between two
    // offsets: `normal` stretches neither (Blink: "Replaced/tables don't
    // stretch in abspos", `out_of_flow_layout_part.cc`), and a table taken
    // to the height its offsets leave was that tall around rows that were
    // not
    const stretches =
      style.height === AUTO &&
      (box.kind !== 'replaced' || control) &&
      box.kind !== 'table' &&
      !boxRatio(box);
    // both offsets and no height: the box fills what they leave, its
    // `auto` margins nothing (10.6.4, rule 5) — unless `min-height` or
    // `max-height` moves that, which makes it a height like one set, and
    // the rules run again with it (10.7)
    if (stretches) {
      box.height = clampHeight(box, fill);
      centreButton(box);
    }
    if (!stretches || box.height !== fill) {
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
          : room
            ? alignedIn(
                room.y,
                room.height,
                room.down,
                box.height + box.marginTop + box.marginBottom,
                false,
              ) + box.marginTop
            : (at ? at.from.y + at.y : cbY) + box.marginTop;
  }
  moveTo(box, x, y);
}

/** A box's content box or its padding box, as its layout left them. */
function insideRect(
  box: Box,
  which: 'content' | 'padding',
): { x: number; y: number; width: number; height: number } {
  if (which === 'content') {
    return {
      x: box.contentX,
      y: box.contentY,
      width: box.contentWidth,
      height: Math.max(0, box.height - box.verticalExtra),
    };
  }
  return {
    x: box.x + box.borderLeft,
    y: box.y + box.borderTop,
    width: Math.max(0, box.width - box.borderLeft - box.borderRight),
    height: Math.max(0, box.height - box.borderTop - box.borderBottom),
  };
}

/** Where a margin box of a size starts in a room, `along` of the free room
 *  before it from the room's start — its right end where `rtl`. */
function alignedIn(
  start: number,
  size: number,
  along: number,
  outer: number,
  rtl: boolean,
): number {
  const free = size - outer;
  return rtl ? start + size - outer - along * free : start + along * free;
}

/**
 * The grid area a box positioned in a grid takes for its containing block
 * (CSS Grid 1, 9.1): between the lines its placement names, where the grid
 * has them, and the grid's padding edge where a line is `auto`, is no line
 * of the grid, or is only a `span`. Null for a box whose containing block
 * is no grid.
 */
function gridArea(
  box: Box,
  containing: Box,
  ctx: LayoutContext,
): CbRect | null {
  const tracks = GRID_TRACKS.get(containing);
  if (!tracks) return null;
  const style = box.style;
  const pad = containingRect(containing, ctx);
  const [x, width] = areaSpan(
    style.gridColumnStart,
    style.gridColumnEnd,
    tracks.cols,
    tracks.colLines,
    containing.contentX,
    pad.x,
    pad.width,
  );
  const [y, height] = areaSpan(
    style.gridRowStart,
    style.gridRowEnd,
    tracks.rows,
    tracks.rowLines,
    containing.contentY,
    pad.y,
    pad.height,
  );
  return { x, y, width, height };
}

/** One axis of a grid area: its start and its size in document
 *  coordinates. A line is a track's start where it starts one and a
 *  track's end where it ends one, so a gap is in neither; a line by name
 *  is the one the placement would take. */
function areaSpan(
  start: GridLine,
  end: GridLine,
  tracks: readonly [number, number][],
  lines: GridLines,
  origin: number,
  edge: number,
  size: number,
): [number, number] {
  const count = tracks.length;
  // a line the grid has, or null for auto, a span and one it has not
  const at = (line: GridLine, side: 'start' | 'end'): number | null => {
    const index = lineOf(lines, line, side);
    return index !== null && count > 0 && index >= 0 && index <= count
      ? index
      : null;
  };
  const spanOf = (line: GridLine) => (line && 'span' in line ? line : null);
  let from = at(start, 'start');
  let to = at(end, 'end');
  const startSpan = spanOf(start);
  const endSpan = spanOf(end);
  if (from === null && to !== null && startSpan) {
    const f =
      startSpan.name !== undefined
        ? spanToName(lines, startSpan.name, startSpan.span, to, false)
        : to - startSpan.span;
    from = f >= 0 ? f : null;
  }
  if (to === null && from !== null && endSpan) {
    const t =
      endSpan.name !== undefined
        ? spanToName(lines, endSpan.name, endSpan.span, from, true)
        : from + endSpan.span;
    to = t <= count ? t : null;
  }
  if (from !== null && to !== null && to < from) [from, to] = [to, from];
  const a =
    from === null
      ? edge
      : origin + (from < count ? tracks[from][0] : tracks[from - 1][1]);
  const b =
    to === null || to === from
      ? edge + size
      : origin + (to >= 1 ? tracks[to - 1][1] : tracks[0][0]);
  return [a, Math.max(0, b - a)];
}

/** A containing block's rectangle, in document coordinates. */
interface CbRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The containing block a box that lays itself out gives: its padding box
 * (CSS 2.1 10.1), not its content box — `left: 0` in a padded box is at
 * its padding edge — and with nothing positioned around it the initial
 * one, as tall as the viewport rather than as the document, which a fixed
 * box's is too.
 */
function containingRect(containing: Box, ctx: LayoutContext): CbRect {
  // a layout that reads the viewport's height lays out differently in
  // another (`LayoutResult.readsViewportHeight`)
  if (!containing.parent) ctx.readViewportHeight = true;
  return {
    x: containing.x + containing.borderLeft,
    y: containing.y + containing.captionTop + containing.borderTop,
    width: Math.max(
      0,
      containing.width - containing.borderLeft - containing.borderRight,
    ),
    height: !containing.parent
      ? ctx.viewportHeight
      : Math.max(
          0,
          containing.height -
            containing.captionTop -
            containing.captionBottom -
            containing.borderTop -
            containing.borderBottom,
        ),
  };
}

/**
 * The containing block a `position: relative` inline box gives (CSS 2.1
 * 10.1, item 4): from the padding edge its first fragment starts at to the
 * one its last ends at, over the top of the first and the bottom of the
 * last. The box lays nothing out of its own — its fragments are on its
 * block's lines — so read as a box that does, it was a rectangle of no size
 * at the page's corner, and a tooltip under a positioned link came up
 * there. A box with no fragment at all stands where the box inside it
 * would have been in flow.
 */
function inlineContainingBlock(
  inline: Box,
  box: Box,
  ctx: LayoutContext,
): CbRect {
  let block = inline.parent;
  while (block && block.kind === 'inline') block = block.parent;
  const face = ctx.fonts ? faceExtentOf(ctx.fonts, inline.style) : null;
  let first: CbRect | null = null;
  let last: CbRect | null = null;
  for (const line of block?.lines ?? []) {
    const span = spanOn(line, inline);
    if (!span) continue;
    let top = line.y;
    let bottom = line.y + line.height;
    if (face) {
      const baseline =
        line.y +
        line.baseline -
        (LINE_BOX_RAISES.get(line)?.get(inline) ?? BOX_RAISES.get(inline) ?? 0);
      top = baseline - face.ascent - inline.padTop;
      bottom = baseline + face.descent + inline.padBottom;
    }
    const rect = {
      x: span[0],
      y: top,
      width: span[1] - span[0],
      height: bottom - top,
    };
    first ??= rect;
    last = rect;
  }
  if (!first || !last) {
    const at = box.staticPosition;
    const x = at ? at.from.x + at.x : 0;
    const y = at ? at.from.y + at.y : 0;
    const height = face ? face.ascent + face.descent : 0;
    return { x, y, width: 0, height };
  }
  const rtl = inline.style.direction === 'rtl';
  const start = rtl ? first.x + first.width : first.x;
  const end = rtl ? last.x : last.x + last.width;
  let x = Math.min(start, end);
  let width = Math.abs(end - start);
  if (rtl ? end > start : end < start) {
    // the last fragment ends before the first begins, which CSS 2.1 leaves
    // undefined: both, then, as a browser takes them
    x = Math.min(first.x, last.x);
    width = Math.max(first.x + first.width, last.x + last.width) - x;
  }
  return { x, y: first.y, width, height: last.y + last.height - first.y };
}

/** How far an inline box's padding box reaches across a line, left and
 *  right; null where nothing of it is on the line. */
function spanOn(line: LineBox, inline: Box): [number, number] | null {
  let left = Infinity;
  let right = -Infinity;
  for (const text of line.texts) {
    const natural = text.layout.lines[text.layoutLine];
    const boxAt = text.spans.boxAt;
    if (!natural || !boxAt) continue;
    const x = text.drawX + natural.x;
    for (const run of natural.runs) {
      const owner = boxAt.call(text.spans, run.start);
      if (!owner || !holds(inline, owner)) continue;
      left = Math.min(left, x + run.x);
      right = Math.max(right, x + run.x + run.width);
    }
  }
  for (const placed of line.atomics) {
    if (!holds(inline, placed.box)) continue;
    left = Math.min(left, placed.x - placed.box.marginLeft);
    right = Math.max(
      right,
      placed.x + placed.box.width + placed.box.marginRight,
    );
  }
  for (const edge of line.edges ?? []) {
    if (edge.box !== inline) {
      if (!holds(inline, edge.box)) continue;
      left = Math.min(left, edge.x);
      right = Math.max(right, edge.x + edge.width);
      continue;
    }
    // its own: the padding edge, inside the margin and the border
    const onLeft =
      (edge.side === 'start') !== (inline.style.direction === 'rtl');
    if (onLeft) {
      const at = edge.x + inline.marginLeft + inline.borderLeft;
      left = Math.min(left, at);
      right = Math.max(right, at);
    } else {
      const at = edge.x + edge.width - inline.marginRight - inline.borderRight;
      left = Math.min(left, at);
      right = Math.max(right, at);
    }
  }
  return left <= right ? [left, right] : null;
}

/**
 * Lay out the floats in a block's inline content and give its positioned
 * boxes their static positions — at any depth of inline box, which lays
 * nothing out of its own: a float or an absolute box inside a `<span>` is
 * the paragraph's as much as one beside it. Met only among the block's own
 * children, one in an inline box was never laid out at all, and stood at
 * the page's corner with no size.
 */
/** Give the absolute boxes in a block's inline content their static
 *  position, and answer whether the content holds a float. */
function placeOutOfLine(
  parent: Box,
  block: Box,
  ctx: LayoutContext,
  contentTop: number,
  contentWidth: number,
  contentLeft: number,
): boolean {
  let floated = false;
  for (const child of parent.children) {
    if (child.outOfFlow) {
      placeStatic(child, block, contentLeft, contentWidth, contentTop);
      ctx.positioned.push({
        box: child,
        containing: containingBlockFor(child) ?? block,
      });
    } else if (child.isFloat) {
      floated = true;
    } else if (child.kind === 'inline' && ctx.nestedOutOfLine) {
      const inner = placeOutOfLine(
        child,
        block,
        ctx,
        contentTop,
        contentWidth,
        contentLeft,
      );
      floated ||= inner;
    }
  }
  return floated;
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

/**
 * An absolutely positioned child of a flex box or a grid, laid out once the
 * flow is: against its own containing block, which the box is only where
 * it is positioned, from where it is as the box's one item — at the start
 * of a flex box's content box (CSS Flexbox 4.1), of a grid's padding box
 * (CSS Grid 1, 9.1). Pushed against the box whatever it was, one in a
 * static flex box was placed from the box's corner, and `fixed` one from
 * a grid.
 */
export function positionOutOfFlow(
  child: Box,
  container: Box,
  ctx: LayoutContext,
  flex: boolean,
): void {
  if (flex) {
    placeStatic(
      child,
      container,
      container.contentX,
      container.contentWidth,
      container.contentY,
    );
  } else {
    placeStatic(
      child,
      container,
      container.x + container.borderLeft,
      container.width - container.borderLeft - container.borderRight,
      container.y + container.borderTop,
    );
  }
  child.staticPosition!.inside = {
    box: flex ? 'content' : 'padding',
    ...staticAlignment(child, container, flex),
  };
  ctx.positioned.push({
    box: child,
    containing: containingBlockFor(child) ?? container,
  });
}

/** How far along its free room a flex box's or a grid's one item is set:
 *  0 at the start, ½ in the middle, 1 at the end, across (from the inline
 *  start) and down. A flex box's main axis by `justify-content`, and the
 *  cross by `align-self`; a grid's by `justify-self` and `align-self`,
 *  each falling back to the container's `-items`. */
function staticAlignment(
  child: Box,
  container: Box,
  flex: boolean,
): { across: number; down: number } {
  const own = child.style;
  const style = container.style;
  const factor = (align: string): number =>
    align === 'flex-end' ? 1 : align === 'center' ? 0.5 : 0;
  const cross = factor(
    own.alignSelf === AUTO ? style.alignItems : own.alignSelf,
  );
  if (!flex) {
    const justify =
      own.justifySelf === 'auto' ? style.justifyItems : own.justifySelf;
    return { across: factor(justify), down: cross };
  }
  const justify = style.justifyContent;
  let main =
    justify === 'flex-end' || justify === 'end' || justify === 'right'
      ? 1
      : justify === 'center' ||
          justify === 'space-around' ||
          justify === 'space-evenly'
        ? 0.5
        : 0;
  if (style.flexDirection.endsWith('-reverse')) main = 1 - main;
  return style.flexDirection.startsWith('row')
    ? { across: main, down: cross }
    : { across: cross, down: main };
}

/** The nearest positioned ancestor, or null for the initial containing
 *  block. Walks the box tree rather than the DOM, so an anonymous box in
 *  between is transparent — which is what the spec means by "the nearest
 *  positioned ancestor". */
function containingBlockFor(box: Box): Box | null {
  // a fixed box's is the viewport, whatever is positioned around it — but
  // a transformed box is one for it too, and one with layout or paint
  // containment (CSS Containment 2, 3.3)
  const fixed = box.style.position === 'fixed';
  let node = box.parent;
  while (node) {
    if (
      (!fixed && node.style.position !== 'static') ||
      transformed(node.style) ||
      contained(node, CONTAIN_LAYOUT | CONTAIN_PAINT) ||
      node.parent === null
    ) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

/** The size containments that hold a box's width: `size` and
 *  `inline-size`. */
const CONTAIN_WIDTH = CONTAIN_SIZE | CONTAIN_INLINE_SIZE;

/**
 * Whether a box has any of the containments `bits` names, as they apply
 * to it (CSS Containment 2, 3): none to an inline box that is no atomic
 * one, and none to a table's inner parts but a cell — nor size
 * containment to a table or a cell.
 */
export function contained(box: Box, bits: number): boolean {
  if (!(box.style.contain & bits)) return false;
  switch (box.kind) {
    case 'block':
    case 'flex':
    case 'replaced':
      return true;
    case 'table':
    case 'table-cell':
      return !!(box.style.contain & bits & ~CONTAIN_WIDTH);
    default:
      return false;
  }
}

/** Move a box and everything under it, keeping the subtree's shape. */
export function moveTo(box: Box, x: number, y: number): void {
  // A position only a probe of an unbounded width comes to — a column after
  // an infinitely wide one — is no place to move a box to: it stays where
  // it is, since the probe only wants its size, and the pass after moves it
  // from somewhere finite (see `placeBlock`).
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  translate(box, x - box.x, y - box.y);
}

/**
 * Move what a box holds down, and not the box: a table cell's content
 * sits where its `vertical-align` puts it, in a box that fills the row, and
 * a button's in the middle of its own (`centreButton`).
 *
 * The static positions the box gave the absolutely positioned boxes in its
 * flow go down with the content: each is where its box "would have been in
 * the normal flow" (CSS 2.1 10.6.4), and the flow is what moved. They are
 * kept from the box's own corner, which stays, so that moving the boxes
 * alone left them behind: a badge with no offsets in a `vertical-align:
 * middle` cell stood at the cell's top, over an icon 22px further down.
 *
 * It adds to where the content stands, so it is asked for once for each
 * layout of the box, which puts the content and the static positions back
 * at the top. A table lays a cell out and moves its content in one pass
 * over its cells, however many times a pass lays the table out, and one
 * whose layout is kept (`kept`) is moved whole, the cell with it; a button
 * counts how far down its content stands (`centreButton`).
 */
export function moveContent(box: Box, dy: number): void {
  if (!dy) return;
  translate(box, 0, dy);
  box.y -= dy;
  moveStatics(box, box, dy);
}

/** Whether a box is a `<button>`'s own, laid out as a block container: the
 *  one HTML's button layout sets an anonymous button content box in. Not
 *  the text in it, whose element is the button too; not a button that is a
 *  flex box or a grid, which has no such box; nor an `<input type=button>`,
 *  which is a widget of its label's size. */
function isButtonBlock(box: Box): boolean {
  return box.kind === 'block' && box.el !== null && box.el.name === 'button';
}

/** How tall a `<button>`'s content came to, and how far down its content
 *  box it stands for being centred in it (`centreButton`). */
const BUTTON_CONTENT = new WeakMap<Box, { height: number; down: number }>();

/**
 * Centre a `<button>`'s content down its content box, where the box is the
 * taller: a button's content is in an anonymous box of its own that is
 * "centered vertically" where it "does not overflow in the vertical axis"
 * (HTML 15.5.5, button layout), and is at the top where it does. Blink
 * moves a button's children down by half the room left, clamped at none
 * (`AlignBlockContent`); set at the top as any block's is, the two lines of
 * a 60px sidebar picker on nextjs.org sat 4px high in it.
 *
 * Asked for when the button is laid out, and again wherever its height is
 * given to it afterwards — a flex or a grid item stretched to its line, or
 * put back to the height it was measured at, and an absolute box between
 * two offsets: the content moves by the difference from where it was last
 * put. A button that is a flex box or a grid has no such box, and its
 * content is where its own alignment puts it.
 */
export function centreButton(box: Box): void {
  if (!isButtonBlock(box)) return;
  const content = BUTTON_CONTENT.get(box);
  if (content === undefined) return;
  const down = Math.max(0, (box.contentHeight - content.height) / 2);
  const by = down - content.down;
  if (by === 0 || !Number.isFinite(by)) return;
  content.down = down;
  // and the static positions kept from its corner with it: a menu under a
  // button's label opens under the label, where the label went
  moveContent(box, by);
}

/** Move the static positions a block gave the absolutely positioned boxes
 *  in its flow, at any depth of inline box, which are kept from its own
 *  corner and not from its content's (`moveContent`). One from a box
 *  inside it is kept from that box's corner, which moved with the rest. */
function moveStatics(parent: Box, block: Box, dy: number): void {
  for (const child of parent.children) {
    if (child.outOfFlow) {
      if (child.staticPosition?.from === block) child.staticPosition.y += dy;
    } else if (child.kind === 'inline') moveStatics(child, block, dy);
  }
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
  // the pieces columns broke it in, which are kept beside it
  if (columned.any) {
    const pieces = COLUMN_PIECES.get(box);
    if (pieces) {
      for (const piece of pieces) {
        piece.x += dx;
        piece.y += dy;
        piece.wholeY += dy;
      }
    }
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
  box.bottomStrut = null;
  // A table's parts but its caption have no margins, and its rows and row
  // groups no padding either (CSS 2.1 8.3, 8.4): a cell set `margin: 50px`
  // left a gap in its table that no browser draws. The values stay theirs,
  // for a cell to inherit (`padding: inherit`); they only do nothing here.
  if (
    box.kind === 'table-cell' ||
    box.kind === 'table-row' ||
    box.kind === 'table-row-group'
  ) {
    box.marginTop = 0;
    box.marginRight = 0;
    box.marginBottom = 0;
    box.marginLeft = 0;
    if (box.kind !== 'table-cell') {
      box.padTop = 0;
      box.padRight = 0;
      box.padBottom = 0;
      box.padLeft = 0;
    }
  }
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
    d === 'inline-table' ||
    // an image told to be a table's part is inline (CSS Display 3, 2.4)
    (box.kind === 'replaced' && d.startsWith('table-'))
  );
}

/** Whether a box establishes a block formatting context — contains its own
 *  floats, and does not collapse margins through its edges. */
export function establishesBFC(box: Box): boolean {
  const style = box.style;
  if (scrolls(style)) return true;
  if (style.flowRoot) return true;
  // layout and paint containment make an independent formatting context
  if (contained(box, CONTAIN_LAYOUT | CONTAIN_PAINT)) return true;
  // `continue: collapse` makes a block container a formatting context of
  // its own (CSS Overflow 4, 5.3)
  if (style.lineClamp !== null) return true;
  if (style.float !== 'none') return true;
  if (style.position === 'absolute' || style.position === 'fixed') return true;
  // a multicol container (CSS Multi-column 1, 2), and a box that spans
  // one's columns (6)
  if (style.columns && box.kind === 'block') return true;
  if (style.columnSpan && box.parent?.style.columns) return true;
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
  // a flex item, and a grid's: each an independent formatting context, which
  // the margins of what it holds stay inside (CSS Flexbox 1, 4; CSS Grid 1,
  // 6.1)
  if (box.parent?.kind === 'flex' && !box.outOfFlow) return true;
  // The root element establishes the document's formatting context. Here it
  // is a box below the synthetic initial containing block, so it is named:
  // without it, <html>'s own margin collapsed with <body>'s first block's.
  if (box.el?.name === 'html') return true;
  // a button's content is in a formatting context of its own, the
  // anonymous button content box's (HTML 15.5.5), whatever its `display`
  if (isButtonBlock(box)) return true;
  return box.parent === null;
}

/** What a box's `position: relative` offset moves it by, applied after
 *  layout so it does not affect anything else's position — which is the
 *  whole of what makes it *relative* — and its translation with it, and
 *  where `position: sticky` puts one at rest (`stickyOffset`). */
export function applyRelativeOffsets(
  box: Box,
  viewportWidth: number,
  viewportHeight: number,
): void {
  for (const child of box.children)
    applyRelativeOffsets(child, viewportWidth, viewportHeight);
  const style = box.style;
  if (transformed(style) && box.kind !== 'inline') {
    // a transform moves the box it is on, and an inline box is none
    const [dx, dy] = translationOf(box);
    if (dx || dy) {
      translate(box, dx, dy);
      movedOffLine(box);
    }
  }
  if (style.position !== 'relative' && style.position !== 'sticky') return;
  const [dx, dy] =
    style.position === 'sticky'
      ? stickyOffset(box, viewportWidth, viewportHeight)
      : relativeOffset(box);
  if (!(dx || dy)) return;
  translate(box, dx, dy);
  if (box.kind !== 'inline') {
    movedOffLine(box);
    return;
  }
  offsetInline(box, dx, dy);
  // the blocks it was broken around move with it (9.2.1.1)
  const blocks = box.cut ? CUT_BLOCKS.get(box) : undefined;
  if (blocks) for (const block of blocks) translate(block, dx, dy);
}

// what makes a box a containing block and a layer, as a positioned box is,
// is asked here by the layouts beside this one
export { transformed };

/** How far a box's transform moves it — `translate`, and the translation
 *  its `transform` comes to with its turns and scales: a percentage is of
 *  its own border box (CSS Transforms 1, 7). The rest of the transform is
 *  paint's (`placedMatrix`). */
function translationOf(box: Box, style = box.style): [number, number] {
  if (!transformed(style)) return [0, 0];
  const m = matrixOf(style, box.width, box.height);
  return [m[4], m[5]];
}

/**
 * The matrix a box is painted through, in the document's coordinates: what
 * its transform does besides move it — a turn, a scale, a skew — about its
 * `transform-origin`, where layout has put it (`applyRelativeOffsets`). Null
 * for a box that only moves, which is every box but a few, and for an
 * inline box, which no transform applies to (CSS Transforms 1, 2: a
 * transformable element is no inline box).
 */
export function placedMatrix(box: Box): Matrix | null {
  const style = box.style;
  if (
    style.transform === null &&
    style.rotate === null &&
    style.scale === null
  ) {
    return null;
  }
  if (box.kind === 'inline' || box.kind === 'text' || box.kind === 'break') {
    return null;
  }
  const linear = linearOf(style);
  if (!linear) return null;
  const origin = style.transformOrigin;
  return about(
    linear,
    box.x + resolve(origin[0], box.width, 0),
    box.y + resolve(origin[1], box.height, 0),
  );
}

/**
 * Move a laid-out box, and everything in it, by how far its translation
 * changed when its style went from `was` to the one it has — what
 * `applyRelativeOffsets` moves it by now, less what it moved it by then.
 * For a style changed in place, where nothing else moves (a `transform` is
 * what makes that true). Not for an inline box, whose text is what moves.
 */
export function retranslate(box: Box, was: ComputedStyle): void {
  const [x0, y0] = translationOf(box, was);
  const [x1, y1] = translationOf(box);
  if (x1 === x0 && y1 === y0) return;
  translate(box, x1 - x0, y1 - y0);
  movedOffLine(box);
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
 * Where `position: sticky` puts a box at rest (CSS Positioned Layout 3,
 * 3.4): moved only as far as keeps its border box inside the sticky view
 * rectangle — its nearest scroll container's scrollport, scrolled to its
 * start, less its insets — and no further than keeps its margin box in its
 * containing block, `top` winning over `bottom` and the start side over the
 * end. Nothing here scrolls a box the document holds, so for one of those
 * this is where the box stays. The viewport does scroll, and the document
 * with it, and a sticky box does not follow: against the viewport only its
 * `top` and its start side are kept, which at rest put a box as a browser
 * does, while a `bottom: 0` would pin a footer to the middle of the page
 * once it was scrolled. Taken as `relative`, a box stood its `top` below
 * where a browser starts it: Wikipedia's contents, 24px low.
 */
function stickyOffset(
  box: Box,
  viewportWidth: number,
  viewportHeight: number,
): [number, number] {
  const style = box.style;
  // the scroll container a sticky box keeps to: the nearest box that
  // scrolls, or the viewport, whose are the root's and the body's overflow
  let port = box.parent;
  while (port && !scrolls(port.style)) port = port.parent;
  const tag = port?.el?.name;
  const inside = !!port && tag !== 'html' && tag !== 'body';
  let cb = box.parent;
  while (cb && cb.kind === 'inline') cb = cb.parent;
  if (!cb) return [0, 0];
  // the scrollport, at its start: a scroll container's padding box, or
  // the viewport, which the document's top is at
  const px = port && inside ? port.x + port.borderLeft : 0;
  const py = port && inside ? port.y + port.borderTop : 0;
  const pw =
    port && inside
      ? port.width - port.borderLeft - port.borderRight
      : viewportWidth;
  const ph =
    port && inside
      ? port.height - port.borderTop - port.borderBottom
      : viewportHeight;
  const dx = stuck(
    box.x,
    box.width,
    box.marginLeft,
    box.marginRight,
    cb.contentX,
    cb.contentWidth,
    px,
    pw,
    resolveOrNull(style.left, pw),
    inside ? resolveOrNull(style.right, pw) : null,
    // `left` wins where both hold, or `right` in a right-to-left block
    cb.style.direction !== 'rtl',
  );
  const dy = stuck(
    box.y,
    box.height,
    box.marginTop,
    box.marginBottom,
    cb.contentY,
    cb.contentHeight,
    py,
    ph,
    resolveOrNull(style.top, ph),
    inside ? resolveOrNull(style.bottom, ph) : null,
    true,
  );
  return [dx, dy];
}

/**
 * How far a sticky box moves along one axis: toward the end until its
 * start edge is `start` inside the scrollport's, or toward the start until
 * its end edge is `end` inside the scrollport's, each no further than its
 * margin box stays in its containing block — and where both would move
 * it, `startWins` says which does.
 */
function stuck(
  at: number,
  size: number,
  marginStart: number,
  marginEnd: number,
  cbAt: number,
  cbSize: number,
  portAt: number,
  portSize: number,
  start: number | null,
  end: number | null,
  startWins: boolean,
): number {
  let byStart = 0;
  if (start !== null && Number.isFinite(start) && at < portAt + start) {
    const room = cbAt + cbSize - (at + size + marginEnd);
    byStart = Math.max(0, Math.min(portAt + start - at, room));
  }
  let byEnd = 0;
  if (end !== null && Number.isFinite(end)) {
    const over = at + size - (portAt + portSize - end);
    const room = at - marginStart - cbAt;
    if (over > 0) byEnd = -Math.max(0, Math.min(over, room));
  }
  return startWins ? byStart || byEnd : byEnd || byStart;
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
      markMovedOff(lines, line);
    }
  }
}

/** Mark the line an inline-block or an image a box moved off was placed
 *  on, where it was on one: the line stays, and the box is drawn where it
 *  went (`MOVED_OFF_LINES`). */
function movedOffLine(box: Box): void {
  let block = box.parent;
  while (block && block.kind === 'inline') block = block.parent;
  const lines = block?.lines;
  if (!lines) return;
  for (const line of lines) {
    for (const placed of line.atomics) {
      if (placed.box !== box) continue;
      markMovedOff(lines, line);
      return;
    }
  }
}

function markMovedOff(lines: LineBox[], line: LineBox): void {
  const moved = MOVED_OFF_LINES.get(lines);
  if (moved) moved.add(line);
  else MOVED_OFF_LINES.set(lines, new Set([line]));
}

/** Whether `inner` is `outer` or inside it. */
function holds(outer: Box, inner: Box): boolean {
  for (let at: Box | null = inner; at; at = at.parent) {
    if (at === outer) return true;
  }
  return false;
}
