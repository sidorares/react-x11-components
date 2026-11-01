// The one line of a flex box, laid out as Yoga lays it out, with no Yoga.
//
// A flex box that does not wrap has nothing left in it that is long or
// subtle: `resolveLine` shares its line out, and the rest is arithmetic over
// items that are leaves, each answering a measure function. What it cost was
// the bridge. A node and a measure callback for each item, every style set
// one call at a time, two or three layouts a box, each answer read back a
// number at a time, at every layout of the box: on a webmail page a fifth of
// what a drag of a window's edge spends in layout, for some 560 flex boxes a
// width, 99% of which have one line.
//
// So a `LineNode` is a Yoga node to `layoutFlex`, which sets it up, asks it and
// reads it as it does a real one and is otherwise none the wiser: every
// correction made to what Yoga answers is made to what this answers. Which is
// why this is Yoga's algorithm and not CSS Flexbox's (`calculateLayoutImpl` in
// CalculateLayout.cpp, 3.2.1), down to its two passes over the free space and
// the cache that decides which questions reach a measure function. It keeps
// Yoga's order and Yoga's names, so that it reads against that file, and has
// been cut down by what a box here cannot be: its nodes are a root with no
// edges of its own and leaves, on one line, running from the start, with no
// overflow, no aspect ratio, no limit that is a percentage and no baseline.
// `onOneLine` says which boxes those are. Any other is Yoga's.
//
// And it takes Yoga's float32s, every sum in the order Yoga adds it. A double
// would come nearer a browser, and would come to another answer where a sum of
// flex factors rounds to nothing: Yoga divides by what is left of that
// (`resolveLine`), and what is left is its own digits. With these, `layoutFlex`
// is handed what it has always been handed, to the bit, which is what
// `test/html/flex-line.test.ts` holds it to.
import { Yoga } from 'react-x11/yoga';
import type { MeasureFunction, Node as YogaNode } from 'react-x11/yoga';

import type { ComputedStyle } from '../css/style.js';

const Y = Yoga;
const f = Math.fround;

/** What `layoutFlex` calls on a node of a box of one line. A box that wraps
 *  has Yoga's, and calls more. */
export type FlexNode = Pick<
  YogaNode,
  | 'calculateLayout'
  | 'free'
  | 'getComputedHeight'
  | 'getComputedLeft'
  | 'getComputedMargin'
  | 'getComputedTop'
  | 'getComputedWidth'
  | 'markDirty'
  | 'setAlignContent'
  | 'setAlignItems'
  | 'setAlignSelf'
  | 'setBorder'
  | 'setFlexBasis'
  | 'setFlexBasisAuto'
  | 'setFlexBasisPercent'
  | 'setFlexDirection'
  | 'setFlexGrow'
  | 'setFlexShrink'
  | 'setHeight'
  | 'setHeightAuto'
  | 'setHeightPercent'
  | 'setJustifyContent'
  | 'setMargin'
  | 'setMarginAuto'
  | 'setMaxHeight'
  | 'setMaxWidth'
  | 'setMeasureFunc'
  | 'setMinHeight'
  | 'setMinWidth'
  | 'setPadding'
  | 'setWidth'
  | 'setWidthAuto'
  | 'setWidthPercent'
> & {
  insertChild(child: FlexNode, index: number): void;
  setGap(gutter: number, gap: number): unknown;
};

/** Yoga's `SizingMode`: what a size handed to a node asks of it. */
const MAX_CONTENT = 0;
const FIT_CONTENT = 1;
const STRETCH_FIT = 2;

/** How near two lengths are the same to Yoga (`inexactEquals`). */
const SAME = f(0.0001);

/** A percentage of a length, to Yoga. */
const PERCENT = f(0.01);

/** How many answers a node keeps, but for the one it was laid out with. */
const KEPT = 8;

/** The larger of two lengths, either of which may be undefined. */
function most(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  return Number.isNaN(b) ? a : Math.max(a, b);
}

function same(a: number, b: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  return Math.abs(f(a - b)) < SAME;
}

/** A length within its limits, the greatest first: Yoga holds a size to its
 *  maximum before its minimum, a limit under nothing being none. */
function within(value: number, min: number, max: number): number {
  if (max >= 0 && value > max) return max;
  if (min >= 0 && value < min) return min;
  return value;
}

/** What `constrainMaxSizeForMode` makes of a size: `limit` is its node's
 *  maximum and margins, NaN where it has none. */
function cappedSize(mode: number, size: number, limit: number): number {
  if (Number.isNaN(limit)) return size;
  if (mode === MAX_CONTENT) return limit;
  return size < limit ? size : limit;
}

/** and of the mode it is asked in. */
function cappedMode(mode: number, limit: number): number {
  return mode === MAX_CONTENT && !Number.isNaN(limit) ? FIT_CONTENT : mode;
}

/** An answer a node keeps (Yoga's `CachedMeasurement`). */
interface Answer {
  availableWidth: number;
  availableHeight: number;
  widthMode: number;
  heightMode: number;
  computedWidth: number;
  computedHeight: number;
}

