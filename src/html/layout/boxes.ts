// The box tree: what the DOM and the cascade become before layout runs.
//
// This is the phase that pays for itself twice. Building it is where the
// cascade is driven, where whitespace is collapsed, where anonymous boxes
// are generated and where every element's text is given its slice of the
// document-wide index the selection uses — all of which depend on the DOM
// and the stylesheets and **none of which depend on the width**. So a
// resize re-runs layout over this tree and skips all of it, and a repaint
// skips layout too. Three phases, three invalidation reasons:
//
//   DOM or CSS changed  → rebuild boxes, lay out, paint
//   width changed       → lay out, paint
//   damage only         → paint
//
// The document text is assembled here rather than by a later walk, for the
// reason richtext's node gives for answering from what it draws: an index
// built by a second traversal can disagree with the boxes, and a selection
// that disagrees with the glyphs is worse than no selection.
import type { Element } from 'domhandler';

import type { TextRun } from '../../richtext/index.js';
import {
  attr,
  childrenOf,
  isElement,
  isText,
  inImpliedHead,
  NON_RENDERED,
  tagOf,
} from '../dom.js';
import type { Cascade, FirstLetterRules } from '../css/cascade.js';
import type { CollapsedTable } from './collapse.js';
import { quoteAt } from '../css/content.js';
import type { CounterStyles } from '../css/counter-styles.js';
import type { ContentItem } from '../css/content.js';
import {
  CONTAIN_STYLE,
  FIRST_LINE_INHERITED,
  NO_MASK,
  copyStyle,
  firstLineParent,
  inherit,
} from '../css/style.js';
import { AUTO } from '../css/values.js';
import { svgIntrinsics } from '../svg.js';
import type { IntrinsicSize } from '../svg.js';
import type { ComputedStyle } from '../css/style.js';
import type { GridLines } from './grid-lines.js';

export type BoxKind =
  | 'block'
  | 'inline'
  | 'text'
  | 'replaced'
  | 'flex'
  | 'table'
  | 'table-row-group'
  | 'table-row'
  | 'table-cell'
  | 'table-caption'
  | 'marker'
  | 'break';

// What only a few boxes carry lives beside the box rather than in it: a box
// is made for every element and every run of text, and each field on it is
// memory every walk over the tree goes through — fifteen fields more, never
// read, made a document's first paint 6% slower.

/** A list item's marker: its text, a bullet or the item's number, and
 *  where it was laid out. */
export interface Marker {
  text: string;
  layout: TextLayoutLike | null;
  x: number;
  y: number;
  /** Its own style where a `::marker` rule gives it one; the item's where
   *  none does. */
  style: ComputedStyle | null;
  /** The image it is, `list-style-image`'s, at its size in device pixels,
   *  where that has arrived; its text is then not drawn. */
  image?: { url: string; width: number; height: number };
  /** Its text is its own — a string `list-style-type`, a `::marker`'s
   *  `content` — and ends at the content's edge, with no gap a number
   *  or a bullet is set apart by. */
  flush?: true;
}

/** An out-of-flow box's static position, as an offset from the box whose
 *  flow it was taken from, which may yet move. */
export interface StaticPosition {
  from: Box;
  x: number;
  right: number;
  y: number;
  /**
   * For a flex box's or a grid's child, the box it is where it would be as
   * the one item in — `from`'s content box or its padding box, whose size
   * is read once its layout is done — and how far along the free room in
   * it its alignment puts it, from the start across and from the top down.
   */
  inside?: {
    box: 'content' | 'padding';
    across: number;
    down: number;
  };
}

/** The ascent and descent of a decorated inline box's own face. */
export interface InlineDecoration {
  ascent: number;
  descent: number;
}

/**
 * A set of adjoining margins as CSS 2.1 8.3.1 collapses them: the largest
 * positive and the most negative, whose sum is the margin. Kept apart as
 * margins join, because summing at each join is not associative once the
 * signs mix: 2, -4 and 14 collapse to 10, and taken two at a time to 12,
 * and to 8 with a -4 after.
 */
export interface MarginStrut {
  pos: number;
  neg: number;
}

/** A laid-out line inside an inline formatting context. */
export interface LineBox {
  /** Content-box relative, resolved to document coordinates at paint. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** From the line's top — where a text engine's own lines carry theirs
   *  from the top of the layout. */
  baseline: number;
  /**
   * The text on this line, as one or more fragments.
   *
   * More than one whenever an atomic splits the text — `a <img> b` is two
   * fragments of two different `TextLayout`s on one line — which is why this
   * is a list rather than the single layout the common case would suggest.
   */
  texts: LineText[];
  /** Where this line's text sits in the document index, in **code units**. */
  textStart: number;
  textEnd: number;
  /** Atomic items sitting on this line — images, inline-blocks, controls. */
  atomics: AtomicPlacement[];
  /** The inline boxes that open or close on this line, where their own
   *  margin, border and padding sit. */
  edges?: EdgePlacement[];
  /** A `::first-line` style with a background, painted behind the line's
   *  content over its face's height, as an inline box's is. */
  background?: { style: ComputedStyle } & InlineDecoration;
  /** How wide the floats placed at this line's top are, side by side: what
   *  stands beside its content, and so what its content is measured with
   *  where a box is as wide as its content (`intrinsicWidth`). */
  floats?: number;
}

/**
 * One `TextLayout` line, placed on a line box.
 *
 * `drawX`/`drawY` are where the **layout's origin** sits in document
 * coordinates — not where this line sits — because ntk draws a layout, not a
 * line: `layout.draw(ctx, drawX, drawY)` emits every line it holds in one
 * glyph batch, which is exactly the batching that makes a paragraph one
 * composite instead of one per line. So the whole-paragraph case gives every
 * one of its lines the same `drawX`/`drawY` and paint draws it once; the
 * fragment case (text broken around an inline image) gives each fragment a
 * layout holding one line, and each is drawn where it was placed.
 */
export interface LineText {
  layout: TextLayoutLike;
  /** Which of `layout.lines` this fragment is. */
  layoutLine: number;
  /** Where the layout's origin lands, in document coordinates. */
  drawX: number;
  drawY: number;
  /** Document index of this fragment's first and last character, in code
   *  units. */
  textStart: number;
  textEnd: number;
  /** Code-unit offset within the layout's own text that `textStart` maps to,
   *  so a document index can be turned into a caret index in this layout. */
  layoutStart: number;
  /** Where in the layout's text an inline box's edge was laid out as a
   *  spacer: a unit of the layout that is no text of the document's
   *  (`documentOffsetOf`, `layoutOffsetOf`). */
  gaps?: number[];
  /**
   * The spaces `pre-wrap` keeps that this fragment's line ends on, which an
   * engine strips from a line's end as though CSS removed them there: each
   * one's offset in the layout's text and where it is, from the layout's
   * origin, beside the line's end in logical order (`hangPreserved`). They
   * are their inline box's, whose background and border cover them, and
   * the ones before a forced break that fit take room on the line.
   */
  hung?: { at: number; x: number; width: number }[];
  /** Any offset in the layout's own text as a document index — how a run
   *  under the pointer finds the element whose text it is. Per pass: the
   *  layout may be one an earlier pass made (`TextLayoutCache`), and the
   *  document index is this parse's. */
  spans: {
    documentAt(offset: number): number;
    /** The text box an offset's text is, where the layout knows. */
    boxAt?(offset: number): Box | null;
  };
}

export interface AtomicPlacement {
  box: Box;
  x: number;
  y: number;
  /** How far its `vertical-align` raises its baseline above its parent's,
   *  worked out as it joined the line; absent for none, and for `top` and
   *  `bottom`, which the line box's edges place instead. */
  raise?: number;
}

/**
 * Where an inline box's own margin, border and padding on one side sit on a
 * line: CSS 2.1 puts the start side's before the box's first fragment and the
 * end side's after its last, taking room on those lines (10.3.1). `x` is the
 * edge's outer side, margin included, and `width` all three.
 */
export interface EdgePlacement {
  box: Box;
  side: 'start' | 'end';
  x: number;
  width: number;
}

/** The slice of ntk's `TextLayout` this renderer reads. Structural for the
 *  reason every other element here types ntk structurally: ntk ships no
 *  declarations and this says what it needs and nothing more. */
export interface TextLayoutLike {
  width: number;
  height: number;
  lines: {
    x: number;
    y: number;
    height: number;
    baseline: number;
    width: number;
    /** Its width with the white space it ends on kept, in the item it
     *  ends: how far it moves the pen where text goes on after it on the
     *  same line. ntk's, from 8.17.0; an engine without it leaves it out. */
    advance?: number;
    ascent: number;
    descent: number;
    start: number;
    end: number;
    runs: {
      x: number;
      width: number;
      start: number;
      end: number;
      /** The span as handed in — a richtext `TextRun`, which is how the
       *  decoration a `<span>` carried reaches the paint pass on the same
       *  object the glyphs did. Optional, with `run`, for the reason
       *  `src/richtext/runs.ts` gives: react-x11's Cocoa engine hands back
       *  a run's geometry and nothing else. */
      span?: TextRun;
      run?: {
        font: { metrics(size: number): { ascent: number; descent: number } };
        size: number;
        direction?: 'ltr' | 'rtl';
      };
    }[];
  }[];
  draw(ctx: unknown, x?: number, y?: number): void;
  caretPosition(index: number): {
    x: number;
    y: number;
    height: number;
    line: number;
  };
  indexAt(x: number, y: number): number;
  /** Whether `maxLines` dropped content — the slow inline path's "did this
   *  segment wrap" question, answered without laying the tail out. */
  truncated?: boolean;
}

/**
 * One box. Fields are assigned rather than passed so the shape stays
 * monomorphic — every box has every field, which is what keeps the property
 * access in the layout and paint loops a fixed offset rather than a
 * megamorphic lookup.
 */
export class Box {
  kind: BoxKind;
  el: Element | null;
  style: ComputedStyle;
  parent: Box | null = null;
  children: Box[] = [];

  /** Border-box, in document coordinates, after layout. */
  x = 0;
  y = 0;
  width = 0;
  height = 0;

  /** For an inline box broken around a block in it (CSS 2.1 9.2.1.1), the
   *  sides it goes on from, which have no edge: 1 its start, 2 its end. */
  cut = 0;

  /** Resolved edges — border + padding, per side. */
  borderTop = 0;
  borderRight = 0;
  borderBottom = 0;
  borderLeft = 0;
  padTop = 0;
  padRight = 0;
  padBottom = 0;
  padLeft = 0;
  marginTop = 0;
  marginRight = 0;
  marginBottom = 0;
  marginLeft = 0;
  /** The margin that came out through the box's bottom edge from its last
   *  children, collapsed with its own bottom margin, which is their sum:
   *  kept as a strut for the next sibling's to collapse with. Null where
   *  none came out, which is most boxes. Set by the block layout. */
  bottomStrut: MarginStrut | null = null;
  /** An inline box with a background or a border to paint behind its
   *  fragments: the ascent and descent of its own face, the height CSS
   *  paints them over (10.6.1). Set by the inline layout. */
  decoration: InlineDecoration | null = null;
  /** What a percentage `height` resolves against: an absolutely positioned
   *  box's containing block's height, which is known before the box is laid
   *  out (CSS 2.1 10.5). NaN everywhere else, where that height depends on
   *  the content and a percentage is `auto`. */
  percentHeightBase = NaN;
  /** Whether this box last handed its children a percentage base that
   *  was a number: until it does, they hold NaN already, and the next
   *  pass need not visit them to say so again. */
  gavePercentBase = false;
  /** Whether this box's top margin collapsed through its parent's top edge
   *  and was spent placing the parent (CSS 2.1 8.3.1): its own layout puts
   *  it at the parent's content top, and applies no margin again. `2` when
   *  the box is empty and its bottom margin went the same way, so the next
   *  sibling's may have too; `3` for a new formatting context the margin
   *  stopped above, separated from the floats it carries, which sits where
   *  the margins before it end and applies none of its own. Set by the walk
   *  that places the parent, each pass, and read only while every sibling
   *  before it was a `2`. */
  topAbsorbed: 0 | 1 | 2 | 3 = 0;

  /** Text, for a `text` box: already whitespace-processed and transformed. */
  text = '';
  /** This box's slice of the document text index. */
  textStart = 0;
  textEnd = 0;

  /** Lines, for a box that established an inline formatting context. */
  lines: LineBox[] | null = null;
  /** The widest row of floats its lines placed beside none of them, side
   *  by side: what the box is measured with, as a line's floats are
   *  (`LineBox.floats`). */
  floatRow = 0;

