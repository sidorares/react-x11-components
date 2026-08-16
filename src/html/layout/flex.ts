// `display: flex`, delegated to Yoga.
//
// This is the one formatting context here that is *not* written out, and the
// reason is that the engine is already in the process. react-x11 lays every
// box out with Yoga, ntk owns the instance, and `react-x11/ntk` re-exports it
// precisely so an extension does not bring a second copy — "two copies means
// two Yoga instances and two font caches", in core's own words. So a flex
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
import { Yoga } from 'react-x11/ntk';

import { AUTO, isPct, resolveOrNull } from '../css/values.js';
import type { ComputedStyle } from '../css/style.js';
import { Box } from './boxes.js';
import { moveTo, resolveEdges } from './block.js';
import type { LayoutContext } from './block.js';

/** The slice of Yoga this uses. ntk ships no declarations for it and
 *  `react-x11/ntk` types it as a loose record, so the shape is written out
 *  here rather than asserted at every call. */
interface YogaNode {
  insertChild(child: YogaNode, index: number): void;
  setMeasureFunc(
    fn:
      | ((
          w: number,
          wm: number,
          h: number,
          hm: number,
        ) => { width: number; height: number })
      | null,
  ): void;
  setFlexDirection(v: number): void;
  setFlexWrap(v: number): void;
  setJustifyContent(v: number): void;
  setAlignItems(v: number): void;
  setAlignSelf(v: number): void;
  setAlignContent(v: number): void;
  setFlexGrow(v: number): void;
  setFlexShrink(v: number): void;
  setFlexBasis(v: number): void;
  setFlexBasisPercent(v: number): void;
  setFlexBasisAuto(): void;
  setWidth(v: number): void;
  setWidthPercent(v: number): void;
  setWidthAuto(): void;
  setHeight(v: number): void;
  setHeightPercent(v: number): void;
  setHeightAuto(): void;
  setMinWidth(v: number): void;
  setMaxWidth(v: number): void;
  setMinHeight(v: number): void;
  setMaxHeight(v: number): void;
  setMargin(edge: number, v: number): void;
  setPadding(edge: number, v: number): void;
  setBorder(edge: number, v: number): void;
  setGap(gutter: number, v: number): void;
  setDisplay(v: number): void;
  calculateLayout(width: number, height: number, direction: number): void;
  getComputedLeft(): number;
  getComputedTop(): number;
  getComputedWidth(): number;
  getComputedHeight(): number;
  freeRecursive(): void;
}

interface YogaApi {
  Node: { create(): YogaNode };
  FLEX_DIRECTION_ROW: number;
  FLEX_DIRECTION_ROW_REVERSE: number;
  FLEX_DIRECTION_COLUMN: number;
  FLEX_DIRECTION_COLUMN_REVERSE: number;
  WRAP_NO_WRAP: number;
  WRAP_WRAP: number;
  WRAP_WRAP_REVERSE: number;
  JUSTIFY_FLEX_START: number;
  JUSTIFY_FLEX_END: number;
  JUSTIFY_CENTER: number;
  JUSTIFY_SPACE_BETWEEN: number;
  JUSTIFY_SPACE_AROUND: number;
  JUSTIFY_SPACE_EVENLY: number;
  ALIGN_AUTO: number;
  ALIGN_FLEX_START: number;
  ALIGN_FLEX_END: number;
  ALIGN_CENTER: number;
  ALIGN_STRETCH: number;
  ALIGN_BASELINE: number;
  ALIGN_SPACE_BETWEEN: number;
  ALIGN_SPACE_AROUND: number;
  EDGE_TOP: number;
  EDGE_RIGHT: number;
  EDGE_BOTTOM: number;
  EDGE_LEFT: number;
  GUTTER_ROW: number;
  GUTTER_COLUMN: number;
  DIRECTION_LTR: number;
  DIRECTION_RTL: number;
  MEASURE_MODE_UNDEFINED: number;
  MEASURE_MODE_EXACTLY: number;
  MEASURE_MODE_AT_MOST: number;
  DISPLAY_FLEX: number;
  DISPLAY_NONE: number;
}

const Y = Yoga as unknown as YogaApi;

/**
 * Lay out a flex container's children. Returns the content height.
 *
 * Falls back to nothing — that is, the caller's block path never sees this —
 * when Yoga's assembly has not loaded. ntk loads it during `createClient()`,
 * so the only way to reach that is a mock backend with no client at all,
 * where there are no pixels to be wrong about anyway.
 */