/** A length as Yoga has it: its points, its percentage, or undefined. */
function resolved(points: number, percent: number, base: number): number {
  return Number.isNaN(percent) ? points : f(f(percent * base) * PERCENT);
}

/** Yoga's `sizeIsExactAndMatchesOldMeasuredSize`,
 *  `oldSizeIsMaxContentAndStillFits` and `newSizeIsStricterAndStillValid`:
 *  whether a size asked of a node is answered by one it kept. */
function stillFits(
  mode: number,
  size: number,
  lastMode: number,
  lastSize: number,
  lastComputed: number,
): boolean {
  if (mode === STRETCH_FIT) return same(size, lastComputed);
  if (mode !== FIT_CONTENT) return false;
  if (lastMode === MAX_CONTENT) {
    return size >= lastComputed || same(size, lastComputed);
  }
  return (
    lastMode === FIT_CONTENT &&
    !Number.isNaN(lastSize) &&
    !Number.isNaN(size) &&
    !Number.isNaN(lastComputed) &&
    lastSize > size &&
    (lastComputed <= size || same(size, lastComputed))
  );
}

/** Layouts so far: a node forgets what it kept the first time a layout
 *  reaches it dirty (`size`). */
let generations = 0;

/** A box's root, or one of its items. */
export class LineNode implements FlexNode {
  private owner: LineNode | null = null;
  private items: LineNode[] = [];
  private measureFunc: MeasureFunction | null = null;

  private row = false;
  private justify: number = Y.JUSTIFY_FLEX_START;
  private alignItems: number = Y.ALIGN_STRETCH;
  private alignSelf: number = Y.ALIGN_AUTO;
  private rowGap = 0;
  private columnGap = 0;
  private grow = 0;
  private shrink = 0;
  /** What was set of them, NaN for nothing: a factor of 0 set where none was
   *  is a change to Yoga, which forgets what it kept for it, and so is a
   *  margin of 0 (`marginsSet`, by its edge). */
  private growSet = NaN;
  private shrinkSet = NaN;
  private marginsSet = 0;
  private basisPoints = NaN;
  private basisPercent = NaN;
  private widthPoints = NaN;
  private widthPercent = NaN;
  private heightPoints = NaN;
  private heightPercent = NaN;
  private minWidth = NaN;
  private maxWidth = NaN;
  private minHeight = NaN;
  private maxHeight = NaN;
  private marginLeft = 0;
  private marginTop = 0;
  private marginRight = 0;
  private marginBottom = 0;
  private autoLeft = false;
  private autoTop = false;
  private autoRight = false;
  private autoBottom = false;
  private paddingLeft = 0;
  private paddingTop = 0;
  private paddingRight = 0;
  private paddingBottom = 0;
  private borderLeft = 0;
  private borderTop = 0;
  private borderRight = 0;
  private borderBottom = 0;

  private dirty = true;
  private generation = -1;
  private flexBasis = NaN;
  private measuredWidth = 0;
  private measuredHeight = 0;
  private cachedLayout: Answer | null = null;
  private cached: Answer[] | null = null;
  private nextCached = 0;
  private left = 0;
  private top = 0;
  private computedWidth = 0;
  private computedHeight = 0;

  private touch(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.flexBasis = NaN;
    this.owner?.touch();
  }

  markDirty(): void {
    this.touch();
  }

  free(): void {}

  insertChild(child: LineNode, index: number): void {
    child.owner = this;
    this.items.splice(index, 0, child);
    this.touch();
  }

  setMeasureFunc(measure: MeasureFunction | null): void {
    this.measureFunc = measure;
    this.touch();
  }

  setFlexDirection(direction: number): void {
    const row = direction === Y.FLEX_DIRECTION_ROW;
    if (row === this.row) return;
    this.row = row;
    this.touch();
  }

  setJustifyContent(justify: number): void {
    if (justify === this.justify) return;
    this.justify = justify;
    this.touch();
  }

  setAlignItems(align: number): void {
    if (align === this.alignItems) return;
    this.alignItems = align;
    this.touch();
  }

  setAlignSelf(align: number): void {
    if (align === this.alignSelf) return;
    this.alignSelf = align;
    this.touch();
  }

  /** How lines are aligned, which is nothing to one that does not wrap. */
  setAlignContent(): void {}

  setGap(gutter: number, gap: number): void {
    if (gutter === Y.GUTTER_ROW) this.rowGap = f(gap);
    else this.columnGap = f(gap);
    this.touch();
  }

  setFlexGrow(grow?: number): void {
    const value = f(grow ?? NaN);
    if (Object.is(value, this.growSet)) return;
    this.growSet = value;
    this.grow = value || 0;
    this.touch();
  }

  setFlexShrink(shrink?: number): void {
    const value = f(shrink ?? NaN);
    if (Object.is(value, this.shrinkSet)) return;
    this.shrinkSet = value;
    this.shrink = value || 0;
    this.touch();
  }

  setFlexBasis(basis: number): void {
    const value = Number.isFinite(basis) ? f(basis) : NaN;
    if (Object.is(value, this.basisPoints) && Number.isNaN(this.basisPercent)) {
      return;
    }
    this.basisPoints = value;
    this.basisPercent = NaN;
    this.touch();
  }