  /** A replaced box's intrinsic size and ratio; null on every other box,
   *  which is nearly all of them, so it is one field rather than four. */
  intrinsic: Intrinsic | null = null;
  /**
   * Cached min-/max-content widths, for a table cell and for a box an
   * intrinsic size (`width: fit-content`) sizes. -1 until measured.
   *
   * Intrinsic widths are width-independent by definition, so measuring them
   * per layout pass was this engine breaking its own phase rule — a resize
   * re-probed every cell twice and cost as much as the first layout. The
   * cache lives on the box because the box's lifetime is exactly the
   * invalidation rule: any DOM or style change rebuilds the tree, and a new
   * box starts unmeasured.
   */
  intrinsicMinContent = -1;
  intrinsicMaxContent = -1;
  /** Which layout of the pass this box last had, counted across all boxes:
   *  what tells a layout kept for reuse (`layoutOwn`) from one a probe has
   *  laid over since. */
  layoutSerial = 0;
  /** What a replaced box is: the resource seam and the control host both
   *  key on this rather than re-reading the tag. */
  replaced: ReplacedKind = 'none';

  /** The marker of a `list-item`, if it generated one. The marker is not a
   *  box: it is not in the flow, nothing can select it (CSS spells that
   *  `::marker`, and no author styles it here), and giving it one would put
   *  a bullet in every copied list. */
  marker: Marker | null = null;
  /** Which of an element's pseudo-elements this box is. Its `el` is null —
   *  it is no element — and its text box's is the element it hangs off, so
   *  a click on a link's generated text or first letter is a click on the
   *  link. */
  pseudo: 'before' | 'after' | 'first-letter' | null = null;

  /**
   * The bounds of everything this box and its descendants draw, in document
   * coordinates — **ink** bounds, not the border box, because `overflow:
   * visible` lets a child draw outside its parent and a box-rect test would
   * then cull something still on screen. Filled by `computePaintBounds`
   * after layout; the paint pass culls against it.
   */
  boundsX = 0;
  boundsY = 0;
  boundsWidth = 0;
  boundsHeight = 0;

  /**
   * The viewport query over a wide child list, built by `computePaintBounds`
   * past a size threshold: the paintable in-flow children sorted by ink top,
   * with each entry's document-order position and a running maximum of ink
   * bottoms. What it buys is the promise this component makes about tall
   * documents — the cost of a paint is the viewport's, not the document's —
   * because without it every expose walked all N children of a flat
   * document to reject N−20 of them.
   */
  paintIndex: {
    boxes: Box[];
    order: number[];
    prefixBottom: number[];
  } | null = null;
  /** Out-of-flow children in paint order (z-index, then document order),
   *  precomputed so a paint does not filter and sort per box per frame. */
  positionedPaint: Box[] | null = null;
  /** Whether a positioned box is somewhere under this one: what the pass
   *  that gives each stacking context its positioned boxes walks, so that
   *  a subtree with none is not walked at all (`stackLayers`). */
  holdsLayers = false;
  /** The tallest line box under this box — the slack a binary search over
   *  the y-sorted lines needs, since a line's bottom is not monotone. */
  maxLineHeight = 0;

  /**
   * The document range this box's *subtree* covers, in code units. `[0, 0)`
   * for a subtree with no text. Assigned once per build; the selection
   * walks prune on it, which is what keeps "which pixels does this range
   * cover" from touching the ninety-nine paragraphs a selection is not in.
   */
  subtreeTextStart = 0;
  subtreeTextEnd = 0;

  /** Set on a box whose `position` takes it out of flow, so the block pass
   *  can skip it and the positioned pass can find it. */
  outOfFlow = false;
  /** Set on a float, for the same reason. */
  isFloat = false;
  /** Where an out-of-flow box would have been in the flow it was taken
   *  from — its static position (CSS 2.1 10.3.7, 10.6.4). */
  staticPosition: StaticPosition | null = null;

  /** A table's captions, above and below it: they are in the box's height,
   *  and outside the table's own border and background (CSS 2.1 17.4). */
  captionTop = 0;
  captionBottom = 0;
  /** A table whose borders collapse: the border each segment of its grid
   *  carries, resolved once per build (`collapseTable`). */
  collapsed: CollapsedTable | null = null;
  /** Set on a table whose borders collapse, and on its cells: their border
   *  widths are the halves the collapsing model leaves them, and the table
   *  paints the borders rather than the boxes. */
  bordersCollapsed = false;

  constructor(kind: BoxKind, el: Element | null, style: ComputedStyle) {
    this.kind = kind;
    this.el = el;
    this.style = style;
  }

  append(child: Box): void {
    child.parent = this;
    this.children.push(child);
  }

  /** Content-box left edge, in document coordinates. */
  get contentX(): number {
    return this.x + this.borderLeft + this.padLeft;
  }
  get contentY(): number {
    return this.y + this.borderTop + this.padTop;
  }
  get contentWidth(): number {
    return Math.max(
      0,
      this.width -
        this.borderLeft -
        this.borderRight -
        this.padLeft -
        this.padRight,
    );
  }
  get contentHeight(): number {
    return Math.max(
      0,
      this.height -
        this.borderTop -
        this.borderBottom -
        this.padTop -
        this.padBottom,
    );
  }
  /** Border + padding across, which is what a `border-box` width already
   *  contains and a `content-box` width does not. */
  get horizontalExtra(): number {
    return this.borderLeft + this.borderRight + this.padLeft + this.padRight;
  }
  get verticalExtra(): number {
    return this.borderTop + this.borderBottom + this.padTop + this.padBottom;
  }
}

export type ReplacedKind =
  | 'none'
  | 'image'
  | 'input'
  | 'textarea'
  | 'select'
  | 'button'
  | 'checkbox'
  | 'radio'
  | 'hr'
  /** An `<iframe>`, `<video>`, `<embed>` or `<canvas>`: what it would
   *  show is never loaded or drawn, so it is a box of its size with nothing
   *  in it. */
  | 'frame'
  /** An inline `<svg>`: a drawing, sized by what it says of its size. */
  | 'svg';

/** A replaced box's intrinsic dimensions, in device pixels. */
export interface Intrinsic {
  /** Its size — or, on an axis `missing` names, the default object size of
   *  300 by 150 CSS pixels that CSS falls back to there (CSS 2.1 10.3.2,
   *  10.6.2). */
  width: number;
  height: number;
  /** The dimensions it lacks: 1 its width, 2 its height. Only an SVG can. */
  missing: number;
  /** Its ratio, width over height, or 0 where it has none: an image's, or
   *  an SVG's from its size or its `viewBox`. */
  ratio: number;
}

/** The `::first-line` style of each block container a rule gives one to,
 *  kept beside the boxes: few documents have any (`BoxTree.firstLine`). */
export const FIRST_LINE = new WeakMap<Box, ComputedStyle>();

/**
 * A box's style on the first line of the block it is in, given its
 * parent's style there (CSS Pseudo 4, 2.1.2): an element's own rules over
 * what it inherits on the line, which takes the properties `::first-line`
 * applies to from `parent` and the rest from its parent's own style.
 */
export type FirstLineStyler = (
  box: Box,
  parent: ComputedStyle,
) => ComputedStyle;

/** The url of an image generated content put in a pseudo-element: it has
 *  no element of its own to name it (`imageUrlOf`). */
export const CONTENT_IMAGES = new WeakMap<Box, string>();

/** How far `position: relative` moved an inline box (`offsetInline`), how
 *  far each text on a line moved with the boxes it is in, and the lines
 *  holding one: beside the boxes and the lines, since few documents move an
 *  inline box. A moved text's `drawX` and `drawY` are where it is drawn;
 *  its box's decorations are worked out from where it was, and moved by
 *  their own box's offset. */
export const INLINE_OFFSETS = new WeakMap<Box, { x: number; y: number }>();
export const TEXT_SHIFTS = new WeakMap<LineText, { x: number; y: number }>();
export const SHIFTED_LINES = new WeakSet<LineBox>();

/** Of a block's lines, by the array they are, those `position: relative`
 *  or a translation moved something off — a text in a moved inline box, or
 *  an inline-block or an image on it — which is drawn where it went while
 *  the line stays where it was: what the paint's cull of a block's lines
 *  has to look at past the lines the damage meets (`paintLines`). By the
 *  array, so that a layout that makes new lines leaves none of the old. */
export const MOVED_OFF_LINES = new WeakMap<LineBox[], Set<LineBox>>();

/** How far `vertical-align` raised a text above its line's baseline, and an
 *  inline box's own baseline, where it did: beside the lines and the boxes
 *  for the reason the offsets above are. A line holding a raised text is
 *  among `SHIFTED_LINES` too, as its text is off the line's baseline. */
export const TEXT_RAISES = new WeakMap<LineText, number>();

/** The blocks some of whose text casts a shadow (`text-shadow`), which the
 *  paint pass looks for in them and in no other. */
export const SHADOWED_TEXT = new WeakSet<Box>();
export const BOX_RAISES = new WeakMap<Box, number>();

/** And the raise, on one line, of each inline box a `top` or `bottom` box
 *  holds, the box itself among them: that box's baseline is where the
 *  line's edge puts it, which is a different height on every line, so its
 *  background, drawn from its baseline, is put there by line. */
export const LINE_BOX_RAISES = new WeakMap<LineBox, Map<Box, number>>();

/** The face of an inline box with padding above or below its text and
 *  nothing to paint behind it, which has no `decoration`: its fragments
 *  still reach past its lines by the padding, and count in the scrollable
 *  overflow of the block they are in (`computePaintBounds`). */
export const PADDED_FACES = new WeakMap<Box, InlineDecoration>();

/** The table cells wholly in columns `visibility: collapse` took out of
 *  their table (CSS 2.1 17.5.5), which the paint pass leaves out: a cell is
 *  no descendant of its column and inherits nothing from it, so its own
 *  style still says `visible`. */
export const COLLAPSED_CELLS = new WeakSet<Box>();
/** And the cells spanning into a column or a row taken out: laid out as
 *  they would have been, placed over what is left of their span, and
 *  clipped to it. */
export const CLIPPED_CELLS = new WeakSet<Box>();

/** The boxes after a line-clamp container's clamp point (CSS Overflow 4,
 *  5.3.1): invisible, with all they hold, and no taller than nothing to
 *  the blocks around them. Marked by the layout of the flow they are in,
 *  which leaves them where the last layout put them, and passed over by
 *  paint and the paint bounds. */
export const CLAMPED = new WeakSet<Box>();

/** A grid's tracks as its layout left them, each column's and each row's
 *  start and end from the content box's corner, with the lines of each
 *  axis by number and by name: what an absolutely positioned box's grid
 *  area is found in (CSS Grid 1, 9.1). */
export interface GridTracks {
  cols: [number, number][];
  rows: [number, number][];
  colLines: GridLines;
  rowLines: GridLines;
}
export const GRID_TRACKS = new WeakMap<Box, GridTracks>();

/** A flex box's children in the order it lays them out and paints them,
 *  `order` first and the document's after it (CSS Flexbox 5.4), where
 *  `order` moves any: an absolutely positioned child's is 0. */
export const PAINT_ORDER = new WeakMap<Box, Box[]>();

/** The blocks that broke an inline box in pieces, under its first piece
 *  (`breakAround`): a relative offset of the box moves them too (CSS 2.1
 *  9.2.1.1), though they stand outside it, and its rect takes them in, as
 *  a browser's does (`elementRect`). */
export const CUT_BLOCKS = new WeakMap<Box, Box[]>();

/** The element a pseudo-element's box is generated from, which has no
 *  element of its own (`Box.pseudo`): whose the images its styles name are,
 *  when the host is asked for them. */
export const GENERATED_FROM = new WeakMap<Box, Element>();

/** The blocks that broke an inline box under full opacity in pieces, and
 *  the opacity they take from it — from each such inline box around them,
 *  multiplied. They stand outside it (CSS 2.1 9.2.1.1) and are still its
 *  content, which its opacity fades as a group: a green square in a
 *  `<span style="opacity: .5">` was drawn at full strength. */
export const FADED_BLOCKS = new WeakMap<Box, number>();