export function layoutFlex(
  box: Box,
  ctx: LayoutContext,
  contentWidth: number,
): number {
  if (!Y?.Node?.create) return layoutAsBlockFallback(box, ctx, contentWidth);

  const root = Y.Node.create();
  applyContainer(root, box.style);
  root.setWidth(contentWidth);
  const height = resolveOrNull(box.style.height, NaN);
  if (height !== null) root.setHeight(height);
  else root.setHeightAuto();

  const items: { box: Box; node: YogaNode }[] = [];
  for (const child of box.children) {
    if (child.kind === 'text' && !child.text.trim()) continue;
    if (child.outOfFlow) {
      ctx.positioned.push({ box: child, containing: box });
      continue;
    }
    const node = Y.Node.create();
    resolveEdges(child, contentWidth);
    applyItem(node, child, ctx, contentWidth);
    root.insertChild(node, items.length);
    items.push({ box: child, node });
  }

  root.calculateLayout(
    contentWidth,
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

function applyContainer(node: YogaNode, style: ComputedStyle): void {
  node.setFlexDirection(
    FLEX_DIRECTION[style.flexDirection] ?? Y.FLEX_DIRECTION_ROW,
  );
  node.setFlexWrap(WRAP[style.flexWrap] ?? Y.WRAP_NO_WRAP);
  node.setJustifyContent(JUSTIFY[style.justifyContent] ?? Y.JUSTIFY_FLEX_START);
  node.setAlignItems(ALIGN[style.alignItems] ?? Y.ALIGN_STRETCH);
  node.setAlignContent(ALIGN[style.alignContent] ?? Y.ALIGN_STRETCH);
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
  node.setMargin(Y.EDGE_TOP, box.marginTop);
  node.setMargin(Y.EDGE_RIGHT, box.marginRight);
  node.setMargin(Y.EDGE_BOTTOM, box.marginBottom);
  node.setMargin(Y.EDGE_LEFT, box.marginLeft);
  node.setFlexGrow(style.flexGrow);
  node.setFlexShrink(style.flexShrink);
  if (style.alignSelf !== AUTO)
    node.setAlignSelf(ALIGN[style.alignSelf] ?? Y.ALIGN_AUTO);

  setLength(
    style.width,
    containingWidth,
    node.setWidth.bind(node),
    node.setWidthPercent.bind(node),
    node.setWidthAuto.bind(node),
  );
  setLength(
    style.height,
    NaN,
    node.setHeight.bind(node),
    node.setHeightPercent.bind(node),
    node.setHeightAuto.bind(node),
  );
  const minWidth = resolveOrNull(style.minWidth, containingWidth);
  if (minWidth !== null) node.setMinWidth(minWidth);
  if (style.maxWidth !== 'none') {
    const maxWidth = resolveOrNull(style.maxWidth, containingWidth);
    if (maxWidth !== null) node.setMaxWidth(maxWidth);
  }
  const minHeight = resolveOrNull(style.minHeight, NaN);
  if (minHeight !== null) node.setMinHeight(minHeight);
  if (style.maxHeight !== 'none') {
    const maxHeight = resolveOrNull(style.maxHeight, NaN);
    if (maxHeight !== null) node.setMaxHeight(maxHeight);
  }

  if (style.flexBasis === 'content') node.setFlexBasisAuto();
  else if (style.flexBasis === AUTO) node.setFlexBasisAuto();
  else if (isPct(style.flexBasis))
    node.setFlexBasisPercent(style.flexBasis.pct);
  else node.setFlexBasis(style.flexBasis);

  // The item's padding and border belong to Yoga so it can size the item,
  // and to this engine so it can paint it. Both read the same numbers.
  node.setPadding(Y.EDGE_TOP, box.padTop);
  node.setPadding(Y.EDGE_RIGHT, box.padRight);
  node.setPadding(Y.EDGE_BOTTOM, box.padBottom);
  node.setPadding(Y.EDGE_LEFT, box.padLeft);
  node.setBorder(Y.EDGE_TOP, box.borderTop);
  node.setBorder(Y.EDGE_RIGHT, box.borderRight);
  node.setBorder(Y.EDGE_BOTTOM, box.borderBottom);
  node.setBorder(Y.EDGE_LEFT, box.borderLeft);

  // Yoga asks; this engine answers. That is the whole of the bridge, and it
  // is what lets a paragraph be a flex item without flex knowing what a
  // paragraph is.
  node.setMeasureFunc((w, wm, h, hm) => {
    void h;
    void hm;
    const available =
      wm === Y.MEASURE_MODE_UNDEFINED || !Number.isFinite(w) ? Infinity : w;
    return measureBox(box, ctx, available);
  });
}

function setLength(
  len: ComputedStyle['width'],
  base: number,
  setPx: (v: number) => void,
  setPercent: (v: number) => void,
  setAuto: () => void,
): void {
  if (len === AUTO) {
    setAuto();
    return;
  }
  if (isPct(len)) {
    setPercent(len.pct);
    return;
  }
  void base;
  setPx(len);
}

/**
 * Lay a box out at a width and report the size it came to — the measure
 * function's body, and also how a settled item is finally laid out. The two
 * are the same call on purpose: an element that reports one size and then
 * draws another is the bug this shape makes impossible.
 */
function measureBox(
  box: Box,
  ctx: LayoutContext,
  available: number,
): { width: number; height: number } {
  ctx.layoutSubtree(box, available);
  return { width: box.width, height: box.height };
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