  setFlexBasisPercent(percent: number): void {
    const value = f(percent);
    if (value === this.basisPercent) return;
    this.basisPoints = NaN;
    this.basisPercent = value;
    this.touch();
  }

  setFlexBasisAuto(): void {
    if (Number.isNaN(this.basisPoints) && Number.isNaN(this.basisPercent)) {
      return;
    }
    this.basisPoints = NaN;
    this.basisPercent = NaN;
    this.touch();
  }

  setWidth(width: number): void {
    const value = Number.isFinite(width) ? f(width) : NaN;
    if (Object.is(value, this.widthPoints) && Number.isNaN(this.widthPercent)) {
      return;
    }
    this.widthPoints = value;
    this.widthPercent = NaN;
    this.touch();
  }

  setWidthAuto(): void {
    if (Number.isNaN(this.widthPoints) && Number.isNaN(this.widthPercent)) {
      return;
    }
    this.widthPoints = NaN;
    this.widthPercent = NaN;
    this.touch();
  }

  setWidthPercent(percent: number): void {
    const value = f(percent);
    if (value === this.widthPercent) return;
    this.widthPoints = NaN;
    this.widthPercent = value;
    this.touch();
  }

  setHeight(height: number): void {
    const value = Number.isFinite(height) ? f(height) : NaN;
    if (
      Object.is(value, this.heightPoints) &&
      Number.isNaN(this.heightPercent)
    ) {
      return;
    }
    this.heightPoints = value;
    this.heightPercent = NaN;
    this.touch();
  }

  setHeightPercent(percent: number): void {
    const value = f(percent);
    if (value === this.heightPercent) return;
    this.heightPoints = NaN;
    this.heightPercent = value;
    this.touch();
  }

  setHeightAuto(): void {
    if (Number.isNaN(this.heightPoints) && Number.isNaN(this.heightPercent)) {
      return;
    }
    this.heightPoints = NaN;
    this.heightPercent = NaN;
    this.touch();
  }

  setMinWidth(width: number): void {
    const value = Number.isFinite(width) ? f(width) : NaN;
    if (Object.is(value, this.minWidth)) return;
    this.minWidth = value;
    this.touch();
  }

  setMaxWidth(width: number): void {
    const value = Number.isFinite(width) ? f(width) : NaN;
    if (Object.is(value, this.maxWidth)) return;
    this.maxWidth = value;
    this.touch();
  }

  setMinHeight(height: number): void {
    const value = Number.isFinite(height) ? f(height) : NaN;
    if (Object.is(value, this.minHeight)) return;
    this.minHeight = value;
    this.touch();
  }

  setMaxHeight(height: number): void {
    const value = Number.isFinite(height) ? f(height) : NaN;
    if (Object.is(value, this.maxHeight)) return;
    this.maxHeight = value;
    this.touch();
  }

  setMargin(edge: number, margin: number): void {
    const value = f(margin);
    const bit = 1 << edge;
    if (
      this.marginsSet & bit &&
      value === this.getComputedMargin(edge) &&
      !this.autoAt(edge)
    ) {
      return;
    }
    this.marginsSet |= bit;
    if (edge === Y.EDGE_LEFT) {
      this.marginLeft = value;
      this.autoLeft = false;
    } else if (edge === Y.EDGE_TOP) {
      this.marginTop = value;
      this.autoTop = false;
    } else if (edge === Y.EDGE_RIGHT) {
      this.marginRight = value;
      this.autoRight = false;
    } else {
      this.marginBottom = value;
      this.autoBottom = false;
    }
    this.touch();
  }

  setMarginAuto(edge: number): void {
    this.marginsSet |= 1 << edge;
    if (edge === Y.EDGE_LEFT) {
      this.marginLeft = 0;
      this.autoLeft = true;
    } else if (edge === Y.EDGE_TOP) {
      this.marginTop = 0;
      this.autoTop = true;
    } else if (edge === Y.EDGE_RIGHT) {
      this.marginRight = 0;
      this.autoRight = true;
    } else {
      this.marginBottom = 0;
      this.autoBottom = true;
    }
    this.touch();
  }

  setPadding(edge: number, padding: number): void {
    const value = f(padding);
    if (edge === Y.EDGE_LEFT) this.paddingLeft = value;
    else if (edge === Y.EDGE_TOP) this.paddingTop = value;
    else if (edge === Y.EDGE_RIGHT) this.paddingRight = value;
    else this.paddingBottom = value;
    this.touch();
  }

  setBorder(edge: number, border: number): void {
    const value = f(border);
    if (edge === Y.EDGE_LEFT) this.borderLeft = value;
    else if (edge === Y.EDGE_TOP) this.borderTop = value;
    else if (edge === Y.EDGE_RIGHT) this.borderRight = value;
    else this.borderBottom = value;
    this.touch();
  }

  private autoAt(edge: number): boolean {
    if (edge === Y.EDGE_LEFT) return this.autoLeft;
    if (edge === Y.EDGE_TOP) return this.autoTop;
    return edge === Y.EDGE_RIGHT ? this.autoRight : this.autoBottom;
  }