/** What the builder produced, plus the document-wide text it indexed. */
export interface BoxTree {
  root: Box;
  /** The document's text as it will be drawn, which is what `textContent()`
   *  answers and what a copy puts on the clipboard. */
  text: string;
  /** Text boxes in document order — the selection binary-searches this. */
  textBoxes: Box[];
  /** The styles text is set in, each once: the faces a host warms before
   *  laying the text out, found here rather than by walking `textBoxes`
   *  again after every build. */
  textStyles: Set<ComputedStyle>;
  /** Each element the build gave a style, with it and whether its parent
   *  was a flex container: what a pointer move restyles an element from
   *  where it did not change the rest (`HtmlViewNode._hoverInPlace`). */
  styles: Map<Element, { style: ComputedStyle; inFlex: boolean }>;
  /** Every replaced box that needs a real widget, in document order. */
  controls: Box[];
  /** Every box carrying an `href`, for click and hover. */
  links: Box[];
  /** Every box with a `background-image`, a border image or a mask image,
   *  an element's or a pseudo-element's, for the host to be asked for: a
   *  document has a handful, and finding them was a walk over every box
   *  after every build. */
  backgrounds: Box[];
  /** Every image generated content names, the element whose
   *  pseudo-element names it, for the host to be asked for, and whether its
   *  size was known when the box was built. */
  contentImages: { url: string; element: Element; sized: boolean }[];
  /** Whether any box is relatively positioned: where none is, layout skips
   *  the walk that moves them. */
  relative: boolean;
  /** Whether any positioned box has a negative `z-index`: where none has,
   *  paint has no layer below the flow to find. */
  negative: boolean;
  /** Whether any block has a `::first-line` style (`FIRST_LINE`): where
   *  none has, layout looks for none. */
  firstLine: boolean;
  /** Each box's style on a first line (`FirstLineStyler`), where any
   *  block has a `::first-line`. */
  firstLineStyler: FirstLineStyler | null;
  /** Whether a float or an out-of-flow box sits in an inline box: where
   *  none does, layout looks for them among a block's own children and
   *  goes through no inline box to find them. */
  nestedOutOfLine: boolean;
  /** Whether `position: relative` moves an inline box or `vertical-align`
   *  raises one: where none does, no text is off its line's baseline, and
   *  the bounds walk looks for none. */
  movedInline: boolean;
  /** Whether any box paints its background through its text
   *  (`background-clip: text`): where none does, no paragraph looks. */
  clipText: boolean;
  /** The style of the `<html>` a document with neither an `<html>` nor a
   *  `<body>` implies around the body the root box stands in for
   *  (`Cascade.rootStyle`), whose background is the canvas's; null where
   *  the document has either. */
  impliedHtml: ComputedStyle | null;
}

export interface BuildOptions {
  cascade: Cascade;
  /** Device pixels per CSS pixel. An image's pixels and a `width="600"`
   *  attribute are CSS pixels; every box is device, so both are multiplied
   *  on the way in. Default 1. */
  scale?: number;
  /** Intrinsic size for an image the host has already loaded, in the
   *  image's own pixels. `null` when it has not: the box takes the attribute
   *  size, or a placeholder. */
  imageSize(el: Element): IntrinsicSize | null;
  /** The same for an image named by url — generated content's. */
  urlSize?(url: string): IntrinsicSize | null;
  /** The size a real widget wants, so the box in the flow is the size the
   *  control will be drawn at. */
  controlSize(
    el: Element,
    kind: ReplacedKind,
    style: ComputedStyle,
  ): {
    width: number;
    height: number;
  };
}

/** Build the box tree for a document. */
export function buildBoxes(
  root: Element | { children: unknown },
  options: BuildOptions,
): BoxTree {
  const builder = new Builder(options);
  return builder.run(root as Element);
}

/**
 * How deep the box tree may go. Everything downstream of the builder — the
 * fix-up pass, layout, paint, the accessor walks — recurses on box depth, so
 * this is the one bound that keeps a degenerately nested document (fuzzer
 * output, a runaway template) from a stack overflow five phases later.
 * Blink's parser flattens at 512 for the same reason; content past the cap
 * is dropped, which beats the alternative of crashing the application.
 * The parser keeps a document to 256 elements (`dom.ts`), so what reaches
 * this now is the anonymous boxes a table builds round each of them.
 */
const MAX_DEPTH = 512;

/** The sharing key the root box's children share under: one root style per
 *  build, and the shared styles last a build (`Cascade.beginSharing`). */
const ROOT_SHARE_KEY = 0;

class Builder {
  private _options: BuildOptions;
  /** The document text, in the pieces it was pushed in — joined once at the
   *  end, so that taking back a line's last space is not a copy of it. */
  private _chunks: string[] = [];
  private _length = 0;
  private _textBoxes: Box[] = [];
  private _textStyles = new Set<ComputedStyle>();
  private _styles = new Map<
    Element,
    { style: ComputedStyle; inFlex: boolean }
  >();
  /** The last text box's style: runs of text share their parent's, so
   *  most text boxes repeat it and add nothing to `_textStyles`. */
  private _lastTextStyle: ComputedStyle | null = null;
  private _controls: Box[] = [];
  private _links: Box[] = [];
  private _backgrounds: Box[] = [];
  private _contentImages: {
    url: string;
    element: Element;
    sized: boolean;
  }[] = [];
  private _relative = false;
  private _negative = false;
  private _firstLine = false;
  private _nestedOutOfLine = false;
  private _movedInline = false;
  private _clipText = false;
  /** The CSS counters in scope, for `counter()` in generated content. */
  private _scopes = new CounterScopes();
  /** How many quotes generated content has opened and not closed. */
  private _quoteDepth = 0;
  /** Where the inline content being built stands, for collapsing white
   *  space across element boundaries. */
  private _ws: Collapse = 'start';
  /** Whether the word the inline content being built is in has had its
   *  first letter, for `text-transform: capitalize`: a word runs on across
   *  element boundaries, as white space collapses across them. */
  private _lettered = false;
  private _depth = 0;
  /** The `::first-letter` whose letter is still to come, for the block
   *  container whose first line has not begun. Null when there is none,
   *  and once anything but a letter begins that line. */
  private _firstLetter: LetterSearch | null = null;

  constructor(options: BuildOptions) {
    this._options = options;
  }

  run(root: Element): BoxTree {
    const cascade = this._options.cascade;
    cascade.beginSharing();
    const { style: rootStyle, html: impliedHtml } = cascade.rootStyle(
      hasBody(root),
      hasHtml(root),
    );
    const rootBox = new Box('block', null, rootStyle);
    // a fragment's root stands in for a `<body>`, counters and all
    this._scopes.open();
    this._counterChanges(rootStyle, {
      node: root,
      style: rootStyle,
      key: ROOT_SHARE_KEY,
      parent: null,
    });
    // The DOM's `<html>`/`<body>` are ordinary elements with ordinary styles;
    // the box above them exists only to be the initial containing block, so
    // it carries no margins of its own and cannot collapse with anything.
    this._children(root, rootBox, rootStyle, false, null, ROOT_SHARE_KEY);
    this._endLine();
    fixUp(rootBox, anonymousStyles(cascade.initial));
    assignSubtreeRanges(rootBox);
    return {
      root: rootBox,
      text: this._chunks.join(''),
      textBoxes: this._textBoxes,
      textStyles: this._textStyles,
      styles: this._styles,
      controls: this._controls,
      links: this._links,
      backgrounds: this._backgrounds,
      contentImages: this._contentImages,
      relative: this._relative || isRelative(rootStyle),
      negative: this._negative,
      firstLine: this._firstLine,
      firstLineStyler: this._firstLine ? this._firstLineStyler() : null,
      nestedOutOfLine: this._nestedOutOfLine,
      movedInline: this._movedInline,
      clipText: this._clipText,
      impliedHtml,
    };
  }

  /** `BoxTree.firstLineStyler`, over this build's cascade. */
  private _firstLineStyler(): FirstLineStyler {
    const cascade = this._options.cascade;
    const styles = this._styles;
    return (box, parent) => {
      const up = box.parent?.style ?? box.style;
      const inherits = firstLineParent(up, parent);
      const el = box.kind === 'text' ? null : box.el;
      const own = el ? styles.get(el) : undefined;
      if (el && own && own.style === box.style) {
        return cascade.styleFor(el, inherits, own.inFlex);
      }
      // text, an anonymous box, a pseudo-element's: no rules of its own to
      // be asked again, so what it took from its parent it takes from the
      // parent's style on the line, and what it set it keeps
      const out = copyStyle(box.style);
      const to = out as unknown as Record<string, unknown>;
      const mine = box.style as unknown as Record<string, unknown>;
      const theirs = up as unknown as Record<string, unknown>;
      const line = inherits as unknown as Record<string, unknown>;
      for (const name of FIRST_LINE_INHERITED) {
        if (mine[name] === theirs[name]) to[name] = line[name];
      }
      return out;
    };
  }

  /** Build boxes for a parent's children into `into`. */
  private _children(
    node: Element | { children: unknown },
    into: Box,
    parentStyle: ComputedStyle,
    inFlex: boolean,
    owner: Element | null,
    parentKey: number,
  ): void {
    // CSS 2.1 17.2.1: a column group holds columns, and anything else in it
    // is not rendered
    const onlyColumns = parentStyle.display === 'table-column-group';
    // A closed `<details>` shows its first `<summary>` and nothing else:
    // HTML renders the rest into a slot that is out of the box tree until
    // the element is `open`.
    const closed =
      owner !== null &&
      tagOf(owner) === 'details' &&
      owner.attribs.open === undefined;
    let summarised = false;
    for (const child of childrenOf(node as Element)) {
      if (closed) {
        if (!isElement(child) || summarised || tagOf(child) !== 'summary') {
          continue;
        }
        summarised = true;
      }
      if (isText(child)) {
        if (!onlyColumns) this._textNode(child.data, into, parentStyle, owner);
        continue;
      }
      if (!isElement(child)) continue;
      this._element(child, into, parentStyle, inFlex, parentKey, onlyColumns);
    }
  }

  private _element(
    el: Element,
    into: Box,
    parentStyle: ComputedStyle,
    inFlex: boolean,
    parentKey: number,
    onlyColumns = false,
  ): void {
    const tag = tagOf(el);
    if (NON_RENDERED.has(tag) || inImpliedHead(el, tag)) return;

    // shared with every element that must compute the same style, which in
    // a long document is most of them (`Cascade.sharedStyleFor`)
    const { style, key } = this._options.cascade.sharedStyleFor(
      el,
      parentStyle,
      parentKey,
      inFlex,
    );
    this._styles.set(el, { style, inFlex });
    if (style.display === 'none') return;
    if (onlyColumns && style.display !== 'table-column') return;
    // what an element counts is in scope for it and what it holds, and for
    // what follows it where its parent has no such counter
    // (`CounterScopes`)
    this._scopes.open();
    // style containment keeps what the element's subtree does to counters
    // and quotes in it (CSS Containment 2, 3.4)
    const contains =
      (style.contain & CONTAIN_STYLE) !== 0 && style.display !== 'contents';
    const quoteDepth = this._quoteDepth;
    if (contains) this._scopes.contain();
    this._elementIn(el, tag, style, key, into, inFlex, {
      node: el,
      style,
      key,
      parent: { style: parentStyle, key: parentKey, inFlex },
    });
    if (contains) this._quoteDepth = quoteDepth;
    this._scopes.close();
  }

  private _elementIn(
    el: Element,
    tag: string,
    style: ComputedStyle,
    key: number,
    into: Box,
    inFlex: boolean,
    place: CounterPlace,
  ): void {
    if (style.display === 'contents') {
      // no box of its own (CSS Display 3, 2.5): its `::before`, its
      // children and its `::after` are its parent's, in its style — the
      // items of a flex row still, through a wrapper Tailwind's `contents`
      // takes out — and a replaced element, which has nothing to hand on,
      // is not rendered
      if (tag === 'br' || replacedKind(el, tag) !== 'none') return;
      this._counterChanges(style, place);
      this._pseudo(el, 'before', style, into);
      this._children(el, into, style, inFlex, el, key);
      this._pseudo(el, 'after', style, into);
      return;
    }
    if (isRelative(style)) {
      this._relative = true;
      if (style.display === 'inline' && isOffset(style)) {
        this._movedInline = true;
      }
    }
    // a translation is moved by the same pass
    if (style.translate || style.transformTranslate) this._relative = true;
    if (style.backgroundClipText) this._clipText = true;
    if (style.verticalAlign !== 'baseline' && style.display === 'inline') {
      this._movedInline = true;
    }
    if (isNegative(style)) this._negative = true;
    // before anything else of the element's, including its `::before`,
    // and for the element whatever box it makes (CSS 2.1 12.4)
    this._counterChanges(style, place);

    // `<br>` is a line break rather than a box, and it is the one element
    // whose *absence* of a box still has to reach the inline layout.
    if (tag === 'br') {
      this._endLine();
      // the first line ends with no letter on it (CSS 2.1 5.12.2)
      this._abandonLetter();
      if (style.clear !== 'none') {
        // a break that clears the floats — `<br clear="all">` after a
        // floated image — puts what follows it below them: an empty block
        // that clears them, which the inline content around it is broken
        // for (`breakInlines`), where a line break went on beside them
        const clearing = copyStyle(style);
        clearing.display = 'block';
        into.append(new Box('block', el, clearing));
        this._ws = 'start';
        return;
      }
      const box = new Box('break', el, style);
      into.append(box);
      this._push('\n', box);
      this._ws = 'start';
      return;
    }

    // an `<object>` is its image once it has one, and its content until;
    // an `<embed>` its image, and a `<video>` its poster, or a frame; an
    // image button its image, and a button saying what it is for until it
    // has one, so it can be pressed either way
    const replaced =
      tag === 'object'
        ? this._options.imageSize(el)
          ? 'image'
          : 'none'
        : (tag === 'embed' || tag === 'video') && this._options.imageSize(el)
          ? 'image'
          : isImageButton(el, tag)
            ? this._options.imageSize(el)
              ? 'image'
              : 'button'
            : replacedKind(el, tag);
    if (replaced !== 'none') {
      this._replaced(el, tag, replaced, style, into);
      return;
    }

    if (this._depth >= MAX_DEPTH) return;
    const kind = boxKindFor(style.display);
    const box = new Box(kind, el, style);
    into.append(box);
    if (
      (kind === 'block' || kind === 'table-cell' || kind === 'table-caption') &&
      this._options.cascade.hasFirstLine
    ) {
      const firstLine = this._options.cascade.firstLineStyle(el, style);
      if (firstLine) {
        FIRST_LINE.set(box, firstLine);
        this._firstLine = true;
      }
    }
    if (namesImages(style)) this._backgrounds.push(box);
    if (style.position === 'absolute' || style.position === 'fixed')
      box.outOfFlow = true;
    else if (style.float !== 'none') box.isFloat = true;
    if (into.kind === 'inline' && (box.outOfFlow || box.isFloat))
      this._nestedOutOfLine = true;

    if (attr(el, 'href') && (tag === 'a' || tag === 'area'))
      this._links.push(box);

    // a column's content is not rendered at all (CSS 2.1 17.2.1)
    if (style.display === 'table-column') return;

    let insideMarker: string | null = null;
    let markerStyle: ComputedStyle | null = null;
    let ownMarker = false;
    let markerImage: { url: string; size: IntrinsicSize } | null = null;
    let insideImage: string | null = null;
    if (style.display === 'list-item' && style.listStyleImage) {
      // asked for as generated content's images are, and the tree built
      // again when it arrives; until it has, and where it never does, the
      // item's marker is its `list-style-type`'s
      const url = style.listStyleImage;
      const size = this._options.urlSize?.(url) ?? null;
      this._contentImages.push({ url, element: el, sized: !!size });
      if (size) markerImage = { url, size };
    }
    if (style.display === 'list-item') {
      // the item's number, the `list-item` counter it has just counted
      const written = markerFor(
        style,
        this._scopes.value('list-item'),
        this._options.cascade.counterStyles,
      );
      let text = written.text;
      let flush = written.flush;
      markerStyle = this._options.cascade.markerStyle(el, style);
      // a `::marker` with a `content` is set as that, as it is written —
      // its strings and its counters, where one of `none` is no marker
      const content = markerStyle?.content;
      if (content === 'none') text = '';
      else if (Array.isArray(content) && markerStyle) {
        text = this._generated(content, markerStyle, el)
          .filter((piece) => typeof piece === 'string')
          .join('');
        ownMarker = true;
        flush = true;
      } else if (style.listStyleType.startsWith('"')) {
        ownMarker = true;
        flush = true;
      }
      if (markerImage && !ownMarker) {
        if (style.listStylePosition === 'inside') insideImage = markerImage.url;
        else {
          const scale = this._options.scale ?? 1;
          box.marker = {
            text: '',
            layout: null,
            x: 0,
            y: 0,
            style: markerStyle,
            image: {
              url: markerImage.url,
              width: (markerImage.size.width ?? 0) * scale,
              height: (markerImage.size.height ?? 0) * scale,
            },
          };
        }
      } else if (text && style.listStylePosition === 'inside') {
        insideMarker = flush ? text : `${text} `;
      } else if (text) {
        box.marker = { text, layout: null, x: 0, y: 0, style: markerStyle };
        if (flush) box.marker.flush = true;
      }
    }
    const childInFlex =
      style.display === 'flex' || style.display === 'inline-flex';
    const flow = flowOf(style, box);
    const around = this._ws;
    const aroundWord = this._lettered;
    if (flow === 'block') this._endLine();
    if (flow !== 'inline') this._ws = 'start';
    // A first letter is looked for in the first line of a block container,
    // down through its inline content and its first blocks. A float, a
    // positioned box and a flex container are no part of that line, and
    // an atomic inline is something other than a letter at its start
    // (CSS 2.1 5.12.2). A block container with rules of its own takes the
    // search over.
    const outerLetter = this._firstLetter;
    const skipped = flow === 'out' || flow === 'atomic' || kind === 'flex';
    if (skipped) this._firstLetter = null;
    // a block starts a line, and punctuation before it was on another
    else if (flow === 'block' && outerLetter) giveBack(outerLetter);
    const ownRules = hasFirstLetter(style.display)
      ? this._options.cascade.firstLetterRules(el)
      : null;
    const ownLetter = ownRules ? { rules: ownRules, punctuation: [] } : null;
    if (ownLetter) this._firstLetter = ownLetter;
    this._depth += 1;
    if (insideImage) {
      // an inline image at the start of the first line, as a generated
      // image is, and the space a marker's text ends in
      this._contentImage(insideImage, box, style, el);
      this._textNode(' ', box, style, el);
    } else if (insideMarker) {
      this._insideMarker(insideMarker, style, markerStyle, box, el);
    }
    this._pseudo(el, 'before', style, box);
    this._children(el, box, style, childInFlex, el, key);
    this._pseudo(el, 'after', style, box);
    this._depth -= 1;
    this._letterAfter(flow, skipped, outerLetter, ownLetter);
    if (flow !== 'inline') this._endLine();
    this._ws = after(flow, this._ws, around);
    this._lettered = letteredAfterFlow(flow, this._lettered, aroundWord);
  }

  private _replaced(
    el: Element,
    tag: string,
    replaced: ReplacedKind,
    style: ComputedStyle,
    into: Box,
  ): void {
    const box = new Box('replaced', el, style);
    box.replaced = replaced;
    into.append(box);
    if (namesImages(style)) this._backgrounds.push(box);
    if (style.position === 'absolute' || style.position === 'fixed')
      box.outOfFlow = true;
    else if (style.float !== 'none') box.isFloat = true;
    if (into.kind === 'inline' && (box.outOfFlow || box.isFloat))
      this._nestedOutOfLine = true;
    const flow = flowOf(style, box);
    if (flow === 'block') this._endLine();
    this._ws = after(flow, this._ws, this._ws);
    this._lettered = letteredAfterFlow(flow, this._lettered, this._lettered);
    if (flow === 'atomic') this._abandonLetter();

    if (replaced === 'image') {
      // Both sources are CSS pixels — an image pixel is one, and so is an
      // attribute — and the box is device.
      const scale = this._options.scale ?? 1;
      const loaded = this._options.imageSize(el);
      if (loaded) {
        setIntrinsics(box, loaded, scale);
      } else {
        // An image that has not arrived still needs a box, or the document
        // reflows under the reader when it does. The attributes are the
        // author telling us the size in advance; without them the box is a
        // small placeholder rather than nothing.
        const width = numberAttr(el, 'width') ?? 0;
        const height = numberAttr(el, 'height') ?? 0;
        box.intrinsic = {
          width: width * scale,
          height: height * scale,
          missing: 0,
          ratio: width > 0 && height > 0 ? width / height : 0,
        };
      }
      // The alt text joins the document text, so a document read with the
      // images blocked still copies as prose.
      const alt = attr(el, 'alt');
      if (alt) this._push(alt, box);
      return;
    }

    if (replaced === 'hr') return;
    if (replaced === 'svg') {
      // its `em` is its own font size, in CSS pixels like the rest of it
      const scale = this._options.scale ?? 1;
      setIntrinsics(box, svgIntrinsics(el, style.fontSize / scale), scale);
      return;
    }
    if (replaced === 'frame') {
      const scale = this._options.scale ?? 1;
      if (tag === 'canvas') {
        // A canvas is the size of its bitmap, which its `width` and
        // `height` attributes give, 300 by 150 where they do not, and
        // keeps its proportions (HTML 4.12.5): no script draws in it, so it
        // is that box with nothing in it. Taken for an element with no box
        // of its own, it took no room, and one set a height kept no width.
        const width = canvasSize(el, 'width', 300);
        const height = canvasSize(el, 'height', 150);
        box.intrinsic = {
          width: width * scale,
          height: height * scale,
          missing: 0,
          ratio: width > 0 && height > 0 ? width / height : 0,
        };
        return;
      }
      // HTML's default object size, in CSS pixels; `width` and `height`
      // attributes reach the style as presentational hints and win
      box.intrinsic = {
        width: 300 * scale,
        height: 150 * scale,
        missing: 0,
        ratio: 0,
      };
      return;
    }

    const size = this._options.controlSize(el, replaced, style);
    box.intrinsic = {
      width: size.width,
      height: size.height,
      missing: 0,
      ratio: 0,
    };
    this._controls.push(box);
    // A control's value is the widget's, not the document's: putting it in
    // the selection index would make Ctrl+A copy the contents of every text
    // field, which no document viewer does.
  }

  /**
   * An element's `::before` or `::after`, when a rule gives it content: a
   * box of its own `display`, holding the text its `content` comes to, which
   * goes through the same white-space processing as the document's text.
   */
  private _pseudo(
    el: Element,
    which: 'before' | 'after',
    elementStyle: ComputedStyle,
    into: Box,
  ): void {
    const style = this._options.cascade.pseudoStyleFor(el, which, elementStyle);
    if (!style || style.display === 'none') return;
    if (isRelative(style)) {
      this._relative = true;
      if (style.display === 'inline' && isOffset(style)) {
        this._movedInline = true;
      }
    }
    // a translation is moved by the same pass
    if (style.translate || style.transformTranslate) this._relative = true;
    if (style.backgroundClipText) this._clipText = true;
    if (style.verticalAlign !== 'baseline' && style.display === 'inline') {
      this._movedInline = true;
    }
    if (isNegative(style)) this._negative = true;
    // a column renders no content, and generated content is all it would
    // hold; in a column group it is not a column either (CSS 2.1 17.2.1)
    if (
      style.display === 'table-column' ||
      style.display === 'table-column-group' ||
      elementStyle.display === 'table-column-group'
    ) {
      return;
    }
    // a scope of its own, which what it counts is in where its element has
    // the counter already (`CounterScopes`)
    this._scopes.open();
    this._counterChanges(style, null);
    const box = new Box(boxKindFor(style.display), null, style);
    box.pseudo = which;
    into.append(box);
    // its images are its element's to ask for: a `::after` with no content
    // but a background, which designs hang a picture on, drew nothing
    GENERATED_FROM.set(box, el);
    if (namesImages(style)) this._backgrounds.push(box);
    // a list item it generates has a marker as an element's has, of the
    // `list-item` counter it has just counted (CSS 2.1 12.5): outside it,
    // or at the start of its content
    const written =
      style.display === 'list-item'
        ? markerFor(
            style,
            this._scopes.value('list-item'),
            this._options.cascade.counterStyles,
          )
        : null;
    let marker = written?.text ?? '';
    if (marker && style.listStylePosition !== 'inside') {
      box.marker = { text: marker, layout: null, x: 0, y: 0, style: null };
      if (written?.flush) box.marker.flush = true;
      marker = '';
    }
    if (style.position === 'absolute' || style.position === 'fixed')
      box.outOfFlow = true;
    else if (style.float !== 'none') box.isFloat = true;
    if (into.kind === 'inline' && (box.outOfFlow || box.isFloat))
      this._nestedOutOfLine = true;
    const pieces = this._generated(style.content as ContentItem[], style, el);
    if (marker) pieces.unshift(written?.flush ? marker : `${marker} `);
    this._scopes.close();
    const flow = flowOf(style, box);
    const around = this._ws;
    const aroundWord = this._lettered;
    if (flow === 'block') this._endLine();
    if (flow !== 'inline') this._ws = 'start';
    // the first letter can be generated, and is looked for here as in an
    // element of the same display
    const outerLetter = this._firstLetter;
    const skipped = flow === 'out' || flow === 'atomic';
    if (skipped) this._firstLetter = null;
    else if (flow === 'block' && outerLetter) giveBack(outerLetter);
    for (const piece of pieces) {
      if (typeof piece === 'string') this._textNode(piece, box, style, el);
      else this._contentImage(piece.url, box, style, el);
    }
    this._letterAfter(flow, skipped, outerLetter, null);
    if (flow !== 'inline') this._endLine();
    this._ws = after(flow, this._ws, around);
    this._lettered = letteredAfterFlow(flow, this._lettered, aroundWord);
  }

  /**
   * An `inside` list marker: an inline box at the start of the item, the
   * marker and a space, which takes its room on the first line as a
   * `::marker` does (CSS Lists 3, 3.1), where a marker set beside the line
   * was drawn over its first letters — every `list-style-position: inside`
   * list, and every `<summary>`. It inherits the item's text style and has
   * none of its box.
   */
  private _insideMarker(
    text: string,
    itemStyle: ComputedStyle,
    markerStyle: ComputedStyle | null,
    into: Box,
    el: Element,
  ): void {
    const style = inherit(
      markerStyle ?? itemStyle,
      this._options.cascade.initial,
    );
    style.display = 'inline';
    // a marker's direction is its own, whatever the text after it, unless
    // its rules say otherwise (the HTML style sheet's `::marker`)
    style.unicodeBidi = markerStyle?.unicodeBidi ?? 'isolate';
    const box = new Box('inline', null, style);
    box.pseudo = 'before';
    into.append(box);
    this._textNode(text, box, style, el);
  }