  getComputedLeft(): number {
    return this.left;
  }

  getComputedTop(): number {
    return this.top;
  }

  getComputedWidth(): number {
    return this.computedWidth;
  }

  getComputedHeight(): number {
    return this.computedHeight;
  }

  getComputedMargin(edge: number): number {
    if (edge === Y.EDGE_LEFT) return this.marginLeft;
    if (edge === Y.EDGE_TOP) return this.marginTop;
    return edge === Y.EDGE_RIGHT ? this.marginRight : this.marginBottom;
  }

  /** Its padding and borders across, as a style adds them up
   *  (`paddingAndBorderForAxis`). */
  private get padRow(): number {
    return f(
      f(this.paddingLeft + this.borderLeft) +
        f(this.paddingRight + this.borderRight),
    );
  }

  /** and down. */
  private get padColumn(): number {
    return f(
      f(this.paddingTop + this.borderTop) +
        f(this.paddingBottom + this.borderBottom),
    );
  }

  private get marginRow(): number {
    return f(this.marginLeft + this.marginRight);
  }

  private get marginColumn(): number {
    return f(this.marginTop + this.marginBottom);
  }

  /** Whether a maximum the same as its minimum is its size, as
   *  `processDimensions` has it. */
  private get pinnedWidth(): boolean {
    return !Number.isNaN(this.maxWidth) && same(this.maxWidth, this.minWidth);
  }

  private get pinnedHeight(): boolean {
    return (
      !Number.isNaN(this.maxHeight) && same(this.maxHeight, this.minHeight)
    );
  }

  private usedWidth(base: number): number {
    if (this.pinnedWidth) return this.maxWidth;
    return resolved(this.widthPoints, this.widthPercent, base);
  }

  private usedHeight(base: number): number {
    if (this.pinnedHeight) return this.maxHeight;
    return resolved(this.heightPoints, this.heightPercent, base);
  }

  /** Whether its size across its line is a percentage. */
  private percentAcross(row: boolean): boolean {
    return row
      ? !Number.isNaN(this.heightPercent) && !this.pinnedHeight
      : !Number.isNaN(this.widthPercent) && !this.pinnedWidth;
  }

  private boundWidth(value: number): number {
    return most(within(value, this.minWidth, this.maxWidth), this.padRow);
  }

  private boundHeight(value: number): number {
    return most(within(value, this.minHeight, this.maxHeight), this.padColumn);
  }

  /** `boundAxisWithinMinAndMax`, along its row or down its column. */
  private withinLimits(row: boolean, value: number): number {
    return row
      ? within(value, this.minWidth, this.maxWidth)
      : within(value, this.minHeight, this.maxHeight);
  }

  /** `boundAxis`: that, and no less than its padding and borders. */
  private bound(row: boolean, value: number): number {
    return row ? this.boundWidth(value) : this.boundHeight(value);
  }

  /** Its size along an axis, with its margins (`dimensionWithMargin`). */
  private outer(row: boolean): number {
    return row
      ? f(this.measuredWidth + this.marginRow)
      : f(this.measuredHeight + this.marginColumn);
  }

  /** The flex box's alignment of an item, which it may say of itself. */
  private alignmentOf(item: LineNode): number {
    const align =
      item.alignSelf === Y.ALIGN_AUTO ? this.alignItems : item.alignSelf;
    return align === Y.ALIGN_BASELINE && !this.row ? Y.ALIGN_FLEX_START : align;
  }

  /** Whether an answer it kept answers what it is asked now
   *  (`canUseCachedMeasurement`). */
  private answers(
    kept: Answer,
    availableWidth: number,
    availableHeight: number,
    widthMode: number,
    heightMode: number,
  ): boolean {
    if (kept.computedHeight < 0 || kept.computedWidth < 0) return false;
    if (!(
      (kept.widthMode === widthMode &&
        same(kept.availableWidth, availableWidth)) ||
      stillFits(
        widthMode,
        f(availableWidth - this.marginRow),
        kept.widthMode,
        kept.availableWidth,
        kept.computedWidth,
      )
    )) {
      return false;
    }
    return (
      (kept.heightMode === heightMode &&
        same(kept.availableHeight, availableHeight)) ||
      stillFits(
        heightMode,
        f(availableHeight - this.marginColumn),
        kept.heightMode,
        kept.availableHeight,
        kept.computedHeight,
      )
    );
  }