  /**
   * `counter-reset`, then `counter-increment`, then `counter-set`, as CSS
   * Lists 3 orders them (4.2). A list item counts `list-item` besides,
   * unless its `counter-increment` names it: one up, or one down in a list
   * that counts down. `place` is where an element is, for a reversed
   * counter to be counted from; a pseudo-element has none.
   */
  private _counterChanges(
    style: ComputedStyle,
    place: CounterPlace | null,
  ): void {
    const resets = style.counterReset;
    const increments = style.counterIncrement;
    const sets = style.counterSet;
    const listItem = style.display === 'list-item';
    if (!resets && !increments && !sets && !listItem) return;
    if (resets) {
      for (let i = 0; i < resets.length; i += 1) {
        const change = resets[i];
        // a name reset twice is reset by the last
        if (resets.some((c, j) => j > i && c.name === change.name)) continue;
        const value = change.counted
          ? this._countedStart(change.name, style, place)
          : change.value;
        this._scopes.reset(change.name, value, !!change.reversed);
      }
    }
    let counted = false;
    for (const { name, value } of increments ?? []) {
      this._scopes.increment(name, value);
      if (name === 'list-item') counted = true;
    }
    if (listItem && !counted) {
      this._scopes.increment(
        'list-item',
        this._scopes.reversed('list-item') ? -1 : 1,
      );
    }
    for (const { name, value } of sets ?? []) this._scopes.set(name, value);
  }

  /**
   * Where a reversed counter written with no number starts (CSS Lists 3,
   * 4.4.2): minus what the elements and pseudo-elements in its scope add to
   * it, as far as the first that sets it, and what that sets it to, and as
   * much again as the last of them that counted took away — 1 for a list
   * item. `<ol reversed>`'s items count down to 1, and to an item's
   * `value` before it. The scope is walked ahead of the builder, from the styles it will
   * find shared when it gets there (`Cascade.sharedStyleFor`), and only for
   * such a counter.
   */
  private _countedStart(
    name: string,
    style: ComputedStyle,
    place: CounterPlace | null,
  ): number {
    const cascade = this._options.cascade;
    /** What each element and pseudo-element in the scope does to the
     *  counter, in document order: what it adds, and what it sets it to. */
    const steps: { by: number; set: number | null }[] = [];
    const note = (st: ComputedStyle): void => {
      let by = 0;
      let increments = false;
      for (const change of st.counterIncrement ?? []) {
        if (change.name !== name) continue;
        by += change.value;
        increments = true;
      }
      if (!increments && name === 'list-item' && st.display === 'list-item') {
        by = -1;
        increments = true;
      }
      let set: number | null = null;
      for (const change of st.counterSet ?? []) {
        if (change.name === name) set = change.value;
      }
      if (increments || set !== null) steps.push({ by, set });
    };
    const resets = (st: ComputedStyle): boolean =>
      st.counterReset?.some((change) => change.name === name) ?? false;
    const pseudo = (
      el: Element,
      which: 'before' | 'after',
      st: ComputedStyle,
    ): void => {
      const own = cascade.pseudoStyleFor(el, which, st);
      if (own && own.display !== 'none' && !resets(own)) note(own);
    };
    /** The elements from `from` on of a parent, and what is in them: a
     *  reset of the counter in one is a counter of its own, and a later
     *  sibling's reset at the scope's own level ends it (`stopAtReset`). */
    const walk = (
      children: ReturnType<typeof childrenOf>,
      from: number,
      parentStyle: ComputedStyle,
      parentKey: number,
      inFlex: boolean,
      stopAtReset: boolean,
    ): void => {
      for (let i = from; i < children.length; i += 1) {
        const child = children[i];
        if (!isElement(child)) continue;
        const tag = tagOf(child);
        if (NON_RENDERED.has(tag) || inImpliedHead(child, tag)) continue;
        const shared = cascade.sharedStyleFor(
          child,
          parentStyle,
          parentKey,
          inFlex,
        );
        const st = shared.style;
        if (st.display === 'none') continue;
        if (resets(st)) {
          if (stopAtReset) return;
          continue;
        }
        note(st);
        inside(child, st, shared.key);
      }
    };
    const inside = (el: Element, st: ComputedStyle, key: number): void => {
      pseudo(el, 'before', st);
      walk(
        childrenOf(el),
        0,
        st,
        key,
        st.display === 'flex' || st.display === 'inline-flex',
        false,
      );
      pseudo(el, 'after', st);
    };

    // the element that resets it counts in it too, after the reset
    note(style);
    if (place) {
      const siblings = this._scopes.reachesSiblings(name);
      inside(place.node, place.style, place.key);
      const parent = place.parent;
      const node = place.node as Element & { parent?: Element | null };
      if (siblings && parent && node.parent) {
        const children = childrenOf(node.parent);
        walk(
          children,
          children.indexOf(place.node) + 1,
          parent.style,
          parent.key,
          parent.inFlex,
          true,
        );
      }
    }
    let num = 0;
    let last = 0;
    for (const { by, set } of steps) {
      if (by !== 0) last = -by;
      if (set !== null) {
        num += set;
        break;
      }
      num -= by;
    }
    return num + last;
  }

  /** A counter's value in a style the document can name, as `counter()`
   *  writes it; `none` writes nothing. */
  private _counterText(n: number, name: string, style: ComputedStyle): string {
    if (name === 'none') return '';
    return this._options.cascade.counterStyles.text(
      n,
      name,
      style.direction === 'rtl',
    );
  }

  /** What `content` comes to here, in document order: its text, broken
   *  where it names an image. The quotes it opens and closes count for
   *  everything after it. */
  private _generated(
    items: ContentItem[],
    style: ComputedStyle,
    el: Element,
  ): (string | { url: string })[] {
    const pieces: (string | { url: string })[] = [];
    let text = '';
    for (const item of items) {
      switch (item.kind) {
        case 'string':
          text += item.text;
          break;
        case 'url':
          if (text) pieces.push(text);
          text = '';
          pieces.push({ url: item.url });
          break;
        case 'attr':
          text += attr(el, item.name) ?? '';
          break;
        case 'counter':
          text += this._counterText(
            this._scopes.value(item.name),
            item.style,
            style,
          );
          break;
        case 'counters':
          text += this._scopes
            .values(item.name)
            .map((v) => this._counterText(v, item.style, style))
            .join(item.separator);
          break;
        case 'open-quote':
          text += quoteAt(style.quotes, this._quoteDepth, 0);
          this._quoteDepth += 1;
          break;
        case 'close-quote':
          // a close with nothing open writes nothing and closes nothing
          if (this._quoteDepth > 0) {
            this._quoteDepth -= 1;
            text += quoteAt(style.quotes, this._quoteDepth, 1);
          }
          break;
        case 'no-open-quote':
          this._quoteDepth += 1;
          break;
        case 'no-close-quote':
          if (this._quoteDepth > 0) this._quoteDepth -= 1;
          break;
      }
    }
    if (text) pieces.push(text);
    return pieces;
  }

  /**
   * An image generated content names: an inline replaced box in the
   * pseudo-element, of the style it inherits and no other (CSS 2.1 12.2),
   * the image's size once the host has it and none before. An image that
   * never arrives takes no room, as no image does.
   */
  private _contentImage(
    url: string,
    into: Box,
    style: ComputedStyle,
    owner: Element,
  ): void {
    const box = new Box('replaced', null, {
      ...inherit(style, this._options.cascade.initial),
      display: 'inline',
    });
    box.replaced = 'image';
    into.append(box);
    CONTENT_IMAGES.set(box, url);
    const size = this._options.urlSize?.(url) ?? null;
    this._contentImages.push({ url, element: owner, sized: !!size });
    if (size) setIntrinsics(box, size, this._options.scale ?? 1);
    else box.intrinsic = { width: 0, height: 0, missing: 0, ratio: 0 };
    this._ws = after('atomic', this._ws, this._ws);
    this._lettered = false;
    this._abandonLetter();
  }

  /** A text node, whitespace-processed per the inherited `white-space`. */
  private _textNode(
    data: string,
    into: Box,
    style: ComputedStyle,
    owner: Element | null,
  ): void {
    // text set at no size draws nothing and takes no room, so it needs no
    // box — and it is no part of the white space around it either
    if (!(style.fontSize > 0)) return;
    // a word does not run on over the start of a line
    if (this._ws === 'start') this._lettered = false;
    const ws = style.whiteSpace;
    let text: string;
    if (ws === 'pre' || ws === 'pre-wrap') {
      text = data;
      if (!text) return;
      // preserved spaces do not collapse with the ones after them
      this._ws = text.endsWith('\n') ? 'start' : 'content';
    } else {
      text =
        ws === 'pre-line'
          ? data.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n')
          : COLLAPSIBLE.test(data)
            ? data.replace(/[\t\n\r\f ]+/g, ' ')
            : data;
      // A space at the start of a line goes, and so does one after another
      // space, across element boundaries (CSS 2.1 16.6.1): `<p>\n  Hi` has
      // no space before the H, and `Hi <b> there</b>` has one between.
      if (text.charCodeAt(0) === 32 && this._ws !== 'content') {
        text = text.slice(1);
      }
      if (!text) return;
      const last = text.charCodeAt(text.length - 1);
      this._ws = last === 32 ? 'space' : last === 10 ? 'start' : 'content';
    }
    text = transformText(text, style.textTransform, this._lettered);
    this._lettered = letteredAfter(text, this._lettered);
    const search = this._firstLetter;
    const letter = search ? FIRST_LETTER.exec(text) : null;
    if (!search || !letter) {
      const punctuation = search ? PUNCTUATION_ONLY.exec(text) : null;
      if (!search || !punctuation) {
        this._textBox(text, into, style, owner);
        return;
      }
      // punctuation the letter comes after, in a text of its own —
      // `<q>`'s open quote — takes the letter's style, and gives it back
      // if no letter follows on the line
      const start = punctuation[1].length;
      if (start > 0) this._textBox(text.slice(0, start), into, style, owner);
      search.punctuation.push(
        this._letterBox(search, text.slice(start), into, style, owner),
      );
      return;
    }
    // The first letter, with the punctuation around it, in a box of its
    // own inside the box it was found in, and so inheriting from that
    // (CSS 2.1 5.12.2): `<p><b>T</b>his` has a bold first letter.
    this._firstLetter = null;
    const start = letter[1].length;
    const end = letter[0].length;
    if (start > 0) this._textBox(text.slice(0, start), into, style, owner);
    this._letterBox(search, text.slice(start, end), into, style, owner);
    if (end < text.length) {
      this._textBox(text.slice(end), into, style, owner);
    }
  }

  /** A box of the first letter's style around `text`, in `into`. */
  private _letterBox(
    search: LetterSearch,
    text: string,
    into: Box,
    style: ComputedStyle,
    owner: Element | null,
  ): { box: Box; text: Box; style: ComputedStyle } {
    const cascade = this._options.cascade;
    const letterStyle = cascade.firstLetterStyle(search.rules, style);
    const box = new Box(boxKindFor(letterStyle.display), null, letterStyle);
    box.pseudo = 'first-letter';
    if (owner) {
      GENERATED_FROM.set(box, owner);
      if (namesImages(letterStyle)) this._backgrounds.push(box);
    }
    if (letterStyle.float !== 'none') {
      box.isFloat = true;
      if (into.kind === 'inline') this._nestedOutOfLine = true;
    }
    into.append(box);
    if (letterStyle.textTransform !== style.textTransform) {
      text = transformText(text, letterStyle.textTransform);
    }
    return { box, text: this._textBox(text, box, letterStyle, owner), style };
  }

  /**
   * Where the search for a first letter stands after a box. A box that was
   * no part of the line — a float, a positioned box — leaves it where it
   * was, and one that was something other than a letter on it ends it. A
   * block that looked for a letter of its own and found its first line
   * ended its parent's too, and one that found no line leaves the parent
   * looking. A block ends the line it is on.
   */
  private _letterAfter(
    flow: 'inline' | 'atomic' | 'block' | 'out',
    skipped: boolean,
    outer: LetterSearch | null,
    own: LetterSearch | null,
  ): void {
    const lined = own !== null && this._firstLetter !== own;
    if (own && !lined) this._abandonLetter();
    if (skipped || own) this._firstLetter = skipped || !lined ? outer : null;
    if (lined && !skipped && outer) giveBack(outer);
    if (flow === 'atomic') this._abandonLetter();
    else if (flow === 'block' && this._firstLetter) giveBack(this._firstLetter);
  }

  /** The first line ended, or began with something other than a letter:
   *  there is no first letter, and punctuation that took its style gives
   *  it back. */
  private _abandonLetter(): void {
    const search = this._firstLetter;
    this._firstLetter = null;
    if (search) giveBack(search);
  }

  private _textBox(
    text: string,
    into: Box,
    style: ComputedStyle,
    owner: Element | null,
  ): Box {
    // The owning element rides on the text box, and from there onto the
    // `TextRun`: hit testing inside a paragraph has no rectangle to test —
    // an inline box is the runs on its lines — so the run is what has to
    // know whose text it is.
    const box = new Box('text', owner, style);
    box.text = text;
    into.append(box);
    this._push(text, box);
    return box;
  }