  /** Size a leaf, from what it kept where it can (`calculateLayoutInternal`). */
  private size(
    availableWidth: number,
    availableHeight: number,
    widthMode: number,
    heightMode: number,
    perform: boolean,
    generation: number,
  ): void {
    const visit = this.dirty && this.generation !== generation;
    if (visit) {
      this.nextCached = 0;
      this.cachedLayout = null;
    }
    let answer: Answer | null = null;
    if (
      this.cachedLayout !== null &&
      this.answers(
        this.cachedLayout,
        availableWidth,
        availableHeight,
        widthMode,
        heightMode,
      )
    ) {
      answer = this.cachedLayout;
    } else {
      for (let i = 0; i < this.nextCached; i += 1) {
        const kept = this.cached![i];
        if (
          this.answers(
            kept,
            availableWidth,
            availableHeight,
            widthMode,
            heightMode,
          )
        ) {
          answer = kept;
          break;
        }
      }
    }
    if (!visit && answer !== null) {
      this.measuredWidth = answer.computedWidth;
      this.measuredHeight = answer.computedHeight;
    } else {
      this.measure(availableWidth, availableHeight, widthMode, heightMode);
      if (answer === null) {
        if (this.nextCached === KEPT) this.nextCached = 0;
        const entry: Answer = {
          availableWidth,
          availableHeight,
          widthMode,
          heightMode,
          computedWidth: this.measuredWidth,
          computedHeight: this.measuredHeight,
        };
        if (perform) this.cachedLayout = entry;
        else {
          this.cached ??= [];
          this.cached[this.nextCached] = entry;
          this.nextCached += 1;
        }
      }
    }
    if (perform) {
      this.computedWidth = this.measuredWidth;
      this.computedHeight = this.measuredHeight;
      this.dirty = false;
    }
    this.generation = generation;
  }

  /** Yoga's `measureNodeWithMeasureFunc`, on a leaf. */
  private measure(
    availableWidth: number,
    availableHeight: number,
    widthMode: number,
    heightMode: number,
  ): void {
    const width =
      widthMode === MAX_CONTENT ? NaN : f(availableWidth - this.marginRow);
    const height =
      heightMode === MAX_CONTENT ? NaN : f(availableHeight - this.marginColumn);
    if (widthMode === STRETCH_FIT && heightMode === STRETCH_FIT) {
      this.measuredWidth = this.boundWidth(width);
      this.measuredHeight = this.boundHeight(height);
      return;
    }
    // as the layout holds them, added up another way than a style's
    const padRow = f(
      f(f(this.paddingLeft + this.paddingRight) + this.borderLeft) +
        this.borderRight,
    );
    const padColumn = f(
      f(f(this.paddingTop + this.paddingBottom) + this.borderTop) +
        this.borderBottom,
    );
    const size = this.measureFunc!(
      Number.isNaN(width) ? width : most(0, f(width - padRow)),
      widthMode === STRETCH_FIT
        ? Y.MEASURE_MODE_EXACTLY
        : widthMode === FIT_CONTENT
          ? Y.MEASURE_MODE_AT_MOST
          : Y.MEASURE_MODE_UNDEFINED,
      Number.isNaN(height) ? height : most(0, f(height - padColumn)),
      heightMode === STRETCH_FIT
        ? Y.MEASURE_MODE_EXACTLY
        : heightMode === FIT_CONTENT
          ? Y.MEASURE_MODE_AT_MOST
          : Y.MEASURE_MODE_UNDEFINED,
    );
    this.measuredWidth = this.boundWidth(
      widthMode === STRETCH_FIT
        ? width
        : f(most(0, f(size.width ?? NaN)) + padRow),
    );
    this.measuredHeight = this.boundHeight(
      heightMode === STRETCH_FIT
        ? height
        : f(most(0, f(size.height ?? NaN)) + padColumn),
    );
  }

  /** Yoga's `computeFlexBasisForChild`, for an item that is not alone in
   *  flexing. */
  private findFlexBasis(
    item: LineNode,
    width: number,
    widthMode: number,
    height: number,
    heightMode: number,
    generation: number,
  ): void {
    const row = this.row;
    const mainSize = row ? width : height;
    const basis = resolved(item.basisPoints, item.basisPercent, mainSize);
    const usedWidth = item.usedWidth(width);
    const usedHeight = item.usedHeight(height);
    const hasWidth = usedWidth >= 0;
    const hasHeight = usedHeight >= 0;
    if (!Number.isNaN(basis) && !Number.isNaN(mainSize)) {
      if (Number.isNaN(item.flexBasis)) {
        item.flexBasis = most(basis, row ? item.padRow : item.padColumn);
      }
      return;
    }
    if (row && hasWidth) {
      item.flexBasis = most(usedWidth, item.padRow);
      return;
    }
    if (!row && hasHeight) {
      item.flexBasis = most(usedHeight, item.padColumn);
      return;
    }
    let childWidth = NaN;
    let childHeight = NaN;
    let childWidthMode = MAX_CONTENT;
    let childHeightMode = MAX_CONTENT;
    if (hasWidth) {
      childWidth = f(usedWidth + item.marginRow);
      childWidthMode = STRETCH_FIT;
    }
    if (hasHeight) {
      childHeight = f(usedHeight + item.marginColumn);
      childHeightMode = STRETCH_FIT;
    }
    if (Number.isNaN(childWidth) && !Number.isNaN(width)) {
      childWidth = width;
      childWidthMode = FIT_CONTENT;
    }
    if (Number.isNaN(childHeight) && !Number.isNaN(height)) {
      childHeight = height;
      childHeightMode = FIT_CONTENT;
    }
    const stretched = this.alignmentOf(item) === Y.ALIGN_STRETCH;
    if (
      !row &&
      !hasWidth &&
      !Number.isNaN(width) &&
      widthMode === STRETCH_FIT &&
      stretched &&
      childWidthMode !== STRETCH_FIT
    ) {
      childWidth = width;
      childWidthMode = STRETCH_FIT;
    }
    if (
      row &&
      !hasHeight &&
      !Number.isNaN(height) &&
      heightMode === STRETCH_FIT &&
      stretched &&
      childHeightMode !== STRETCH_FIT
    ) {
      childHeight = height;
      childHeightMode = STRETCH_FIT;
    }
    const limitWidth = f(item.maxWidth + item.marginRow);
    const limitHeight = f(item.maxHeight + item.marginColumn);
    childWidth = cappedSize(childWidthMode, childWidth, limitWidth);
    childWidthMode = cappedMode(childWidthMode, limitWidth);
    childHeight = cappedSize(childHeightMode, childHeight, limitHeight);
    childHeightMode = cappedMode(childHeightMode, limitHeight);
    item.size(
      childWidth,
      childHeight,
      childWidthMode,
      childHeightMode,
      false,
      generation,
    );
    item.flexBasis = most(
      row ? item.measuredWidth : item.measuredHeight,
      row ? item.padRow : item.padColumn,
    );
  }