  /**
   * A line ends here — a block's inline content is over, or a `<br>` or a
   * block interrupts it — and a collapsible space it ends on goes (CSS 2.1
   * 16.6.1). Content standing on a space means that space was the last
   * thing pushed, so taking it back is a character off the last chunk; a
   * text box it empties goes with it.
   */
  private _endLine(): void {
    if (this._ws !== 'space') return;
    this._ws = 'start';
    const box = this._textBoxes[this._textBoxes.length - 1];
    if (!box || box.textEnd !== this._length || !box.text.endsWith(' ')) {
      return;
    }
    box.text = box.text.slice(0, -1);
    box.textEnd -= 1;
    this._length -= 1;
    const last = this._chunks.length - 1;
    this._chunks[last] = this._chunks[last].slice(0, -1);
    if (!box.text) {
      this._textBoxes.pop();
      const siblings = box.parent?.children;
      const at = siblings ? siblings.lastIndexOf(box) : -1;
      if (at >= 0) siblings!.splice(at, 1);
    }
  }

  /** Give a box its slice of the document text index. */
  private _push(text: string, box: Box): void {
    box.textStart = this._length;
    this._chunks.push(text);
    this._length += text.length;
    box.textEnd = this._length;
    if (box.kind === 'text') {
      this._textBoxes.push(box);
      if (box.style !== this._lastTextStyle) {
        this._lastTextStyle = box.style;
        this._textStyles.add(box.style);
      }
    }
  }
}

/**
 * The CSS counters in scope as the builder walks the document (CSS Lists 3,
 * 4.5). Every element and pseudo-element opens a level, which closes after
 * what it holds. A `counter-reset` makes an instance that reaches the
 * element's descendants and — where its parent has no counter of the name
 * — its later siblings too, so that instance belongs to the level the
 * element is on, its parent's, and goes when that closes; a later sibling's
 * reset takes its place. Where its parent has one, the new instance nests
 * in it and reaches the element's descendants alone, on the element's own
 * level: a list in a list item, a counter reset in a `::before`. `counter()`
 * reads the innermost instance and `counters()` all of them, outermost
 * first. A counter used where none is in scope is reset to 0 there, as
 * though the element had asked.
 */
class CounterScopes {
  /** Per name, its instances, outermost first: the level each goes with,
   *  whether it is the own one of the element that level is, and whether it
   *  counts down. */
  private _instances = new Map<string, CounterInstance[]>();
  /** The names each open level made an instance of, so closing it drops
   *  exactly those: null for a level that made none, which is nearly every
   *  one, so that opening an element allocates nothing. */
  private _made: (string[] | null)[] = [null];
  /** The levels of the open elements with style containment, innermost
   *  last: below one, a counter made further out is not counted on. */
  private _contained: number[] = [];

  open(): void {
    this._made.push(null);
  }

  close(): void {
    const level = this._made.length - 1;
    const made = this._made.pop();
    if (made) {
      for (const name of made) {
        const stack = this._instances.get(name);
        if (stack && stack[stack.length - 1]?.level === level) stack.pop();
      }
    }
    const contained = this._contained;
    if (contained[contained.length - 1] === level) contained.pop();
  }

  /** The element whose level is open has style containment. */
  contain(): void {
    this._contained.push(this._made.length - 1);
  }

  /** Whether the parent of the element whose level is open has a counter
   *  of this name: its own, or one from further out — not one a sibling
   *  before the element made. */
  private _parentHas(name: string): boolean {
    const stack = this._instances.get(name);
    if (!stack?.length) return false;
    const parent = this._made.length - 2;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const instance = stack[i];
      if (instance.level < parent) return true;
      if (instance.level === parent && instance.own) return true;
    }
    return false;
  }

  /** Whether a reset of `name` here reaches the element's later siblings,
   *  or its descendants alone. */
  reachesSiblings(name: string): boolean {
    return this._made.length < 2 || !this._parentHas(name);
  }

  reset(name: string, value: number, reversed: boolean): void {
    const own = !this.reachesSiblings(name);
    const level = own ? this._made.length - 1 : this._made.length - 2;
    let stack = this._instances.get(name);
    if (!stack) {
      stack = [];
      this._instances.set(name, stack);
    }
    const top = stack[stack.length - 1];
    if (top?.level === level && top.own === own) {
      top.value = value;
      top.reversed = reversed;
      return;
    }
    stack.push({ level, own, value, reversed });
    (this._made[level] ??= []).push(name);
  }

  /** The innermost instance, made here at 0 where there is none. */
  private _innermost(name: string): CounterInstance {
    let stack = this._instances.get(name);
    if (!stack?.length) {
      this.reset(name, 0, false);
      stack = this._instances.get(name)!;
    }
    return stack[stack.length - 1];
  }

  increment(name: string, by: number): void {
    const instance = this._counted(name);
    instance.value = clampCounter(instance.value + by);
  }

  set(name: string, value: number): void {
    this._counted(name).value = value;
  }

  /** The instance an increment or a set counts on: the innermost, unless
   *  it was made outside an element with style containment that this is
   *  inside, where a new one is made instead, as though this reset it for
   *  itself and its later siblings — which one outside the element's parent
   *  then does not see (CSS Containment 2, 3.4). */
  private _counted(name: string): CounterInstance {
    const instance = this._innermost(name);
    const bound = this._contained[this._contained.length - 1];
    const level = this._made.length - 1;
    if (bound === undefined || level <= bound || instance.level >= bound) {
      return instance;
    }
    const parent = level - 1;
    const fresh = { level: parent, own: false, value: 0, reversed: false };
    this._instances.get(name)!.push(fresh);
    (this._made[parent] ??= []).push(name);
    return fresh;
  }

  /** Whether the innermost instance counts down: a list item takes one
   *  from it rather than adding one. */
  reversed(name: string): boolean {
    return this._innermost(name).reversed;
  }

  value(name: string): number {
    return this._innermost(name).value;
  }

  values(name: string): number[] {
    this._innermost(name);
    return this._instances.get(name)!.map((instance) => instance.value);
  }
}

interface CounterInstance {
  level: number;
  own: boolean;
  value: number;
  reversed: boolean;
}

/** A counter is a 32-bit integer in a browser, and saturates there. */
function clampCounter(value: number): number {
  return Math.max(-2147483648, Math.min(2147483647, value));
}

/** Where the element whose counters change is: what the walk that counts
 *  a reversed counter's scope starts from (`BoxBuilder._countedStart`). */
interface CounterPlace {
  node: Element;
  style: ComputedStyle;
  key: number;
  /** The element's parent's style and share key, and whether it is a flex
   *  container: what its later siblings' styles are computed from. Null
   *  for the root. */
  parent: { style: ComputedStyle; key: number; inFlex: boolean } | null;
}

/** Whether the parsed document has a `<body>`. htmlparser2 does not
 *  synthesise one — it parses what it was given — so a fragment has none,
 *  and the root box stands in for it. */
function hasHtml(root: Element | { children: unknown }): boolean {
  for (const child of childrenOf(root as Element)) {
    if (isElement(child) && tagOf(child) === 'html') return true;
  }
  return false;
}

function hasBody(root: Element | { children: unknown }): boolean {
  for (const child of childrenOf(root as Element)) {
    if (!isElement(child)) continue;
    const tag = tagOf(child);
    if (tag === 'body') return true;
    if (tag === 'html' && hasBody(child)) return true;
  }
  return false;
}

/** A canvas's bitmap dimension: a non-negative integer, as HTML parses
 *  one, or its default where the attribute is missing or no number. */
function canvasSize(el: Element, name: string, fallback: number): number {
  const raw = attr(el, name);
  const n = raw == null ? NaN : parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function numberAttr(el: Element, name: string): number | null {
  const raw = attr(el, name);
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function transformText(
  text: string,
  transform: ComputedStyle['textTransform'],
  lettered = false,
): string {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return capitalize(text, lettered);
    default:
      return text;
  }
}

/**
 * `text` transformed as `transform` says, where it stands for text laid out
 * already — a first line's, whose `::first-line` transforms it (CSS 2.1
 * 5.12.1): a character at a time where the transform would change its
 * length, which moves every offset after it — `ß` is `SS` in capitals —
 * and that character kept as it is.
 */
export function transformInPlace(
  text: string,
  transform: ComputedStyle['textTransform'],
  lettered = false,
): string {
  const whole = transformText(text, transform, lettered);
  if (whole.length === text.length) return whole;
  let out = '';
  let state = lettered;
  for (const ch of text) {
    const one = transformText(ch, transform, state);
    out += one.length === ch.length ? one : ch;
    state = letteredAfter(ch, state);
  }
  return out;
}

/** A letter or a number: what a word's first typographic letter unit is
 *  (CSS Text 3, 2.1). */
const LETTER_UNIT = /[\p{L}\p{N}]/u;

/**
 * What does not end a word (UAX #29): a combining mark, and the
 * punctuation that joins letters into one — `x.y`, `don't`, `a:b`. Any
 * other character that is not a letter or a number is between words: a
 * space, a no-break space, a hyphen, a bracket.
 */
const IN_WORD =
  /[\p{M}'.:\u00b7\u0387\u05f4\u2018\u2019\u2024\u2027\ufe13\ufe52\ufe55\uff07\uff0e\uff1a]/u;

/**
 * `text-transform: capitalize` (CSS Text 3, 2.1): the first letter or
 * number of each word in upper case, and nothing else. Punctuation a word
 * starts with is not its first letter — `(p.p.)` is `(P.p.)` — and a word
 * the text continues, `lettered`, has had its own: `<b>fo</b>o` is `Foo`.
 */
function capitalize(text: string, lettered: boolean): string {
  let out = '';
  let from = 0;
  let at = 0;
  for (const ch of text) {
    if (LETTER_UNIT.test(ch)) {
      if (!lettered) {
        const title = titleCase(ch);
        if (title !== ch) {
          out += text.slice(from, at) + title;
          from = at + ch.length;
        }
        lettered = true;
      }
    } else if (!IN_WORD.test(ch)) {
      lettered = false;
    }
    at += ch.length;
  }
  return from ? out + text.slice(from) : text;
}

/**
 * A letter in title case (Unicode's SpecialCasing), which is its upper case
 * but for a letter that is two: a digraph is capitalized as its first
 * letter alone — `ǆ` as `ǅ`, where upper case is `Ǆ` — and a Greek vowel
 * with a subscript iota keeps the iota subscript, where upper case writes
 * it out. A letter whose upper case is two letters, as `ß` is `SS`, is the
 * first of them: `Ss`.
 */
function titleCase(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x1c4 && cp <= 0x1cc) {
    return String.fromCharCode(0x1c5 + 3 * Math.floor((cp - 0x1c4) / 3));
  }
  if (cp >= 0x1f1 && cp <= 0x1f3) return '\u01f2';
  if (cp >= 0x1f80 && cp <= 0x1faf) return String.fromCharCode(cp | 0x08);
  if (cp === 0x1fb3 || cp === 0x1fc3 || cp === 0x1ff3) {
    return String.fromCharCode(cp + 9);
  }
  if (cp === 0x1fbc || cp === 0x1fcc || cp === 0x1ffc) return ch;
  const upper = ch.toUpperCase();
  if (upper.length <= ch.length) return upper;
  const first = String.fromCodePoint(upper.codePointAt(0)!);
  return first + upper.slice(first.length).toLowerCase();
}

/**
 * Whether a word is under way after `text`, as `capitalize` reads words: its
 * last letter, number or character between words decides, and a text of
 * nothing but joining punctuation leaves it as it was. Asked of every text,
 * from the end, where it is almost always decided by the last character.
 */
export function letteredAfter(text: string, lettered: boolean): boolean {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      if (
        (c >= 0x61 && c <= 0x7a) ||
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x30 && c <= 0x39)
      ) {
        return true;
      }
      if (c === 0x27 || c === 0x2e || c === 0x3a) continue;
      return false;
    }
    // a low surrogate is read with the high one before it
    const start =
      c >= 0xdc00 && c <= 0xdfff && i > 0 && isHighSurrogate(text, i - 1)
        ? i - 1
        : i;
    const ch = text.slice(start, i + 1);
    if (LETTER_UNIT.test(ch)) return true;
    if (!IN_WORD.test(ch)) return false;
    i = start;
  }
  return lettered;
}

function isHighSurrogate(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff;
}

/** Whether a word is under way after a box, as `after` says where white
 *  space stands: an inline box leaves it as its content did, an atomic
 *  inline and a block end it, and a float or a positioned box leaves the
 *  word around it as it was. */
function letteredAfterFlow(
  flow: 'inline' | 'atomic' | 'block' | 'out',
  inside: boolean,
  before: boolean,
): boolean {
  if (flow === 'inline') return inside;
  if (flow === 'out') return before;
  return false;
}