  /** Lay the box out, in the sizes it is given or none (`calculateLayout`). */
  calculateLayout(ownerWidth?: number, ownerHeight?: number): void {
    // nothing has changed, and a box asks in the same sizes every time
    if (!this.dirty) return;
    const owner = f(ownerWidth ?? NaN);
    const down = f(ownerHeight ?? NaN);
    generations += 1;
    let width: number;
    let widthMode: number;
    const across = this.usedWidth(owner);
    if (across >= 0) {
      width = across;
      widthMode = STRETCH_FIT;
    } else if (!Number.isNaN(this.maxWidth)) {
      width = this.maxWidth;
      widthMode = FIT_CONTENT;
    } else {
      width = owner;
      widthMode = Number.isNaN(width) ? MAX_CONTENT : STRETCH_FIT;
    }
    let height: number;
    let heightMode: number;
    const tall = this.usedHeight(down);
    if (tall >= 0) {
      height = tall;
      heightMode = STRETCH_FIT;
    } else if (!Number.isNaN(this.maxHeight)) {
      height = this.maxHeight;
      heightMode = FIT_CONTENT;
    } else {
      height = down;
      heightMode = Number.isNaN(height) ? MAX_CONTENT : STRETCH_FIT;
    }
    if (this.items.length === 0) {
      this.computedWidth = this.boundWidth(
        widthMode === STRETCH_FIT ? width : 0,
      );
      this.computedHeight = this.boundHeight(
        heightMode === STRETCH_FIT ? height : 0,
      );
    } else this.layOut(width, height, widthMode, heightMode, generations);
    this.dirty = false;
  }

  /** The room there is along an axis of the box, within its limits
   *  (`calculateAvailableInnerDimension`). */
  private inner(available: number, min: number, max: number): number {
    if (Number.isNaN(available)) return available;
    const room = Number.isNaN(max) ? available : Math.min(available, max);
    return Math.max(room, Number.isNaN(min) ? 0 : min);
  }