/** Where the inline content being built stands, for white space: at the
 *  start of a line, just after a space that may collapse, or after anything
 *  else. */
type Collapse = 'start' | 'space' | 'content';

/**
 * A text's first letter, with the punctuation before and after it that CSS
 * 2.1 5.12.2 counts in — the Ps, Pe, Pi, Pf and Po classes — and the white
 * space before it in the first group. No match when the text ends, or
 * reaches a space, before any letter: its first letter is in a later text,
 * as browsers read it.
 */
const FIRST_LETTER =
  /^([ \t\n\r\f\u00a0]*)(?:[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Po}]\p{M}*)*[^ \t\n\r\f\u00a0\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Po}]\p{M}*(?:[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Po}]\p{M}*)*/u;

/** A text that is punctuation and nothing else, but for the white space
 *  before it in the first group. */
const PUNCTUATION_ONLY =
  /^([ \t\n\r\f\u00a0]*)(?:[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Po}]\p{M}*)+$/u;

/** A `::first-letter` looking for its letter. */
interface LetterSearch {
  rules: FirstLetterRules;
  /** Punctuation already in the letter's style, from texts that ended
   *  before the letter came. */
  punctuation: { box: Box; text: Box; style: ComputedStyle }[];
}

/** Put punctuation a search styled back in its own box and style: the
 *  letter it was waiting for is not on its line. */
function giveBack(search: LetterSearch): void {
  for (const { box, text, style } of search.punctuation) {
    const parent = box.parent;
    if (!parent) continue;
    const at = parent.children.indexOf(box);
    if (at < 0) continue;
    parent.children[at] = text;
    text.parent = parent;
    text.style = style;
  }
  search.punctuation.length = 0;
}

/** Whether a box of this display is a block container, which is what can
 *  have a first letter. */
function hasFirstLetter(display: ComputedStyle['display']): boolean {
  switch (display) {
    case 'block':
    case 'inline-block':
    case 'list-item':
    case 'table-cell':
    case 'table-caption':
      return true;
    default:
      return false;
  }
}

/**
 * How a box sits in its parent's inline content, for white space. An inline
 * box's content is its parent's own; an atomic inline — an inline-block, an
 * image — is one piece of it; a block ends the line it interrupts and starts
 * another; a float or a positioned box is no part of it at all.
 */
function flowOf(
  style: ComputedStyle,
  box: Box,
): 'inline' | 'atomic' | 'block' | 'out' {
  if (box.outOfFlow || box.isFloat) return 'out';
  // an image told to be a table's part is an inline one (`isBlockLevel`)
  if (box.kind === 'replaced' && style.display.startsWith('table-')) {
    return 'atomic';
  }
  switch (style.display) {
    case 'inline':
      return box.kind === 'replaced' ? 'atomic' : 'inline';
    case 'inline-block':
    case 'inline-table':
    case 'inline-flex':
      return 'atomic';
    case 'table-row-group':
    case 'table-header-group':
    case 'table-footer-group':
    case 'table-row':
    case 'table-cell':
    case 'table-caption':
    case 'table-column':
    case 'table-column-group':
      // table parts in an inline box are given an inline table around them
      // (CSS 2.1 17.2.1), which sits in the line as an inline-block does:
      // the white space either side of it is the line's
      return box.parent?.kind === 'inline' ? 'atomic' : 'block';
    default:
      return 'block';
  }
}

/** Where the inline content stands after a box, from where it stood inside
 *  the box and before it. */
function after(
  flow: 'inline' | 'atomic' | 'block' | 'out',
  inside: Collapse,
  before: Collapse,
): Collapse {
  switch (flow) {
    case 'inline':
      return inside;
    case 'atomic':
      return 'content';
    case 'out':
      return before;
    default:
      return 'start';
  }
}

function boxKindFor(display: ComputedStyle['display']): BoxKind {
  switch (display) {
    case 'inline':
      return 'inline';
    case 'flex':
    case 'inline-flex':
      return 'flex';
    case 'table':
    case 'inline-table':
      return 'table';
    case 'table-row-group':
    case 'table-header-group':
    case 'table-footer-group':
      return 'table-row-group';
    case 'table-row':
      return 'table-row';
    case 'table-cell':
      return 'table-cell';
    case 'table-caption':
      return 'table-caption';
    case 'table-column':
    case 'table-column-group':
      // A column box paints nothing and lays out nothing; the table reads
      // its style for the column width and skips the box.
      return 'block';
    default:
      // `inline-block` and `list-item` are block *containers* that happen to
      // be inline-level or to carry a marker; both lay out inside like a
      // block, and the difference is what the parent does with them.
      return 'block';
  }
}

/** A replaced box's intrinsic size from what its content says, in CSS
 *  pixels: an axis it does not give takes the default object size. */
function setIntrinsics(box: Box, size: IntrinsicSize, scale: number): void {
  box.intrinsic = {
    width: (size.width ?? 300) * scale,
    height: (size.height ?? 150) * scale,
    missing: (size.width === null ? 1 : 0) | (size.height === null ? 2 : 0),
    ratio: size.ratio,
  };
}

/** An `<input type=image>`: a picture that submits its form. */
function isImageButton(el: Element, tag: string): boolean {
  return (
    tag === 'input' && (attr(el, 'type') ?? '').trim().toLowerCase() === 'image'
  );
}