  /** Yoga's `calculateLayoutImpl`, on the root of a line of leaves. */
  private layOut(
    availableWidth: number,
    availableHeight: number,
    widthMode: number,
    heightMode: number,
    generation: number,
  ): void {
    const { items, row } = this;
    const count = items.length;
    const mainMode = row ? widthMode : heightMode;
    const crossMode = row ? heightMode : widthMode;
    const innerWidth = this.inner(availableWidth, this.minWidth, this.maxWidth);
    const innerHeight = this.inner(
      availableHeight,
      this.minHeight,
      this.maxHeight,
    );
    let innerMain = row ? innerWidth : innerHeight;
    const innerCross = row ? innerHeight : innerWidth;
    const gap = most(row ? this.columnGap : this.rowGap, 0);

    // step 3: each item's flex basis. One alone in flexing, which can grow
    // and shrink, starts from nothing, and fills what the others leave it.
    let alone: LineNode | null = null;
    if (mainMode === STRETCH_FIT) {
      for (const item of items) {
        if (item.grow === 0 && item.shrink === 0) continue;
        if (
          alone !== null ||
          Math.abs(item.grow) < SAME ||
          Math.abs(item.shrink) < SAME
        ) {
          alone = null;
          break;
        }
        alone = item;
      }
    }
    for (const item of items) {
      item.left = item.marginLeft;
      item.top = item.marginTop;
      if (item === alone) item.flexBasis = 0;
      else {
        this.findFlexBasis(
          item,
          innerWidth,
          widthMode,
          innerHeight,
          heightMode,
          generation,
        );
      }
    }

    // step 4: the line (`calculateFlexLine`)
    let consumed = 0;
    let autoMargins = 0;
    let totalGrow = 0;
    let totalShrink = 0;
    for (let i = 0; i < count; i += 1) {
      const item = items[i];
      if (row ? item.autoLeft : item.autoTop) autoMargins += 1;
      if (row ? item.autoRight : item.autoBottom) autoMargins += 1;
      consumed = f(
        consumed +
          f(
            f(
              item.withinLimits(row, item.flexBasis) +
                (row ? item.marginRow : item.marginColumn),
            ) + (i === 0 ? 0 : gap),
          ),
      );
      if (item.grow !== 0 || item.shrink !== 0) {
        totalGrow = f(totalGrow + item.grow);
        totalShrink = f(totalShrink + f(-item.shrink * item.flexBasis));
      }
    }
    if (totalGrow > 0 && totalGrow < 1) totalGrow = 1;
    if (totalShrink > 0 && totalShrink < 1) totalShrink = 1;

    // step 5: the room on it, and the flexible lengths
    let remaining = 0;
    let byContent = false;
    if (mainMode !== STRETCH_FIT) {
      const min = row ? this.minWidth : this.minHeight;
      const max = row ? this.maxWidth : this.maxHeight;
      if (!Number.isNaN(min) && consumed < min) innerMain = min;
      else if (!Number.isNaN(max) && consumed > max) innerMain = max;
      else {
        // a root has no flex of its own to grow by
        innerMain = consumed;
        byContent = true;
      }
    }
    if (!byContent && !Number.isNaN(innerMain)) {
      remaining = f(innerMain - consumed);
    } else if (consumed < 0) remaining = -consumed;

    // the first pass (`distributeFreeSpaceFirstPass`), which takes an item a
    // limit stops out of the sums and leaves what it took to the second
    let delta = 0;
    for (const item of items) {
      const basis = item.withinLimits(row, item.flexBasis);
      if (remaining < 0) {
        const scaled = f(-item.shrink * basis);
        if (scaled !== 0 && !Number.isNaN(scaled)) {
          const base = f(basis + f(f(remaining / totalShrink) * scaled));
          const bound = item.bound(row, base);
          if (!Number.isNaN(base) && !Number.isNaN(bound) && base !== bound) {
            delta = f(delta + f(bound - basis));
            totalShrink = f(totalShrink - f(-item.shrink * item.flexBasis));
          }
        }
      } else if (remaining > 0 && item.grow !== 0) {
        const base = f(basis + f(f(remaining / totalGrow) * item.grow));
        const bound = item.bound(row, base);
        if (!Number.isNaN(base) && !Number.isNaN(bound) && base !== bound) {
          delta = f(delta + f(bound - basis));
          totalGrow = f(totalGrow - item.grow);
        }
      }
    }
    const original = remaining;
    remaining = f(remaining - delta);

    // the second (`distributeFreeSpaceSecondPass`), which sizes each item
    let distributed = 0;
    for (const item of items) {
      const basis = item.withinLimits(row, item.flexBasis);
      let main = basis;
      if (remaining < 0) {
        const scaled = f(-item.shrink * basis);
        if (scaled !== 0) {
          main = item.bound(
            row,
            totalShrink === 0
              ? f(basis + scaled)
              : f(basis + f(f(remaining / totalShrink) * scaled)),
          );
        }
      } else if (remaining > 0 && item.grow !== 0) {
        main = item.bound(
          row,
          f(basis + f(f(remaining / totalGrow) * item.grow)),
        );
      }
      distributed = f(distributed + f(main - basis));

      const marginMain = row ? item.marginRow : item.marginColumn;
      const marginCross = row ? item.marginColumn : item.marginRow;
      const usedCross = row
        ? item.usedHeight(innerCross)
        : item.usedWidth(innerCross);
      const definite = usedCross >= 0;
      const stretched =
        this.alignmentOf(item) === Y.ALIGN_STRETCH &&
        !(row ? item.autoTop : item.autoLeft) &&
        !(row ? item.autoBottom : item.autoRight);
      let cross: number;
      let childCrossMode: number;
      if (
        !Number.isNaN(innerCross) &&
        !definite &&
        crossMode === STRETCH_FIT &&
        stretched
      ) {
        cross = innerCross;
        childCrossMode = STRETCH_FIT;
      } else if (!definite) {
        cross = innerCross;
        childCrossMode = Number.isNaN(cross) ? MAX_CONTENT : FIT_CONTENT;
      } else {
        cross = f(usedCross + marginCross);
        childCrossMode =
          Number.isNaN(cross) ||
          (item.percentAcross(row) && crossMode !== STRETCH_FIT)
            ? MAX_CONTENT
            : STRETCH_FIT;
      }
      const limitMain = f((row ? item.maxWidth : item.maxHeight) + marginMain);
      const limitCross = f(
        (row ? item.maxHeight : item.maxWidth) + marginCross,
      );
      const childMain = cappedSize(
        STRETCH_FIT,
        f(main + marginMain),
        limitMain,
      );
      cross = cappedSize(childCrossMode, cross, limitCross);
      childCrossMode = cappedMode(childCrossMode, limitCross);
      item.size(
        row ? childMain : cross,
        row ? cross : childMain,
        row ? STRETCH_FIT : childCrossMode,
        row ? childCrossMode : STRETCH_FIT,
        // one to be stretched across its line is laid out there
        definite || !stretched,
        generation,
      );
    }
    remaining = f(original - distributed);

    // step 6: along the line, and how tall it is (`justifyMainAxis`)
    if (mainMode === FIT_CONTENT && remaining > 0) {
      const min = row ? this.minWidth : this.minHeight;
      remaining = Number.isNaN(min)
        ? 0
        : most(0, f(min - f(innerMain - remaining)));
    }
    let lead = 0;
    let between = gap;
    const justify =
      remaining >= 0 ||
      (this.justify !== Y.JUSTIFY_SPACE_BETWEEN &&
        this.justify !== Y.JUSTIFY_SPACE_AROUND &&
        this.justify !== Y.JUSTIFY_SPACE_EVENLY)
        ? this.justify
        : Y.JUSTIFY_FLEX_START;
    if (autoMargins === 0) {
      if (justify === Y.JUSTIFY_CENTER) lead = f(remaining / 2);
      else if (justify === Y.JUSTIFY_FLEX_END) lead = remaining;
      else if (justify === Y.JUSTIFY_SPACE_BETWEEN) {
        if (count > 1) between = f(between + f(remaining / (count - 1)));
      } else if (justify === Y.JUSTIFY_SPACE_EVENLY) {
        lead = f(remaining / (count + 1));
        between = f(between + lead);
      } else if (justify === Y.JUSTIFY_SPACE_AROUND) {
        lead = f(f(0.5 * remaining) / count);
        between = f(between + f(lead * 2));
      }
    }
    let along = lead;
    let across = 0;
    for (let i = 0; i < count; i += 1) {
      const item = items[i];
      if ((row ? item.autoLeft : item.autoTop) && remaining > 0) {
        along = f(along + f(remaining / autoMargins));
      }
      if (row) item.left = f(item.left + along);
      else item.top = f(item.top + along);
      if (i < count - 1) along = f(along + between);
      if ((row ? item.autoRight : item.autoBottom) && remaining > 0) {
        along = f(along + f(remaining / autoMargins));
      }
      along = f(along + item.outer(row));
      across = most(across, item.outer(!row));
    }

    let crossOfBox = innerCross;
    if (crossMode !== STRETCH_FIT) crossOfBox = this.bound(!row, across);
    if (crossMode === STRETCH_FIT) across = innerCross;
    across = this.bound(!row, across);

    // step 7: across it
    for (const item of items) {
      const align = this.alignmentOf(item);
      const autoLead = row ? item.autoTop : item.autoLeft;
      const autoTrail = row ? item.autoBottom : item.autoRight;
      let leading = 0;
      if (align === Y.ALIGN_STRETCH && !autoLead && !autoTrail) {
        const used = row
          ? item.usedHeight(innerCross)
          : item.usedWidth(innerCross);
        if (!(used >= 0)) {
          const marginMain = row ? item.marginRow : item.marginColumn;
          const marginCross = row ? item.marginColumn : item.marginRow;
          const childMain = cappedSize(
            STRETCH_FIT,
            f((row ? item.measuredWidth : item.measuredHeight) + marginMain),
            f((row ? item.maxWidth : item.maxHeight) + marginMain),
          );
          const childCross = cappedSize(
            STRETCH_FIT,
            across,
            f((row ? item.maxHeight : item.maxWidth) + marginCross),
          );
          const width = row ? childMain : childCross;
          const height = row ? childCross : childMain;
          item.size(
            width,
            height,
            Number.isNaN(width) ? MAX_CONTENT : STRETCH_FIT,
            Number.isNaN(height) ? MAX_CONTENT : STRETCH_FIT,
            true,
            generation,
          );
        }
      } else {
        const left = f(crossOfBox - item.outer(!row));
        if (autoLead && autoTrail) leading = most(0, f(left / 2));
        else if (autoTrail) leading = 0;
        else if (autoLead) leading = most(0, left);
        else if (align === Y.ALIGN_FLEX_START) leading = 0;
        else if (align === Y.ALIGN_CENTER) leading = f(left / 2);
        else leading = left;
      }
      if (row) item.top = f(item.top + leading);
      else item.left = f(item.left + leading);
    }

    // step 9: the box
    this.computedWidth = this.boundWidth(availableWidth);
    this.computedHeight = this.boundHeight(availableHeight);
    if (mainMode !== STRETCH_FIT) {
      if (row) this.computedWidth = this.boundWidth(along);
      else this.computedHeight = this.boundHeight(along);
    }
    if (crossMode !== STRETCH_FIT) {
      if (row) this.computedHeight = this.boundHeight(across);
      else this.computedWidth = this.boundWidth(across);
    }
  }
}

/**
 * Whether a flex box is laid out on `LineNode`s: it does not wrap, and runs
 * from the start of a row or down a column, as the page reads. A box that
 * runs the other way, of either kind, is rare, and Yoga's.
 */
export function onOneLine(style: ComputedStyle): boolean {
  return (
    style.flexWrap === 'nowrap' &&
    style.direction !== 'rtl' &&
    (style.flexDirection === 'row' || style.flexDirection === 'column')
  );
}