function replacedKind(el: Element, tag: string): ReplacedKind {
  switch (tag) {
    case 'img':
      return 'image';
    case 'svg':
      // XHTML's `<svg:svg>` too, which `tagOf` names `svg`
      return 'svg';
    case 'hr':
      return 'hr';
    case 'iframe':
    case 'video':
    case 'embed':
    case 'canvas':
      return 'frame';
    case 'textarea':
      return 'textarea';
    case 'select':
      return 'select';
    // A `<button>` is not one: its content is the document's, laid out and
    // drawn like any box's (the UA sheet's `button` rule), where an
    // `<input type=submit>` has only a value to show and is a widget.
    case 'input': {
      const type = (attr(el, 'type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset')
        return 'button';
      if (type === 'hidden') return 'none';
      return 'input';
    }
    default:
      return 'none';
  }
}

/**
 * The marker a `list-item` draws: its `list-item` counter written in its
 * `list-style-type`, between the style's prefix and suffix, or the string
 * the type is. The counter is the builder's (`CounterScopes`), which is
 * what lets `value` on an `<li>`, `start` and `reversed` on an `<ol>`, a
 * list in a list and an author's own `counter-reset` and `counter-set` all
 * count as a browser counts them. A suffix that ends in a space — `. `, a
 * bullet's — is written without it, and the layout sets the marker off by
 * its own gap; one that does not, `、`, sets the marker against the text.
 */
function markerFor(
  style: ComputedStyle,
  n: number,
  styles: CounterStyles,
): { text: string; flush: boolean } {
  const type = style.listStyleType;
  if (type === 'none') return { text: '', flush: false };
  if (type.startsWith('"')) return { text: type.slice(1), flush: true };
  const { prefix, text, suffix } = styles.marker(
    n,
    type,
    style.direction === 'rtl',
  );
  const spaced = /\s$/.test(suffix);
  return {
    text: prefix + text + (spaced ? suffix.trimEnd() : suffix),
    flush: !spaced,
  };
}

/**
 * Give every box the document range its subtree covers. Runs after `fixUp`,
 * because fix-up reparents children into anonymous boxes and the ranges have
 * to describe the tree the walks will actually traverse. Document order
 * makes each subtree's range contiguous, so min/max over the children is
 * exact rather than an approximation.
 */
function assignSubtreeRanges(box: Box): { start: number; end: number } {
  let start = box.textEnd > box.textStart ? box.textStart : Infinity;
  let end = box.textEnd > box.textStart ? box.textEnd : -Infinity;
  for (const child of box.children) {
    const range = assignSubtreeRanges(child);
    if (range.end > range.start) {
      start = Math.min(start, range.start);
      end = Math.max(end, range.end);
    }
  }
  if (end <= start) {
    box.subtreeTextStart = 0;
    box.subtreeTextEnd = 0;
    return { start: 0, end: 0 };
  }
  box.subtreeTextStart = start;
  box.subtreeTextEnd = end;
  return { start, end };
}

// --- anonymous boxes --------------------------------------------------------

/**
 * The fix-up pass: CSS's anonymous box rules, applied bottom-up.
 *
 * Two of them, and both are the difference between a document that lays out
 * and one that silently drops content:
 *
 *  - **A block container with a mix of block-level and inline-level children
 *    wraps each run of inline children in an anonymous block.** Without it
 *    `<div>text<p>para</p></div>` has to decide whether the div is a block
 *    context or an inline one, and either answer loses something.
 *  - **A table's structure is completed.** Real documents write `<table>`
 *    straight to `<tr>`, and CSS says the missing row group is generated
 *    rather than the rows being dropped.
 */
function fixUp(box: Box, anonymous: AnonymousStyle): void {
  for (const child of box.children) fixUp(child, anonymous);
  fixUpOwn(box, anonymous);
}

/** `fixUp` of a box whose children have had theirs. */
function fixUpOwn(box: Box, anonymous: AnonymousStyle): void {
  if (box.kind === 'table') {
    fixUpTable(box, anonymous);
    return;
  }
  if (box.kind === 'table-row-group') {
    wrapOrphans(box, 'table-row', (k) => k === 'table-row', anonymous);
    return;
  }
  if (box.kind === 'table-row') {
    wrapOrphans(box, 'table-cell', (k) => k === 'table-cell', anonymous);
    return;
  }
  // a column group holds its columns, which are where they belong, and the
  // builder kept nothing else in it
  if (box.style.display === 'table-column-group') return;

  if (!box.children.length) return;
  wrapTableParts(box, anonymous);
  // An inline box holds no block: a block in one is its block container's,
  // which breaks the inline box around it
  if (box.kind === 'inline') return;
  if (box.kind !== 'flex') breakInlines(box);
  let hasBlockLevel = false;
  let hasInlineLevel = false;
  for (const child of box.children) {
    if (child.outOfFlow) continue;
    if (isBlockLevel(child)) hasBlockLevel = true;
    else hasInlineLevel = true;
  }
  // A flex container has no inline formatting context at all: every run of
  // inline-level content becomes an anonymous flex *item*, whether or not a
  // block-level sibling forced the question. `<div style="display:flex">some
  // text</div>` is the case the mixed-content rule alone drops on the floor —
  // all-inline children, so no wrapping, so the flex pass finds bare text
  // boxes it cannot lay out and renders nothing.
  const wrapAllInline = box.kind === 'flex';
  if (!wrapAllInline && (!hasBlockLevel || !hasInlineLevel)) return;
  if (wrapAllInline && !hasInlineLevel) return;

  const next: Box[] = [];
  let run: Box[] | null = null;
  for (const child of box.children) {
    // A float or an absolutely positioned box sits in whichever context it
    // finds itself; it does not force an anonymous block on its own.
    if (isBlockLevel(child) && !child.outOfFlow && !child.isFloat) {
      if (run) {
        next.push(anonymousOf(box, 'block', run, anonymous));
        run = null;
      }
      next.push(child);
      continue;
    }
    // Whitespace between two blocks is not content and must not generate a
    // line box — `<div><p>a</p> <p>b</p></div>` has no blank line in it.
    if (!run && child.kind === 'text' && isBlank(child.text)) continue;
    (run ??= []).push(child);
  }
  if (run) {
    if (run.every((c) => c.kind === 'text' && isBlank(c.text))) {
      // trailing whitespace after the last block: same rule
    } else {
      next.push(anonymousOf(box, 'block', run, anonymous));
    }
  }
  box.children = next;
}

/**
 * Break a block container's inline children around the blocks in them
 * (CSS 2.1 9.2.1.1): an inline box with an in-flow block in it — at any
 * depth of inline box — becomes the pieces of it before, between and after
 * its blocks, and the blocks stand beside them as the container's own, for
 * the mixed-content rule to wrap the pieces in anonymous blocks.
 * `<font><p>One</p><p>Two</p></font>` laid its paragraphs side by side as
 * inline-blocks, and a link around a card's blocks set them in a line.
 */
function breakInlines(box: Box): void {
  let next: Box[] | null = null;
  for (let i = 0; i < box.children.length; i += 1) {
    const child = box.children[i];
    const pieces =
      child.kind === 'inline' && holdsBlock(child) ? breakAround(child) : null;
    if (!pieces) {
      next?.push(child);
      continue;
    }
    next ??= box.children.slice(0, i);
    for (const piece of pieces) {
      piece.parent = box;
      next.push(piece);
    }
  }
  if (next) box.children = next;
}

/** Whether an inline box has an in-flow block in it, at any depth of
 *  inline box: asked first, and without making anything, since nearly
 *  every inline box has none. */
function holdsBlock(inline: Box): boolean {
  for (const child of inline.children) {
    if (child.kind === 'inline') {
      if (holdsBlock(child)) return true;
    } else if (isBlockLevel(child) && !child.outOfFlow && !child.isFloat) {
      return true;
    }
  }
  return false;
}

/**
 * An inline box broken around the in-flow blocks in it: its pieces, each a
 * box of its element and style holding the content between two blocks,
 * with the blocks between them; null where it has none, which is nearly
 * every inline box. A piece has no edge on a side a block cut: the start of
 * the first and the end of the last are the box's own.
 */
function breakAround(inline: Box): Box[] | null {
  let out: Box[] | null = null;
  const pieces: Box[] = [];
  let run: Box[] = [];
  const close = (): void => {
    const piece = new Box('inline', inline.el, inline.style);
    piece.pseudo = inline.pseudo;
    for (const child of run) piece.append(child);
    pieces.push(piece);
    (out ??= []).push(piece);
    run = [];
  };
  const blocks: Box[] = [];
  for (const child of inline.children) {
    if (isBlockLevel(child) && !child.outOfFlow && !child.isFloat) {
      close();
      out!.push(child);
      blocks.push(child);
      continue;
    }
    const inner =
      child.kind === 'inline' && holdsBlock(child) ? breakAround(child) : null;
    if (!inner) {
      run.push(child);
      continue;
    }
    for (const piece of inner) {
      if (piece.kind === 'inline') {
        run.push(piece);
      } else {
        close();
        out!.push(piece);
        blocks.push(piece);
      }
    }
  }
  if (!out) return null;
  close();
  for (let i = 0; i < pieces.length; i += 1) {
    pieces[i].cut = (i > 0 ? 1 : 0) | (i < pieces.length - 1 ? 2 : 0);
  }
  CUT_BLOCKS.set(pieces[0], blocks);
  const fade = inline.style.opacity;
  if (fade < 1) {
    for (const block of blocks) {
      FADED_BLOCKS.set(block, (FADED_BLOCKS.get(block) ?? 1) * fade);
    }
  }
  return out;
}

/** Whether a style names an image for its box to be drawn with: a
 *  background's, a border's, or a mask's. */
function namesImages(style: ComputedStyle): boolean {
  return (
    !!style.backgroundImage ||
    !!style.backgroundImages ||
    typeof style.borderImage.source === 'string' ||
    style.mask !== NO_MASK
  );
}

/**
 * The style of an anonymous box inside a parent: what the parent passes on
 * by inheritance, and every other property at its initial value, as CSS 2.1
 * gives anonymous boxes theirs (9.2.1.1, 17.2.1). An anonymous box that took
 * the parent's style itself took its height, its padding and borders, its
 * background, its relative offset and its opacity a second time — the text
 * in `<div style="padding: 20px">text<p>…</p></div>` sat 40px in, and the
 * paragraph after it the height of the div further down. One per parent
 * style, which the cascade already shares between elements.
 */
type AnonymousStyle = (
  parent: Box,
  display: ComputedStyle['display'],
) => ComputedStyle;

function anonymousStyles(initial: ComputedStyle): AnonymousStyle {
  const made = new WeakMap<ComputedStyle, Map<string, ComputedStyle>>();
  return (parent, display) => {
    let byDisplay = made.get(parent.style);
    if (!byDisplay) {
      byDisplay = new Map();
      made.set(parent.style, byDisplay);
    }
    let style = byDisplay.get(display);
    if (!style) {
      // `display` is the one property it does not start from: it is the
      // box the fix-up made, and layout asks the style what a box is
      style = inherit(parent.style, initial);
      style.display = display;
      byDisplay.set(display, style);
    }
    return style;
  };
}

function isBlockLevel(box: Box): boolean {
  switch (box.kind) {
    case 'block':
    case 'flex':
    case 'table':
    case 'table-row':
    case 'table-row-group':
    case 'table-cell':
    case 'table-caption':
      // An `inline-block` or `inline-flex` is a block *container* with an
      // inline-level outer role, so it belongs to the inline run around it.
      return !isInlineLevelDisplay(box.style.display);
    case 'replaced':
      // an image is inline unless it is told otherwise, and then it is a
      // block: `img { display: block }`, which mail writes to lose the gap
      // under its images, stacks them. A table's part is no display it
      // can take, and one told to be a cell is inline (CSS Display 3,
      // 2.4), which is what a table wraps a cell around.
      return (
        box.style.display !== 'inline' &&
        !isInlineLevelDisplay(box.style.display) &&
        !box.style.display.startsWith('table-')
      );
    default:
      return false;
  }
}

function isInlineLevelDisplay(display: ComputedStyle['display']): boolean {
  return (
    display === 'inline-block' ||
    display === 'inline-flex' ||
    display === 'inline-table'
  );
}

/** Wrap children that are not of `expect` in an anonymous box that is. */
function wrapOrphans(
  box: Box,
  kind: BoxKind,
  accept: (k: BoxKind) => boolean,
  anonymous: AnonymousStyle,
): void {
  let needed = false;
  for (const child of box.children) {
    if (!accept(child.kind) && !isDroppableWhitespace(child)) {
      needed = true;
      break;
    }
  }
  if (!needed) return;
  // White space goes only between two of the parts, or beside one at an
  // end (CSS 2.1 17.2.1, rule 1): beside a child the fix-up wraps, it is
  // that child's run's, so `<span>a</span> <span>b</span>` in a row is one
  // anonymous cell of `a b`, where it was `ab`
  const next: Box[] = [];
  let run: Box[] | null = null;
  let space: Box[] = [];
  for (const child of box.children) {
    if (accept(child.kind)) {
      if (run) {
        run.push(...space);
        next.push(anonymousOf(box, kind, run, anonymous));
        run = null;
      }
      space = [];
      next.push(child);
      continue;
    }
    if (isDroppableWhitespace(child)) {
      space.push(child);
      continue;
    }
    (run ??= []).push(...space, child);
    space = [];
  }
  if (run) {
    run.push(...space);
    next.push(anonymousOf(box, kind, run, anonymous));
  }
  box.children = next;
  // A cell made here is a block container the fix-up has not been to: its
  // children had theirs, as the table's, before it held them. Text beside a
  // block in it goes in an anonymous block as in any other (CSS 2.1
  // 9.2.1.1) — `<span style="display: inline-table">bcd<div>x</div>` laid
  // `bcd` out as nothing, and drew the table as wide as the `x`.
  if (kind === 'table-cell') {
    for (const child of next) {
      if (child.kind === 'table-cell' && !child.el) fixUpOwn(child, anonymous);
    }
  }
}

function anonymousOf(
  parent: Box,
  kind: BoxKind,
  run: Box[],
  anonymous: AnonymousStyle,
  display: ComputedStyle['display'] = kind as ComputedStyle['display'],
): Box {
  const box = new Box(kind, null, anonymous(parent, display));
  box.parent = parent;
  for (const child of run) {
    child.parent = box;
    box.children.push(child);
  }
  return box;
}

/** White space alone, which the table fix-up drops between the parts of a
 *  table whether it is kept or not (CSS 2.1 17.2.1, rule 1). Kept, under
 *  `white-space: pre`, it made a cell of the line break before every row. */
function isDroppableWhitespace(box: Box): boolean {
  return box.kind === 'text' && isBlank(box.text);
}

/**
 * Whether a text is white space alone: CSS's white space, which is the
 * space, the tab and the three line breaks and nothing else (CSS Text 3,
 * 4.1). JavaScript's `\s` and `trim` take in the no-break space and the
 * other Unicode spaces too, so a `<p>&nbsp;</p>` spacer or a
 * `<td>&nbsp;</td>` beside a block was dropped as if it held nothing. Tested
 * rather than trimmed, which copies a paragraph's text to find out.
 */
export function isBlank(text: string): boolean {
  return BLANK.test(text);
}

const BLANK = /^[ \t\n\r\f]*$/;

/** White space that collapsing would change: anything but a lone space.
 *  Most of a document's text has none, and is its own collapsed form. */
const COLLAPSIBLE = /[\t\n\r\f]| {2}/;

function isRelative(style: ComputedStyle): boolean {
  return style.position === 'relative' || style.position === 'sticky';
}

/** Whether `position: relative` moves a box: an inset is set. An inline box
 *  that is moved has its text laid out apart (`collect`), so one whose
 *  insets resolve to nothing still costs its paragraph the layout of a line
 *  at a time, which a box with every inset `auto` does not. */
export function isOffset(style: ComputedStyle): boolean {
  if (!isRelative(style)) return false;
  return (
    style.top !== AUTO ||
    style.right !== AUTO ||
    style.bottom !== AUTO ||
    style.left !== AUTO
  );
}

/** Whether a style may put its box under its stacking context's flow: a
 *  negative `z-index` on a positioned box, or on a flex item, which that
 *  makes a stacking context as it is (`stacksLayers`). */
function isNegative(style: ComputedStyle): boolean {
  return typeof style.zIndex === 'number' && style.zIndex < 0;
}

/** A box that belongs inside a table: a row group, a row, a cell, a
 *  caption or a column. Asked of every child of every box in a build, so
 *  a text or an inline box is answered from its kind, without its style. */
function isTablePart(box: Box): boolean {
  switch (box.kind) {
    case 'table-row-group':
    case 'table-row':
    case 'table-cell':
    case 'table-caption':
      return !box.outOfFlow && !box.isFloat;
    case 'block': {
      if (box.outOfFlow || box.isFloat) return false;
      const display = box.style.display;
      return display === 'table-column' || display === 'table-column-group';
    }
    default:
      return false;
  }
}

/**
 * Table parts outside a table get one around them (CSS 2.1 17.2.1, rule 3):
 * each run of them — the white space between them no part of it — is
 * wrapped in an anonymous table, an inline one where the parent is inline,
 * and the table is then completed as any other. Laid out on their own, two
 * cells side by side in a line were two inline-blocks with a space between
 * them, and in a block two blocks, one above the other.
 */
function wrapTableParts(box: Box, anonymous: AnonymousStyle): void {
  if (!box.children.some(isTablePart)) return;
  const display = box.kind === 'inline' ? 'inline-table' : 'table';
  const next: Box[] = [];
  let run: Box[] | null = null;
  let space: Box[] = [];
  const flush = (): void => {
    if (!run) return;
    const table = anonymousOf(box, 'table', run, anonymous, display);
    fixUpTable(table, anonymous);
    next.push(table);
    run = null;
  };
  for (const child of box.children) {
    if (isTablePart(child)) {
      run ??= [];
      run.push(child);
      space = [];
      continue;
    }
    if (run && isDroppableWhitespace(child)) {
      // held back: between two parts it goes, after the last it stays
      space.push(child);
      continue;
    }
    flush();
    next.push(...space, child);
    space = [];
  }
  flush();
  next.push(...space);
  box.children = next;
  for (const child of next) child.parent = box;
}

function fixUpTable(table: Box, anonymous: AnonymousStyle): void {
  const groups: Box[] = [];
  const captions: Box[] = [];
  const columns: Box[] = [];
  let looseRows: Box[] | null = null;
  let looseCells: Box[] | null = null;
  const flushCells = (): void => {
    if (!looseCells) return;
    (looseRows ??= []).push(
      anonymousOf(table, 'table-row', looseCells, anonymous),
    );
    looseCells = null;
  };
  for (const child of table.children) {
    const display = child.style.display;
    // an image told to be a column is an inline image, as one told to be a
    // cell is (`flowOf`): taken for a column, it was never drawn
    if (
      (display === 'table-column' || display === 'table-column-group') &&
      child.kind !== 'replaced'
    ) {
      // A column is the table's, beside its rows: it lays out nothing and
      // paints nothing (17.2.1). Taken for a stray child, it was wrapped in
      // a row of its own and drawn as a cell.
      columns.push(child);
    } else if (child.kind === 'table-row-group') {
      flushCells();
      if (looseRows) {
        groups.push(
          anonymousOf(table, 'table-row-group', looseRows, anonymous),
        );
        looseRows = null;
      }
      groups.push(child);
    } else if (child.kind === 'table-caption') {
      captions.push(child);
    } else if (isDroppableWhitespace(child)) {
      // after a loose child it goes with the loose children, and the cells
      // they are wrapped in say whether it stays (`wrapOrphans`)
      if (looseCells) looseCells.push(child);
      continue;
    } else if (child.kind === 'table-row') {
      flushCells();
      (looseRows ??= []).push(child);
    } else {
      // Anything else that ended up here is a cell, or goes in one, and a
      // run of them shares an anonymous row — which is how a browser
      // rescues `<table>text</table>`, and how three cells in a table
      // with no row are one row of three rather than three rows of one.
      (looseCells ??= []).push(child);
    }
  }
  flushCells();
  if (looseRows) {
    groups.push(anonymousOf(table, 'table-row-group', looseRows, anonymous));
  }
  for (const group of groups) {
    wrapOrphans(group, 'table-row', (k) => k === 'table-row', anonymous);
    for (const row of group.children) {
      wrapOrphans(row, 'table-cell', (k) => k === 'table-cell', anonymous);
    }
  }
  table.children = [...captions, ...columns, ...groups];
  for (const child of table.children) child.parent = table;
}
